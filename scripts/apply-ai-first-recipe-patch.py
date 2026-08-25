#!/usr/bin/env python3
from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    result, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected one regex match, found {count}")
    return result


service_path = Path("src/recipe-import/service.ts")
service = service_path.read_text()
service = regex_once(
    service,
    r'''function lowImpactDefaults\(ingredient: ParsedRecipeIngredient\): \{[\s\S]*?\nfunction modelEstimatedIngredient\(''',
    '''function lowImpactIngredient(
    ingredient: ParsedRecipeIngredient,
    sourceUrl: string,
    strategy: string,
    semanticLabel?: string,
): EnrichedIngredient {
    const hasMeasuredQuantity = ingredient.quantity !== undefined;
    const assumption = ingredientAssumption(ingredient) ?? {
        position: ingredient.sourcePosition ?? 0,
        raw_text: ingredient.rawText,
        message: hasMeasuredQuantity
            ? "Nutrition providers could not resolve this low-impact source ingredient; retained the source quantity without inventing nutrition."
            : "The source did not specify a measurable amount; retained the low-impact ingredient without inventing a quantity or nutrition contribution.",
        impact: "low" as const,
        source: semanticLabel ? ("website_ai" as const) : ("parser" as const),
    };
    return {
        ingredient: {
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            preparation: ingredient.preparation,
            optional: ingredient.optional,
            source_type: "user_supplied",
            source_url: sourceUrl,
            confidence: ingredient.semanticConfidence,
            source_snapshot: {
                resolution_layer: "recipe_url",
                resolution: "assumed",
                parser_strategy: strategy,
                ...(semanticLabel
                    ? { semantic_resolution_layer: semanticLabel }
                    : {}),
                semantic_confidence: ingredient.semanticConfidence ?? null,
                raw_ingredient: ingredient.rawText,
                normalized_ingredient: ingredient.name,
                imported_source_url: sourceUrl,
                assumption: assumption.message,
                impact: "low",
                nutrition_treatment: hasMeasuredQuantity
                    ? "provider_unavailable_source_quantity"
                    : "unmeasured_source_quantity",
            },
        },
        review: {
            position: 0,
            raw_text: ingredient.rawText,
            resolution: "assumed",
            candidates: [],
        },
        assumption,
    };
}

function modelEstimatedIngredient(''',
    "replace low-impact quantity fabrication",
)
service = regex_once(
    service,
    r'''function isLowImpactUnmeasurable\(ingredient: ParsedRecipeIngredient\): boolean \{\n    return \(\n        isLowImpactIngredient\(ingredient\) &&\n        \(ingredient\.quantity === undefined \|\|\n            \(ingredient\.searchQueries\?\.length \?\? 0\) === 0\)\n    \);\n\}''',
    '''function isLowImpactUnmeasurable(ingredient: ParsedRecipeIngredient): boolean {
    return isLowImpactIngredient(ingredient) && ingredient.quantity === undefined;
}''',
    "narrow unmeasurable low-impact definition",
)
service = replace_once(
    service,
    '''    const worker = async () => {
        while (next < ingredients.length) {
            const index = next++;
            const ingredient = ingredients[index]!;
            const result = await searchIngredientCandidates(
''',
    '''    const worker = async () => {
        while (next < ingredients.length) {
            const index = next++;
            const ingredient = ingredients[index]!;
            if (isLowImpactUnmeasurable(ingredient)) {
                searched[index] = {
                    ingredient,
                    candidates: [],
                    unavailable: false,
                };
                continue;
            }
            const result = await searchIngredientCandidates(
''',
    "skip unnecessary low-impact food search",
)
service = replace_once(
    service,
    '''): RecipeImportIngredientAssignmentRequest["reason"] | undefined {
    if (candidates.length === 0) return "no_candidate";
''',
    '''): RecipeImportIngredientAssignmentRequest["reason"] | undefined {
    if (isLowImpactUnmeasurable(ingredient)) return undefined;
    if (candidates.length === 0) return "no_candidate";
''',
    "skip low-impact assignment",
)
service_path.write_text(service)

resolver_path = Path("src/recipe-import/semantic-resolver.ts")
resolver = resolver_path.read_text()
resolver = replace_once(
    resolver,
    '''For herbs, spices, salt, pepper, and other unspecified low-impact seasonings, choose a conservative kitchen quantity and search query when possible (for example, 1/4 teaspoon salt or 1/8 teaspoon pepper) so the ingredient remains logged and receives a nutrition treatment; never omit it merely because the source says "to taste." For a major ingredient with an unknown quantity, use impact=high and explain the uncertainty.''',
    '''For herbs, spices, salt, pepper, and other unspecified low-impact seasonings, preserve the ingredient but leave quantity and unit unset when the source does not provide a measurable amount. Do not invent a quantity merely to make nutrition complete, and do not omit the ingredient because the source says "to taste" or "as needed." For a major ingredient with an unknown quantity, use impact=high and explain the uncertainty.''',
    "normalization prompt source-faithful quantity",
)
resolver = replace_once(
    resolver,
    '''If no candidate is usable, return decision=model_estimate, candidate_id=null, a normalized name, a conservative quantity/unit when the source is vague, and up to two useful search_queries for a bounded server retry. Never invent provider IDs or nutrition values. The server performs provider lookups, portion scaling, and nutrition arithmetic. Preserve salt, pepper, herbs, aromatics, and other low-impact ingredients as logged culinary items; low impact means no blocking confirmation, not omission. For "to taste" seasonings, use a conservative quantity such as 1/4 teaspoon salt or 1/8 teaspoon pepper and document that estimate only when needed.''',
    '''If no candidate is usable, return decision=model_estimate, candidate_id=null, a normalized name, and up to two useful search_queries for a bounded server retry. Preserve source-backed quantity/unit exactly when known; when the source is vague or says "to taste" or "as needed," leave quantity/unit unset rather than inventing an amount. Never invent provider IDs or nutrition values. The server performs provider lookups, portion scaling, and nutrition arithmetic. Preserve salt, pepper, herbs, aromatics, and other low-impact ingredients as logged culinary items; low impact means no blocking confirmation, not omission.''',
    "assignment prompt source-faithful quantity",
)
resolver_path.write_text(resolver)

