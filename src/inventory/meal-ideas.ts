import { z } from "zod";
import { normalizeInventoryName } from "./matching.js";
import {
    getPantryPlanningContext,
    rankSavedRecipesForPantry,
    type PantryMealGoal,
    type PantryPlanningContext,
    type PantryRecipeCandidate,
} from "./meal-planning.js";
import { pantryPlanningEnabled } from "./planning-profile.js";
import type { InventoryScope } from "./repository.js";

const mealIdeaSchema = z
    .object({
        name: z.string().min(1).max(160),
        description: z.string().min(1).max(600),
        source: z.enum(["saved_recipe", "generated"]),
        saved_recipe_id: z.string().uuid().nullable(),
        readiness: z.enum(["ready_now", "likely_ready", "almost_there"]),
        estimated_nutrition: z
            .object({
                calories: z.number().nonnegative().nullable(),
                protein_g: z.number().nonnegative().nullable(),
                carbs_g: z.number().nonnegative().nullable(),
                fat_g: z.number().nonnegative().nullable(),
                fiber_g: z.number().nonnegative().nullable(),
            })
            .strict(),
        total_minutes: z.number().int().positive().max(1440).nullable(),
        on_hand_ingredients: z.array(z.string().min(1).max(160)).max(40),
        assumed_staples: z.array(z.string().min(1).max(100)).max(20),
        missing_required: z.array(z.string().min(1).max(160)).max(12),
        missing_optional: z.array(z.string().min(1).max(160)).max(20),
        flavor_system: z.array(z.string().min(1).max(160)).max(16),
        why_it_fits: z.array(z.string().min(1).max(240)).min(1).max(5),
        confidence: z.number().min(0).max(1),
    })
    .strict();

const responseSchema = z
    .object({
        candidates: z.array(mealIdeaSchema).min(1).max(5),
        planning_notes: z.array(z.string().min(1).max(300)).max(6),
    })
    .strict();

export const pantryMealIdeasResponseJsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["candidates", "planning_notes"],
    properties: {
        candidates: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: {
                type: "object",
                additionalProperties: false,
                required: [
                    "name",
                    "description",
                    "source",
                    "saved_recipe_id",
                    "readiness",
                    "estimated_nutrition",
                    "total_minutes",
                    "on_hand_ingredients",
                    "assumed_staples",
                    "missing_required",
                    "missing_optional",
                    "flavor_system",
                    "why_it_fits",
                    "confidence",
                ],
                properties: {
                    name: { type: "string", minLength: 1, maxLength: 160 },
                    description: {
                        type: "string",
                        minLength: 1,
                        maxLength: 600,
                    },
                    source: {
                        type: "string",
                        enum: ["saved_recipe", "generated"],
                    },
                    saved_recipe_id: {
                        anyOf: [
                            { type: "string", format: "uuid" },
                            { type: "null" },
                        ],
                    },
                    readiness: {
                        type: "string",
                        enum: ["ready_now", "likely_ready", "almost_there"],
                    },
                    estimated_nutrition: {
                        type: "object",
                        additionalProperties: false,
                        required: [
                            "calories",
                            "protein_g",
                            "carbs_g",
                            "fat_g",
                            "fiber_g",
                        ],
                        properties: {
                            calories: {
                                anyOf: [
                                    { type: "number", minimum: 0 },
                                    { type: "null" },
                                ],
                            },
                            protein_g: {
                                anyOf: [
                                    { type: "number", minimum: 0 },
                                    { type: "null" },
                                ],
                            },
                            carbs_g: {
                                anyOf: [
                                    { type: "number", minimum: 0 },
                                    { type: "null" },
                                ],
                            },
                            fat_g: {
                                anyOf: [
                                    { type: "number", minimum: 0 },
                                    { type: "null" },
                                ],
                            },
                            fiber_g: {
                                anyOf: [
                                    { type: "number", minimum: 0 },
                                    { type: "null" },
                                ],
                            },
                        },
                    },
                    total_minutes: {
                        anyOf: [
                            { type: "integer", minimum: 1, maximum: 1440 },
                            { type: "null" },
                        ],
                    },
                    on_hand_ingredients: {
                        type: "array",
                        maxItems: 40,
                        items: { type: "string", minLength: 1, maxLength: 160 },
                    },
                    assumed_staples: {
                        type: "array",
                        maxItems: 20,
                        items: { type: "string", minLength: 1, maxLength: 100 },
                    },
                    missing_required: {
                        type: "array",
                        maxItems: 12,
                        items: { type: "string", minLength: 1, maxLength: 160 },
                    },
                    missing_optional: {
                        type: "array",
                        maxItems: 20,
                        items: { type: "string", minLength: 1, maxLength: 160 },
                    },
                    flavor_system: {
                        type: "array",
                        maxItems: 16,
                        items: { type: "string", minLength: 1, maxLength: 160 },
                    },
                    why_it_fits: {
                        type: "array",
                        minItems: 1,
                        maxItems: 5,
                        items: { type: "string", minLength: 1, maxLength: 240 },
                    },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                },
            },
        },
        planning_notes: {
            type: "array",
            maxItems: 6,
            items: { type: "string", minLength: 1, maxLength: 300 },
        },
    },
} as const;

