import { z } from "zod";

const textList = (maximum: number, itemMaximum = 80) =>
    z.array(z.string().trim().min(1).max(itemMaximum)).max(maximum);

export const guidancePreferencesSchema = z
    .object({
        objective: z.enum(["maintain", "gain", "lose", "track_only"]),
        suggestions_enabled: z.boolean(),
        allergies: textList(30),
        excluded_ingredients: textList(50),
        disliked_ingredients: textList(50),
        liked_ingredients: textList(50),
        cuisines: textList(30),
        flavors: textList(30),
        equipment: textList(40),
        preferred_methods: textList(30),
        avoided_methods: textList(30),
        difficulty: z.enum(["easy", "moderate", "advanced", "any"]),
        max_prep_minutes: z.number().int().min(1).max(1440).nullable(),
        max_total_minutes: z.number().int().min(1).max(1440).nullable(),
        servings: z.number().min(0.25).max(50),
        allow_repeats: z.boolean(),
        repeat_window_days: z.number().int().min(0).max(365),
    })
    .strict();

export type GuidancePreferences = z.infer<typeof guidancePreferencesSchema>;

export const planningPreferenceOverridesSchema = z
    .object({
        allergies: textList(30),
        excluded_ingredients: textList(50),
        disliked_ingredients: textList(50),
        liked_ingredients: textList(50),
        cuisines: textList(30),
        flavors: textList(30),
        equipment: textList(40),
        preferred_methods: textList(30),
        avoided_methods: textList(30),
        difficulty: z.enum(["easy", "moderate", "advanced", "any"]),
        max_prep_minutes: z.number().int().min(1).max(1440).nullable(),
        max_total_minutes: z.number().int().min(1).max(1440).nullable(),
        servings: z.number().min(0.25).max(50),
        allow_repeats: z.boolean(),
        repeat_window_days: z.number().int().min(0).max(365),
    })
    .partial()
    .strict();

export const generatedRecipeSchema = z
    .object({
        name: z.string().trim().min(1).max(160),
        description: z.string().trim().max(600).optional(),
        ingredients: z
            .array(
                z
                    .object({
                        name: z.string().trim().min(1).max(200),
                        quantity: z.number().positive().max(100_000).nullable(),
                        unit: z.string().trim().max(60).nullable(),
                        preparation: z.string().trim().max(160).optional(),
                        optional: z.boolean().default(false),
                    })
                    .strict(),
            )
            .min(1)
            .max(80),
        instructions: z
            .array(z.string().trim().min(1).max(1_000))
            .min(1)
            .max(80),
        servings: z.number().positive().max(50),
        preparation_minutes: z.number().int().min(0).max(1440).nullable(),
        cooking_minutes: z.number().int().min(0).max(1440).nullable(),
        difficulty: z.enum(["easy", "moderate", "advanced"]),
        required_equipment: textList(20, 100),
        cuisine_tags: textList(12, 80),
        primary_protein: z.string().trim().max(80).nullable(),
        cooking_methods: textList(12, 80),
    })
    .strict();

export type GeneratedRecipeProposal = z.infer<typeof generatedRecipeSchema>;

export const planItemSchema = z
    .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
        servings: z.number().positive().max(50),
        recipe_id: z.string().uuid().optional(),
        recipe_revision_id: z.string().uuid().optional(),
        generated_recipe: generatedRecipeSchema.optional(),
        note: z.string().trim().max(500).optional(),
    })
    .strict()
    .refine(
        (item) =>
            (Boolean(item.recipe_id) &&
                Boolean(item.recipe_revision_id) &&
                !item.generated_recipe) ||
            (!item.recipe_id &&
                !item.recipe_revision_id &&
                Boolean(item.generated_recipe)),
        "Choose one saved recipe revision or one generated recipe proposal",
    );

export type PlanItemInput = z.infer<typeof planItemSchema>;

export const createPlanDraftSchema = z
    .object({
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        timezone: z.string().min(1).max(100),
        scope: z.enum(["personal", "household"]).default("personal"),
        household_id: z.string().uuid().optional(),
        mode: z.enum(["saved_only", "generated_only", "mixed"]),
        preferences_override: planningPreferenceOverridesSchema.optional(),
        allow_repeats: z.boolean().optional(),
        replace_existing: z.boolean().default(false),
        idempotency_key: z.string().min(8).max(120),
        items: z.array(planItemSchema).min(1).max(35),
    })
    .strict()
    .refine(
        (draft) =>
            (draft.scope === "personal" && !draft.household_id) ||
            (draft.scope === "household" && Boolean(draft.household_id)),
        "Household scope requires a household ID",
    );

export type CreatePlanDraftInput = z.infer<typeof createPlanDraftSchema>;

export const goalTargetsSchema = z
    .object({
        daily_calories: z.number().min(0).max(999_999).nullable(),
        daily_protein_g: z.number().min(0).max(999_999).nullable(),
        daily_carbs_g: z.number().min(0).max(999_999).nullable(),
        daily_fat_g: z.number().min(0).max(999_999).nullable(),
        daily_fiber_g: z.number().min(0).max(999_999).nullable(),
        daily_sugar_g: z.number().min(0).max(999_999).nullable(),
        daily_alcohol_g: z.number().min(0).max(999_999).nullable(),
        daily_water_ml: z.number().min(0).max(999_999).nullable(),
        target_weight_g: z.number().positive().max(999_999).nullable(),
    })
    .strict();

export type GoalTargets = z.infer<typeof goalTargetsSchema>;
