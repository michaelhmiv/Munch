import { describe, expect, test } from "bun:test";
import type { FoodCandidate } from "./food-providers/types.js";
import {
    assertSafeRecipeUrl,
    fetchRecipePage,
    isPrivateOrReservedAddress,
    resetRecipeImportFetchState,
} from "./recipe-import/fetch.js";
import {
    parseIngredientText,
    parseRecipeHtml,
} from "./recipe-import/parser.js";
import { previewRecipeUrl } from "./recipe-import/service.js";

const candidate: FoodCandidate = {
    provider: "usda",
    providerFoodId: "100",
    name: "all purpose flour",
    brand: undefined,
    dataKind: "generic",
    portions: [
        {
            id: "100g",
            amount: 100,
            unit: "g",
            label: "100 g",
            gramWeight: 100,
            nutrients: {
                calories: 364,
                protein_g: 10.3,
                carbs_g: 76.3,
                fat_g: 1,
            },
        },
    ],
    nutrientsPer100g: {
        calories: 364,
        protein_g: 10.3,
        carbs_g: 76.3,
        fat_g: 1,
    },
    attribution: {
        label: "USDA FoodData Central",
        url: "https://fdc.nal.usda.gov/food/100",
    },
    confidence: 0.96,
};

describe("recipe import URL safety", () => {
    test("rejects local and reserved addresses", () => {
        for (const value of [
            "https://127.0.0.1/recipe",
            "https://10.0.0.1/recipe",
            "https://192.168.1.4/recipe",
            "https://[::1]/recipe",
            "https://localhost/recipe",
        ]) {
            expect(() => assertSafeRecipeUrl(value)).toThrow();
        }
        expect(isPrivateOrReservedAddress("169.254.169.254")).toBe(true);
        expect(isPrivateOrReservedAddress("93.184.216.34")).toBe(false);
    });

    test("requires HTTPS and rejects credentials or non-standard ports", () => {
        expect(() =>
            assertSafeRecipeUrl("http://example.com/recipe"),
        ).toThrow();
        expect(() =>
            assertSafeRecipeUrl("https://user:password@example.com/recipe"),
        ).toThrow();
        expect(() =>
            assertSafeRecipeUrl("https://example.com:8443/recipe"),
        ).toThrow();
        expect(assertSafeRecipeUrl("https://example.com/recipe").hostname).toBe(
            "example.com",
        );
    });

    test("follows only safe redirects and bounds the response", async () => {
        resetRecipeImportFetchState();
        const calls: string[] = [];
        const responseBodies = [
            new Response(null, {
                status: 302,
                headers: { location: "https://example.com/final" },
            }),
            new Response("<html><body>recipe</body></html>", {
                status: 200,
                headers: { "content-type": "text/html" },
            }),
        ];
        const page = await fetchRecipePage("https://example.com/start", {
            resolver: async () => [{ address: "93.184.216.34" }],
            fetcher: async (input) => {
                calls.push(String(input));
                return responseBodies.shift()!;
            },
        });
        expect(calls).toEqual([
            "https://example.com/start",
            "https://example.com/final",
        ]);
        expect(page.finalUrl).toBe("https://example.com/final");
        expect(page.html).toContain("recipe");
    });
});

describe("recipe import parser", () => {
    test("parses JSON-LD recipes, fractions, instructions, and yield", () => {
        const parsed = parseRecipeHtml(`
            <html><head><link rel="canonical" href="https://example.com/oats" /></head><body>
              <script type="application/ld+json">
                {
                  "@type": "Recipe",
                  "name": "Overnight Oats",
                  "description": "A make-ahead breakfast",
                  "recipeYield": "Serves 2",
                  "recipeIngredient": ["1 1/2 cups rolled oats", "½ cup milk", "Salt to taste"],
                  "recipeInstructions": [{"@type":"HowToStep","text":"Mix everything."},{"@type":"HowToStep","text":"Chill overnight."}],
                  "prepTime": "PT5M",
                  "cookTime": "PT0M",
                  "author": {"name": "Munch Test"},
                  "publisher": {"name": "Example Kitchen"}
                }
              </script>
            </body></html>
        `);
        expect(parsed.strategy).toBe("schema_org_json_ld");
        expect(parsed.name).toBe("Overnight Oats");
        expect(parsed.servings).toBe(2);
        expect(parsed.preparationMinutes).toBe(5);
        expect(parsed.ingredients[0]).toMatchObject({
            name: "rolled oats",
            quantity: 1.5,
            unit: "cup",
        });
        expect(parsed.ingredients[1]).toMatchObject({
            name: "milk",
            quantity: 0.5,
            unit: "cup",
        });
        expect(parsed.instructions).toEqual([
            "Mix everything.",
            "Chill overnight.",
        ]);
        expect(parsed.author).toBe("Munch Test");
        expect(parsed.siteName).toBe("Example Kitchen");
        expect(parsed.canonicalUrl).toBe("https://example.com/oats");
    });

    test("falls back to Recipe microdata", () => {
        const parsed = parseRecipeHtml(`
            <article itemscope itemtype="https://schema.org/Recipe">
              <h1 itemprop="name">Simple Toast</h1>
              <span itemprop="recipeYield">1 serving</span>
              <span itemprop="recipeIngredient">2 slices bread</span>
              <div itemprop="recipeInstructions">Toast the bread.</div>
            </article>
        `);
        expect(parsed.strategy).toBe("microdata");
        expect(parsed.name).toBe("Simple Toast");
        expect(parsed.ingredients[0]).toMatchObject({
            name: "bread",
            quantity: 2,
            unit: "slice",
        });
    });

    test("preserves raw text and warns when a quantity is not measurable", () => {
        const result = parseIngredientText("Salt to taste (optional)");
        expect(result.ingredient).toMatchObject({
            rawText: "Salt to taste (optional)",
            name: "Salt to taste",
            optional: true,
        });
        expect(result.warnings).toHaveLength(0);
    });
});

describe("recipe import enrichment", () => {
    test("returns a save-compatible imported recipe and scales nutrition", async () => {
        const draft = await previewRecipeUrl("https://example.com/recipe", {
            fetchPage: async (url) => ({
                submittedUrl: url,
                finalUrl: url,
                html: `
                        <script type="application/ld+json">
                        {"@type":"Recipe","name":"Test Bread","recipeYield":"2 servings","recipeIngredient":["100 g all purpose flour","Salt to taste"],"recipeInstructions":"Mix."}
                        </script>
                    `,
            }),
            foodSearch: {
                search: async () => ({ candidates: [candidate], failures: [] }),
            },
        });
        expect(draft.recipe.source_type).toBe("imported");
        expect(draft.recipe.source_url).toBe("https://example.com/recipe");
        expect(draft.recipe.ingredients[0]).toMatchObject({
            source_type: "usda",
            provider_food_id: "100",
            nutrients: {
                calories: 364,
                protein_g: 10.3,
            },
        });
        expect(draft.recipe.ingredients[0]?.source_snapshot).toMatchObject({
            resolution_layer: "recipe_url",
            scaling_reason: "gram_weight",
            raw_ingredient: "100 g all purpose flour",
        });
        expect(draft.ingredient_review[1]?.resolution).toBe("unresolved");
        expect(draft.status).toBe("partial");
        expect(draft.nutrition.status).toBe("partial");
        expect(draft.nutrition.total.calories).toBe(364);
    });
});