export type PantryMealIdea = z.infer<typeof mealIdeaSchema>;
export type PantryMealIdeasResponse = z.infer<typeof responseSchema>;

export interface PantryMealIdeaRequest {
    userId: string;
    scope: InventoryScope;
    goal: PantryMealGoal;
    mealType?: "breakfast" | "lunch" | "dinner" | "snack";
    servings?: number;
    maxMinutes?: number;
    allowMissingItems?: number;
    assumedStaples?: string[];
}

interface PlanningModelConfig {
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
    appUrl?: string;
}

export interface PantryMealIdeaDependencies {
    fetcher?: (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => Promise<Response>;
}

function boundedInteger(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
) {
    const parsed = Number(value);
    return Number.isInteger(parsed)
        ? Math.min(max, Math.max(min, parsed))
        : fallback;
}

export function pantryPlanningModelConfig(
    env: Record<string, string | undefined> = process.env,
): PlanningModelConfig | null {
    if (!pantryPlanningEnabled(env)) return null;
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) return null;
    return {
        apiKey,
        model:
            env.MUNCH_PANTRY_PLANNING_MODEL?.trim() ||
            env.MUNCH_RECIPE_IMPORT_AI_MODEL?.trim() ||
            "openai/gpt-5.6-luna",
        baseUrl: (
            env.MUNCH_PANTRY_PLANNING_BASE_URL?.trim() ||
            "https://openrouter.ai/api/v1"
        ).replace(/\/+$/, ""),
        timeoutMs: boundedInteger(
            env.MUNCH_PANTRY_PLANNING_TIMEOUT_MS,
            45_000,
            5_000,
            90_000,
        ),
        appUrl: env.MUNCH_APP_BASE_URL?.trim(),
    };
}

function compactPantry(context: PantryPlanningContext) {
    return context.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        quantity_mode: item.quantity_mode,
        stock_state: item.stock_state,
        location: item.location,
        category: item.planning_profile.category,
        culinary_roles: item.planning_profile.culinary_roles,
        nutrition_basis: {
            quantity: item.planning_profile.basis_quantity,
            unit: item.planning_profile.basis_unit,
            grams: item.planning_profile.basis_grams,
            ...item.planning_profile.nutrients,
            status: item.planning_profile.profile_status,
        },
    }));
}

function compactSavedRecipes(recipes: PantryRecipeCandidate[]) {
    return recipes.map((recipe) => ({
        recipe_id: recipe.recipe_id,
        name: recipe.name,
        nutrition_per_serving: recipe.nutrition_per_serving,
        total_minutes: recipe.total_minutes,
        readiness: recipe.availability.readiness,
        matched_ingredients: recipe.availability.matched.map(
            (match) => match.ingredient,
        ),
        missing_required: recipe.availability.missing_required,
        missing_optional: recipe.availability.missing_optional,
        shortages: recipe.availability.shortages,
        flavor_support: recipe.flavor_support,
        score: recipe.score,
        score_reasons: recipe.score_reasons,
    }));
}

export async function buildMealIdeaContext(input: PantryMealIdeaRequest) {
    const assumedStaples = [...new Set(input.assumedStaples ?? [])]
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 20);
    const pantry = await getPantryPlanningContext({
        userId: input.userId,
        scope: input.scope,
        limit: 200,
        enrichLimit: 32,
    });
    const savedRecipes = await rankSavedRecipesForPantry({
        userId: input.userId,
        scope: input.scope,
        goal: input.goal,
        assumedStaples,
        maxMinutes: input.maxMinutes,
        limit: 8,
        context: pantry,
    });
    return {
        request: {
            goal: input.goal,
            meal_type: input.mealType ?? "dinner",
            servings: Math.max(1, Math.min(20, input.servings ?? 2)),
            max_minutes:
                input.maxMinutes == null
                    ? null
                    : Math.max(1, Math.min(1440, input.maxMinutes)),
            allow_missing_items: Math.max(
                0,
                Math.min(5, input.allowMissingItems ?? 1),
            ),
            assumed_staples: assumedStaples,
        },
        pantry: compactPantry(pantry),
        pantry_enrichment: pantry.enrichment,
        saved_recipe_candidates: compactSavedRecipes(savedRecipes),
    };
}

function responseText(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return undefined;
    return value
        .map((part) =>
            part &&
            typeof part === "object" &&
            typeof (part as any).text === "string"
                ? (part as any).text
                : typeof part === "string"
                  ? part
                  : "",
        )
        .join("")
        .trim();
}

function isGroundedIngredient(name: string, pantryNames: string[]): boolean {
    const wanted = normalizeInventoryName(name);
    if (!wanted) return false;
    return pantryNames.some((actual) => {
        if (!actual) return false;
        if (
            actual === wanted ||
            actual.includes(wanted) ||
            wanted.includes(actual)
        ) {
            return true;
        }
        const a = new Set(actual.split(" "));
        const b = wanted.split(" ");
        const overlap = b.filter((token) => a.has(token)).length;
        return b.length > 0 && overlap / b.length >= 0.75;
    });
}

