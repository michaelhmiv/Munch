import { z } from "zod";
import type {
    NutrientFacts,
    RecipeIngredientInput,
} from "../planning/repository.js";

export const recipeImportWarningSchema = z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    severity: z.enum(["warning", "error"]),
    field: z.string().optional(),
});

const nutrientOutputSchema = z.object({
    calories: z.number().nonnegative().optional(),
    protein_g: z.number().nonnegative().optional(),
    carbs_g: z.number().nonnegative().optional(),
    fat_g: z.number().nonnegative().optional(),
    fiber_g: z.number().nonnegative().optional(),
    sugar_g: z.number().nonnegative().optional(),
    sodium_mg: z.number().nonnegative().optional(),
});

const candidateOutputSchema = z.object({
    candidate_id: z.string().min(1),
    name: z.string(),
    brand: z.string().nullable(),
    provider: z.enum(["usda", "open_food_facts"]),
    provider_label: z.string(),
    confidence: z.number().min(0).max(1),
    default_portion: z
        .object({
            id: z.string(),
            label: z.string(),
            calories: z.number().nullable(),
            protein_g: z.number().nullable(),
            carbs_g: z.number().nullable(),
            fat_g: z.number().nullable(),
        })
        .nullable(),
});

const importedIngredientSchema = z.object({
    name: z.string().min(1).max(300),
    quantity: z.number().positive().optional(),
    unit: z.string().max(80).optional(),
    preparation: z.string().max(200).optional(),
    optional: z.boolean().optional(),
    gram_weight: z.number().positive().optional(),
    nutrients: nutrientOutputSchema.optional(),
    provider: z.string().max(80).optional(),
    provider_food_id: z.string().max(300).optional(),
    source_type: z.enum([
        "usda",
        "open_food_facts",
        "published_restaurant",
        "saved_food",
        "past_meal",
        "user_supplied",
        "model_estimate",
    ]),
    source_url: z.string().url().optional(),
    confidence: z.number().min(0).max(1).optional(),
    source_snapshot: z.record(z.string(), z.unknown()),
});

export const recipeImportDraftOutputSchema = z.object({
    schema_version: z.literal(1),
    status: z.enum(["ready", "partial"]),
    requires_review: z.boolean(),
    parser: z.object({
        strategy: z.enum(["schema_org_json_ld", "microdata"]),
        version: z.string(),
    }),
    source: z.object({
        submitted_url: z.string().url(),
        final_url: z.string().url(),
        canonical_url: z.string().url().nullable(),
        title: z.string().nullable(),
        site_name: z.string().nullable(),
        author: z.string().nullable(),
    }),
    recipe: z.object({
        name: z.string().min(1).max(200),
        servings: z.number().positive(),
        description: z.string().max(2000).optional(),
        instructions: z.array(z.string().min(1).max(2000)).max(100),
        preparation_minutes: z.number().int().nonnegative().optional(),
        cooking_minutes: z.number().int().nonnegative().optional(),
        source_type: z.literal("imported"),
        source_title: z.string().max(500).optional(),
        source_url: z.string().url(),
        ingredients: z.array(importedIngredientSchema).min(1).max(200),
    }),
    nutrition: z.object({
        status: z.enum(["complete", "partial", "unavailable"]),
        total: nutrientOutputSchema,
        per_serving: nutrientOutputSchema,
    }),
    ingredient_review: z.array(
        z.object({
            position: z.number().int().nonnegative(),
            raw_text: z.string().min(1).max(1000),
            resolution: z.enum(["matched", "ambiguous", "unresolved"]),
            candidates: z.array(candidateOutputSchema),
        }),
    ),
    warnings: z.array(recipeImportWarningSchema),
});

export type RecipeImportWarning = z.infer<typeof recipeImportWarningSchema>;
export type RecipeImportDraft = z.infer<typeof recipeImportDraftOutputSchema>;
export type RecipeImportResolution =
    RecipeImportDraft["ingredient_review"][number]["resolution"];
export type ImportedRecipeIngredient =
    RecipeImportDraft["recipe"]["ingredients"][number];
export type RecipeIngredientSourceType = RecipeIngredientInput["sourceType"];
export type RecipeNutritionFacts = NutrientFacts;

export interface FetchedRecipePage {
    submittedUrl: string;
    finalUrl: string;
    html: string;
}

export interface ParsedRecipeIngredient {
    rawText: string;
    name: string;
    quantity?: number;
    unit?: string;
    preparation?: string;
    optional?: boolean;
}

export interface ParsedRecipe {
    strategy: "schema_org_json_ld" | "microdata";
    name: string;
    description?: string;
    servings: number;
    instructions: string[];
    preparationMinutes?: number;
    cookingMinutes?: number;
    sourceTitle?: string;
    siteName?: string;
    author?: string;
    canonicalUrl?: string;
    ingredients: ParsedRecipeIngredient[];
    warnings: RecipeImportWarning[];
}