recipe_test_path = Path("src/recipe-import.test.ts")
test = recipe_test_path.read_text()
test = replace_once(
    test,
    '''        expect(draft.recipe.ingredients[1]).toMatchObject({
            source_type: "model_estimate",
            quantity: 0.25,
            unit: "tsp",
            nutrients: {
                calories: 0,
                protein_g: 0,
                carbs_g: 0,
                fat_g: 0,
            },
        });
        expect(draft.status).toBe("partial");
        expect(draft.nutrition.status).toBe("complete");
''',
    '''        expect(draft.recipe.ingredients[1]).toMatchObject({
            source_type: "user_supplied",
        });
        expect(draft.recipe.ingredients[1]?.quantity).toBeUndefined();
        expect(draft.recipe.ingredients[1]?.unit).toBeUndefined();
        expect(draft.recipe.ingredients[1]?.nutrients).toBeUndefined();
        expect(draft.recipe.ingredients[1]?.source_snapshot).toMatchObject({
            raw_ingredient: "Salt to taste",
            nutrition_treatment: "unmeasured_source_quantity",
        });
        expect(draft.status).toBe("partial");
        expect(draft.nutrition.status).toBe("partial");
''',
    "update parser seasoning expectations",
)
test = replace_once(
    test,
    '''        expect(draft.recipe.ingredients[1]?.source_type).toBe("model_estimate");
        expect(draft.assumptions).toHaveLength(1);
''',
    '''        expect(draft.recipe.ingredients[1]?.source_type).toBe("user_supplied");
        expect(draft.recipe.ingredients[1]?.quantity).toBeUndefined();
        expect(draft.recipe.ingredients[1]?.unit).toBeUndefined();
        expect(draft.recipe.ingredients[1]?.nutrients).toBeUndefined();
        expect(draft.assumptions).toHaveLength(1);
''',
    "update semantic low-impact expectations",
)
test = replace_once(
    test,
    '''        expect(searches.some((query) => /salt|pepper/i.test(query))).toBe(true);
''',
    '''        expect(searches.some((query) => /salt|pepper/i.test(query))).toBe(false);
        expect(draft.nutrition.status).toBe("partial");
''',
    "assert no low-impact provider lookup",
)
test = replace_once(
    test,
    '''    test("batches uncertain ingredients into assignments and leaves no ordinary item unresolved", async () => {
''',
    '''    test("batches material ambiguity without inventing low-impact source quantities", async () => {
''',
    "rename assignment regression",
)
test = replace_once(
    test,
    '''                expect(requests).toHaveLength(2);
                expect(requests.map((request) => request.reason)).toEqual([
                    "ambiguous_candidate",
                    "missing_quantity",
                ]);
''',
    '''                expect(requests).toHaveLength(1);
                expect(requests.map((request) => request.reason)).toEqual([
                    "ambiguous_candidate",
                ]);
''',
    "do not assign low-impact missing quantity",
)
test = regex_once(
    test,
    r'''                    \[\n                        "1:0",\n                        \{\n                            key: "1:0",\n                            name: "salt",\n                            quantity: 0\.25,\n                            unit: "tsp",\n                            candidateId: "usda:301",\n                            decision: "assumed",\n                            searchQueries: \["salt"\],\n                            assumption:\n                                "Estimated a conservative amount for seasoning to taste\.",\n                            confidence: 0\.9,\n                            rationale:\n                                "Salt remains part of the recipe even though the source did not specify a quantity\.",\n                        \},\n                    \],\n''',
    '''''',
    "remove fabricated salt assignment",
)
test = replace_once(
    test,
    '''        expect(draft.recipe.ingredients[1]).toMatchObject({
            name: "salt",
            quantity: 0.25,
            unit: "tsp",
            source_type: "usda",
            nutrients: { sodium_mg: 581.25 },
        });
        expect(draft.requires_review).toBe(false);
''',
    '''        expect(draft.recipe.ingredients[1]).toMatchObject({
            name: "kosher salt",
            source_type: "user_supplied",
        });
        expect(draft.recipe.ingredients[1]?.quantity).toBeUndefined();
        expect(draft.recipe.ingredients[1]?.unit).toBeUndefined();
        expect(draft.recipe.ingredients[1]?.nutrients).toBeUndefined();
        expect(draft.nutrition.status).toBe("partial");
        expect(draft.requires_review).toBe(false);
''',
    "assert source-faithful low-impact assignment behavior",
)
recipe_test_path.write_text(test)

resolver_test_path = Path("src/recipe-import/semantic-resolver.test.ts")
resolver_test = resolver_test_path.read_text()
resolver_test = replace_once(
    resolver_test,
    '''        expect(JSON.stringify(requests[0]?.body)).not.toContain(
            "provider_food_id",
        );
''',
    '''        const requestBody = JSON.stringify(requests[0]?.body);
        expect(requestBody).not.toContain("provider_food_id");
        expect(requestBody).toContain("leave quantity and unit unset");
        expect(requestBody).not.toContain("1/4 teaspoon salt");
        expect(requestBody).not.toContain("1/8 teaspoon pepper");
''',
    "assert source-faithful AI instructions",
)
resolver_test_path.write_text(resolver_test)

print("Applied AI-first recipe source-fidelity patch.")