export function validateMealIdeaGrounding(
    response: PantryMealIdeasResponse,
    context: Awaited<ReturnType<typeof buildMealIdeaContext>>,
): PantryMealIdeasResponse {
    const pantryNames = context.pantry.map((item) =>
        normalizeInventoryName(item.name),
    );
    const assumed = new Set(
        context.request.assumed_staples.map(normalizeInventoryName),
    );
    const savedIds = new Set(
        context.saved_recipe_candidates.map((recipe) => recipe.recipe_id),
    );
    const filtered = response.candidates.filter((candidate) => {
        if (
            candidate.on_hand_ingredients.some(
                (ingredient) => !isGroundedIngredient(ingredient, pantryNames),
            )
        ) {
            return false;
        }
        if (
            candidate.assumed_staples.some(
                (staple) => !assumed.has(normalizeInventoryName(staple)),
            )
        ) {
            return false;
        }
        if (
            candidate.source === "saved_recipe" &&
            (!candidate.saved_recipe_id ||
                !savedIds.has(candidate.saved_recipe_id))
        ) {
            return false;
        }
        if (
            candidate.source === "generated" &&
            candidate.saved_recipe_id !== null
        ) {
            return false;
        }
        if (
            candidate.missing_required.length >
            context.request.allow_missing_items
        ) {
            return false;
        }
        return true;
    });
    if (!filtered.length) {
        throw new Error(
            "Pantry planning model returned no grounded meal candidates",
        );
    }
    return { ...response, candidates: filtered };
}

function systemPrompt() {
    return `You are Munch's deliberate kitchen planning engine. Recommend actual coherent dishes, not piles of high-macro ingredients. Inspect the entire provided kitchen context: proteins, vegetables, starches, dairy, sauces, condiments, spices, herbs, acids, aromatics, cooking fats, quantities, locations, and saved recipes. A nutrition goal such as high protein is a ranking goal, not candidate-generation logic. Prefer saved recipes when they fit well, but do not force them. Treat missing core ingredients much more seriously than optional garnish. Use seasonings and flavor systems intentionally. Produce genuinely diverse candidates across protein, cuisine/flavor direction, cooking method, or meal format when the Pantry supports diversity. Never claim an ingredient is on hand unless it appears in pantry. Never claim an assumed staple unless it appears in assumed_staples. Put unavailable ingredients only in missing_required or missing_optional. Do not fabricate precise nutrition when the context is uncertain; use null or reasonable rounded estimates. Return JSON only.`;
}

export async function generatePantryMealIdeas(
    input: PantryMealIdeaRequest,
    config = pantryPlanningModelConfig(),
    dependencies: PantryMealIdeaDependencies = {},
): Promise<{
    context: Awaited<ReturnType<typeof buildMealIdeaContext>>;
    result: PantryMealIdeasResponse;
}> {
    if (!config) throw new Error("Pantry planning is not configured");
    const context = await buildMealIdeaContext(input);
    if (!context.pantry.length) {
        throw new Error("Pantry has no available foods to plan with");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const fetcher = dependencies.fetcher ?? fetch;
    try {
        const response = await fetcher(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${config.apiKey}`,
                "content-type": "application/json",
                ...(config.appUrl ? { "http-referer": config.appUrl } : {}),
                "x-title": "Munch Pantry Planning",
            },
            body: JSON.stringify({
                model: config.model,
                temperature: 0.25,
                max_tokens: 5500,
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "munch_pantry_meal_ideas",
                        strict: true,
                        schema: pantryMealIdeasResponseJsonSchema,
                    },
                },
                provider: {
                    data_collection: "deny",
                    require_parameters: true,
                },
                messages: [
                    { role: "system", content: systemPrompt() },
                    {
                        role: "user",
                        content: `Plan ${context.request.meal_type} deliberately from this JSON context. Follow the supplied response JSON Schema exactly. Use only source=saved_recipe or generated and readiness=ready_now, likely_ready, or almost_there. estimated_nutrition must contain the five scalar nullable fields in the schema; flavor_system and why_it_fits are arrays.\n\n${JSON.stringify(context)}`,
                    },
                ],
            }),
        });
        if (!response.ok) {
            throw new Error(
                `Pantry planning provider returned HTTP ${response.status}`,
            );
        }
        const payload = (await response.json()) as any;
        const text = responseText(payload?.choices?.[0]?.message?.content);
        if (!text)
            throw new Error("Pantry planning returned no structured content");
        let decoded: unknown;
        try {
            decoded = JSON.parse(text);
        } catch {
            throw new Error("Pantry planning returned invalid JSON");
        }
        const parsed = responseSchema.parse(decoded);
        return {
            context,
            result: validateMealIdeaGrounding(parsed, context),
        };
    } finally {
        clearTimeout(timeout);
    }
}
