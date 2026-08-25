from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected marker missing in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, count))

schema = r'''export const pantryMealIdeasResponseJsonSchema = {
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
                    description: { type: "string", minLength: 1, maxLength: 600 },
                    source: { type: "string", enum: ["saved_recipe", "generated"] },
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
                            calories: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] },
                            protein_g: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] },
                            carbs_g: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] },
                            fat_g: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] },
                            fiber_g: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] },
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

'''

replace(
    "src/inventory/meal-ideas.ts",
    "export type PantryMealIdea = z.infer<typeof mealIdeaSchema>;",
    schema + "export type PantryMealIdea = z.infer<typeof mealIdeaSchema>;",
)
replace(
    "src/inventory/meal-ideas.ts",
    '''                response_format: { type: "json_object" },
                provider: { data_collection: "deny" },''',
    '''                response_format: {
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
                },''',
)
replace(
    "src/inventory/meal-ideas.ts",
    '''content: `Plan ${context.request.meal_type} deliberately from this JSON context. Return an object with keys candidates and planning_notes. Each candidate must have name, description, source, saved_recipe_id, readiness, estimated_nutrition, total_minutes, on_hand_ingredients, assumed_staples, missing_required, missing_optional, flavor_system, why_it_fits, confidence.\\n\\n${JSON.stringify(context)}`''',
    '''content: `Plan ${context.request.meal_type} deliberately from this JSON context. Follow the supplied response JSON Schema exactly. Use only source=saved_recipe or generated and readiness=ready_now, likely_ready, or almost_there. estimated_nutrition must contain the five scalar nullable fields in the schema; flavor_system and why_it_fits are arrays.\\n\\n${JSON.stringify(context)}`''',
)
replace(
    "src/inventory/meal-ideas.test.ts",
    '''    pantryPlanningModelConfig,
    validateMealIdeaGrounding,''',
    '''    pantryMealIdeasResponseJsonSchema,
    pantryPlanningModelConfig,
    validateMealIdeaGrounding,''',
)
replace(
    "src/inventory/meal-ideas.test.ts",
    '''test("website planning requires both the feature flag and OpenRouter key", () => {''',
    '''test("Pantry planning exposes a strict provider JSON schema", () => {
    expect(pantryMealIdeasResponseJsonSchema.additionalProperties).toBe(false);
    expect(
        pantryMealIdeasResponseJsonSchema.properties.candidates.items.properties
            .source.enum,
    ).toEqual(["saved_recipe", "generated"]);
    expect(
        pantryMealIdeasResponseJsonSchema.properties.candidates.items.properties
            .readiness.enum,
    ).toEqual(["ready_now", "likely_ready", "almost_there"]);
});

test("website planning requires both the feature flag and OpenRouter key", () => {''',
)

print("Pantry strict structured-output fix applied.")
