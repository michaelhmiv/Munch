import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withAnalytics } from "./analytics.js";
import type { MunchCapabilities } from "./billing/capabilities.js";
import { requireRecipeScope } from "./mcp-capability-guard.js";
import {
    saveRecipe,
    type NutrientFacts,
    type PlanningScope,
    type RecipeIngredientInput,
    type RecipeInput,
    type SavedRecipeResult,
} from "./planning/repository.js";
import { getStructuredMeal } from "./structured-meals/repository.js";
import type {
    StructuredMealItemRecord,
    StructuredMealRecord,
} from "./structured-meals/types.js";

const nutrientSchema = z.object({
    calories: z.number().nonnegative().optional(),
    protein_g: z.number().nonnegative().optional(),
    carbs_g: z.number().nonnegative().optional(),
    fat_g: z.number().nonnegative().optional(),
    fiber_g: z.number().nonnegative().optional(),
    sugar_g: z.number().nonnegative().optional(),
    sodium_mg: z.number().nonnegative().optional(),
});

const saveMealAsRecipeOutputSchema = {
    recipe: z.object({
        recipeId: z.string().uuid(),
        revisionId: z.string().uuid(),
        revisionNumber: z.number().int().positive(),
        nutritionStatus: z.enum(["complete", "partial", "unavailable"]),
        totals: nutrientSchema,
        perServing: nutrientSchema,
        deduplicated: z.boolean(),
        sourceMealId: z.string().uuid(),
        name: z.string(),
        servings: z.number().positive(),
    }),
};

const recipeNutrientKeys = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "sodium_mg",
] as const satisfies readonly (keyof NutrientFacts)[];

export interface MealRecipeOverrides {
    name?: string;
    servings?: number;
    description?: string;
    instructions?: string[];
}

export interface SavedMealRecipeResult extends SavedRecipeResult {
    sourceMealId: string;
    name: string;
    servings: number;
}

export interface MealToRecipeDependencies {
    getMeal: typeof getStructuredMeal;
    saveRecipe: typeof saveRecipe;
}

const defaultDependencies: MealToRecipeDependencies = {
    getMeal: getStructuredMeal,
    saveRecipe,
};

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
    );
}

function recipeNutrients(item: StructuredMealItemRecord): NutrientFacts {
    const nutrients: NutrientFacts = {};
    for (const key of recipeNutrientKeys) {
        const value = item.nutrients[key];
        if (value !== undefined) nutrients[key] = value;
    }
    return nutrients;
}

function recipeSourceType(
    item: StructuredMealItemRecord,
): RecipeIngredientInput["sourceType"] {
    if (item.sourceType === "legacy_aggregate") {
        throw new Error(
            "This legacy meal does not have recipe-safe item provenance. Recreate or resolve the meal as structured items before saving it as a recipe.",
        );
    }
    return item.sourceType;
}

function lineageSnapshot(
    meal: StructuredMealRecord,
    item: StructuredMealItemRecord,
): Record<string, unknown> {
    const priorMunch =
        item.sourceSnapshot._munch &&
        typeof item.sourceSnapshot._munch === "object" &&
        !Array.isArray(item.sourceSnapshot._munch)
            ? (item.sourceSnapshot._munch as Record<string, unknown>)
            : {};
    return {
        ...item.sourceSnapshot,
        _munch: {
            ...priorMunch,
            source_meal_id: meal.id,
            source_meal_item_id: item.id,
            source_meal_position: item.position,
            source_meal_provider_revision: item.providerRevision,
            source_meal_source_updated_at: item.sourceUpdatedAt,
            source_meal_assumptions: item.assumptions,
            source_meal_nutrients: item.nutrients,
        },
    };
}

export function buildMealDerivedRecipe(
    meal: StructuredMealRecord,
    overrides: MealRecipeOverrides = {},
): RecipeInput {
    if (meal.items.length === 0) {
        throw new Error(
            "This meal has no structured items and cannot be converted to a recipe without reconstructing ingredients.",
        );
    }
    const name = overrides.name?.trim() || meal.description.trim();
    if (!name) throw new Error("A recipe name could not be derived from the meal");
    const servings = overrides.servings ?? 1;
    if (!Number.isFinite(servings) || servings <= 0) {
        throw new Error("Recipe servings must be positive");
    }
    const instructions = (overrides.instructions ?? []).map((step) =>
        step.trim(),
    );
    if (instructions.some((step) => !step)) {
        throw new Error("Recipe instructions cannot contain blank steps");
    }

    return {
        name,
        servings,
        description: overrides.description?.trim() || meal.description.trim(),
        instructions,
        sourceType: "user_entered",
        ingredients: meal.items.map((item) => ({
            name: item.name,
            quantity: item.quantity ?? undefined,
            unit: item.portionLabel ?? undefined,
            gramWeight: item.gramWeight ?? undefined,
            nutrients: recipeNutrients(item),
            provider: item.provider ?? undefined,
            providerFoodId: item.providerFoodId ?? undefined,
            sourceType: recipeSourceType(item),
            sourceUrl: item.sourceUrl ?? undefined,
            confidence: item.confidence ?? undefined,
            sourceSnapshot: lineageSnapshot(meal, item),
        })),
    };
}

