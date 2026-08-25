import { describe, expect, test } from "bun:test";
import type { FoodCandidate } from "./food-providers/types.js";
import { previewRecipeUrl } from "./recipe-import/service.js";

function foodCandidate(name: string, providerFoodId: string): FoodCandidate {
    const nutrients = {
        calories: 100,
        protein_g: 5,
        carbs_g: 15,
        fat_g: 2,
    };
    return {
        provider: "usda",
        providerFoodId,
        name,
        dataKind: "generic",
        nutrientsPer100g: nutrients,
        portions: [
            {
                id: "100g",
                amount: 100,
                unit: "g",
                label: "100 g",
                gramWeight: 100,
                nutrients,
            },
        ],
        attribution: {
            label: "USDA FoodData Central",
            url: `https://fdc.nal.usda.gov/food/${providerFoodId}`,
        },
        confidence: 0.99,
    };
}

function recipeHtml(ingredients: string[]): string {
    return `<script type="application/ld+json">${JSON.stringify({
        "@type": "Recipe",
        name: "Latency Benchmark Recipe",
        recipeYield: "4 servings",
        recipeIngredient: ingredients,
        recipeInstructions: [{ "@type": "HowToStep", text: "Combine." }],
    })}</script>`;
}

describe("recipe import latency", () => {
    test("resolves a 16-ingredient recipe in four concurrent provider-search waves", async () => {
        const ingredients = Array.from(
            { length: 16 },
            (_, index) => `100 g benchmark ingredient ${index + 1}`,
        );
        const searches: string[] = [];
        let active = 0;
        let maxActive = 0;

        const startedAt = performance.now();
        const draft = await previewRecipeUrl("https://example.com/latency", {
            fetchPage: async (url) => ({
                submittedUrl: url,
                finalUrl: url,
                html: recipeHtml(ingredients),
            }),
            foodSearch: {
                search: async (query) => {
                    searches.push(query);
                    active += 1;
                    maxActive = Math.max(maxActive, active);
                    await Bun.sleep(35);
                    active -= 1;
                    return {
                        candidates: [
                            foodCandidate(
                                query,
                                String(9_000 + searches.length),
                            ),
                        ],
                        failures: [],
                    };
                },
            },
        });
        const elapsedMs = performance.now() - startedAt;

        console.info(
            `[recipe_import_latency_test] ingredients=${ingredients.length} searches=${searches.length} max_concurrency=${maxActive} elapsed_ms=${elapsedMs.toFixed(2)}`,
        );
        expect(searches).toHaveLength(ingredients.length);
        expect(maxActive).toBe(4);
        expect(elapsedMs).toBeLessThan(500);
        expect(
            draft.recipe.ingredients.every(
                (ingredient) => ingredient.source_type === "usda",
            ),
        ).toBe(true);
        expect(draft.requires_review).toBe(false);
    });

    test("removes source price annotations from provider queries while preserving raw provenance", async () => {
        const searches: string[] = [];
        const rawIngredient = "100 g carrots ($0.50)";
        const draft = await previewRecipeUrl("https://example.com/priced", {
            fetchPage: async (url) => ({
                submittedUrl: url,
                finalUrl: url,
                html: recipeHtml([rawIngredient]),
            }),
            foodSearch: {
                search: async (query) => {
                    searches.push(query);
                    return {
                        candidates: [foodCandidate(query, "9100")],
                        failures: [],
                    };
                },
            },
        });

        expect(searches).toEqual(["carrots"]);
        expect(draft.recipe.ingredients[0]?.name).toBe("carrots");
        expect(draft.recipe.ingredients[0]?.source_snapshot).toMatchObject({
            raw_ingredient: rawIngredient,
            normalized_ingredient: "carrots",
        });
        expect(draft.recipe.ingredients[0]?.source_type).toBe("usda");
    });
});