export function mealRecipeIdempotencyKey(
    mealId: string,
    scope: PlanningScope,
): string {
    const owner =
        scope.type === "personal" ? "personal" : `household:${scope.householdId}`;
    return `meal-to-recipe:${mealId}:${owner}`;
}

export async function saveMealAsRecipe(
    input: {
        userId: string;
        mealId: string;
        scope: PlanningScope;
        overrides?: MealRecipeOverrides;
    },
    dependencies: MealToRecipeDependencies = defaultDependencies,
): Promise<SavedMealRecipeResult> {
    if (!isUuid(input.mealId)) throw new Error("Invalid meal ID");
    const meal = await dependencies.getMeal(input.userId, input.mealId);
    if (!meal) throw new Error("Meal not found");
    const recipe = buildMealDerivedRecipe(meal, input.overrides);
    const saved = await dependencies.saveRecipe({
        userId: input.userId,
        scope: input.scope,
        recipe,
        idempotencyKey: mealRecipeIdempotencyKey(input.mealId, input.scope),
    });
    return {
        ...saved,
        sourceMealId: meal.id,
        name: recipe.name,
        servings: recipe.servings,
    };
}

export function registerMealToRecipeTool(
    server: McpServer,
    userId: string,
    capabilities: MunchCapabilities,
): void {
    const toolServer = server as unknown as {
        registerTool: (
            name: string,
            config: unknown,
            handler: (...args: any[]) => unknown,
        ) => unknown;
    };

    toolServer.registerTool(
        "save_meal_as_recipe",
        {
            title: "Save Meal as Recipe",
            description:
                "Convert an existing structured Munch meal into a saved recipe without reconstructing or re-searching its ingredients. Use this for requests like 'save that as a recipe' or 'make that meal a recipe'; pass the stable meal_id from the just-logged meal when available, and do not search meal history or saved foods first. The server preserves quantities, supported nutrition, provenance, confidence, assumptions, and source-meal lineage. Servings default to 1 and instructions default to empty unless the user already established otherwise.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                meal_id: z
                    .string()
                    .uuid()
                    .describe(
                        "Stable ID of the existing logged meal. Prefer the ID returned by the immediately preceding Munch meal-log result.",
                    ),
                scope: z
                    .enum(["personal", "household"])
                    .optional()
                    .describe("Recipe ownership scope. Defaults to personal."),
                name: z
                    .string()
                    .min(1)
                    .max(200)
                    .optional()
                    .describe(
                        "Optional recipe name. When omitted, reuse the logged meal description.",
                    ),
                servings: z
                    .number()
                    .positive()
                    .optional()
                    .describe(
                        "Recipe servings. Defaults to 1 for one logged meal unless the user established a different yield.",
                    ),
                description: z.string().max(2000).optional(),
                instructions: z
                    .array(z.string().min(1).max(2000))
                    .max(100)
                    .optional()
                    .describe(
                        "Only cooking steps already established by the user or source meal context. Omit rather than inventing instructions.",
                    ),
            },
            outputSchema: saveMealAsRecipeOutputSchema,
        },
        async ({
            meal_id,
            scope,
            name,
            servings,
            description,
            instructions,
        }) =>
            withAnalytics(
                "save_meal_as_recipe",
                async () => {
                    const resolvedScope = requireRecipeScope(
                        scope ?? "personal",
                        capabilities,
                        true,
                    );
                    const recipe = await saveMealAsRecipe({
                        userId,
                        mealId: meal_id,
                        scope: resolvedScope,
                        overrides: {
                            name,
                            servings,
                            description,
                            instructions,
                        },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: recipe.deduplicated
                                    ? `That meal was already saved as “${recipe.name}” — ${recipe.servings} serving${recipe.servings === 1 ? "" : "s"}.`
                                    : `Saved as “${recipe.name}” — ${recipe.servings} serving${recipe.servings === 1 ? "" : "s"}.`,
                            },
                        ],
                        structuredContent: { recipe },
                    };
                },
                { userId },
            ),
    );
}
