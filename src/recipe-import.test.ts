import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import type { RecipeImportSemanticResolver } from "./recipe-import/types.js";

const COQ_AU_VIN_FIXTURE = readFileSync(
    fileURLToPath(
        new URL(
            "./recipe-import/fixtures/half-baked-harvest-coq-au-vin.html",
            import.meta.url,
        ),
    ),
    "utf8",
);

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
        expect(draft.ingredient_review[1]?.resolution).toBe("assumed");
        expect(draft.recipe.ingredients[1]).toMatchObject({
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
        expect(draft.nutrition.total.calories).toBe(364);
    });

    test("uses the website semantic resolver to apply assumptions and avoids blocking on low-impact seasonings", async () => {
        const potato: FoodCandidate = {
            provider: "usda",
            providerFoodId: "200",
            name: "potato",
            dataKind: "generic",
            portions: [
                {
                    id: "each",
                    amount: 1,
                    unit: "each",
                    label: "1 medium potato",
                    gramWeight: 150,
                    nutrients: {
                        calories: 110,
                        protein_g: 3,
                        carbs_g: 26,
                        fat_g: 0,
                    },
                },
            ],
            attribution: {
                label: "USDA FoodData Central",
                url: "https://fdc.nal.usda.gov/food/200",
            },
            confidence: 0.95,
        };
        const searches: string[] = [];
        const semanticResolver: RecipeImportSemanticResolver = {
            label: "openrouter:openai/gpt-test",
            normalizeRecipe: async () => [
                {
                    rawIndex: 0,
                    componentIndex: 0,
                    rawText: "4-5 small Yukon gold potatoes",
                    name: "Yukon gold potato",
                    quantity: 4.5,
                    unit: "piece",
                    searchQueries: ["Yukon gold potato", "potato"],
                    assumption: "Used the midpoint of the 4-5 potato range.",
                    impact: "medium",
                    confidence: 0.94,
                },
                {
                    rawIndex: 1,
                    componentIndex: 0,
                    rawText: "kosher salt and black pepper",
                    name: "kosher salt and black pepper",
                    searchQueries: [],
                    assumption:
                        "Seasoning amount was not specified; excluded from the nutrition total.",
                    impact: "low",
                    confidence: 0.98,
                },
            ],
        };
        const draft = await previewRecipeUrl("https://example.com/recipe", {
            semanticResolver,
            fetchPage: async (url) => ({
                submittedUrl: url,
                finalUrl: url,
                html: `
                    <script type="application/ld+json">
                    {"@type":"Recipe","name":"Potatoes","recipeYield":"6 servings","recipeIngredient":["4-5 small Yukon gold potatoes","kosher salt and black pepper"],"recipeInstructions":"Add the potatoes."}
                    </script>
                `,
            }),
            foodSearch: {
                search: async (query) => {
                    searches.push(query);
                    return { candidates: [potato], failures: [] };
                },
            },
        });

        expect(draft.schema_version).toBe(2);
        expect(draft.recipe.ingredients).toHaveLength(2);
        expect(draft.recipe.ingredients[0]).toMatchObject({
            quantity: 4.5,
            source_type: "usda",
        });
        expect(draft.recipe.ingredients[0]?.source_snapshot).toMatchObject({
            semantic_resolution_layer: "openrouter:openai/gpt-test",
            resolution: "assumed",
        });
        expect(draft.ingredient_review[0]?.resolution).toBe("assumed");
        expect(draft.ingredient_review[1]?.resolution).toBe("assumed");
        expect(draft.recipe.ingredients[1]?.source_type).toBe("model_estimate");
        expect(draft.assumptions).toHaveLength(1);
        expect(
            draft.warnings.some((item) => item.code === "quantity_range"),
        ).toBe(false);
        expect(searches.some((query) => /salt|pepper/i.test(query))).toBe(true);
    });

    test("batches uncertain ingredients into assignments and leaves no ordinary item unresolved", async () => {
        const wine: FoodCandidate = {
            provider: "usda",
            providerFoodId: "300",
            name: "red wine",
            dataKind: "generic",
            portions: [
                {
                    id: "cup",
                    amount: 1,
                    unit: "cup",
                    label: "1 cup",
                    gramWeight: 240,
                    nutrients: {
                        calories: 125,
                        protein_g: 0.1,
                        carbs_g: 3.8,
                        fat_g: 0,
                    },
                },
            ],
            attribution: {
                label: "USDA FoodData Central",
                url: "https://fdc.nal.usda.gov/food/300",
            },
            confidence: 0.72,
        };
        const salt: FoodCandidate = {
            provider: "usda",
            providerFoodId: "301",
            name: "table salt",
            dataKind: "generic",
            portions: [
                {
                    id: "tsp",
                    amount: 1,
                    unit: "tsp",
                    label: "1 teaspoon",
                    gramWeight: 6,
                    nutrients: {
                        calories: 0,
                        protein_g: 0,
                        carbs_g: 0,
                        fat_g: 0,
                        sodium_mg: 2_325,
                    },
                },
            ],
            attribution: {
                label: "USDA FoodData Central",
                url: "https://fdc.nal.usda.gov/food/301",
            },
            confidence: 0.7,
        };
        let assignmentCalls = 0;
        const semanticResolver: RecipeImportSemanticResolver = {
            label: "openrouter:openai/gpt-test",
            normalizeRecipe: async () => [
                {
                    rawIndex: 0,
                    componentIndex: 0,
                    rawText:
                        "1 1/2 cups dry red wine, such as Cabernet Sauvignon",
                    name: "dry red wine",
                    quantity: 1.5,
                    unit: "cup",
                    searchQueries: ["red wine"],
                    impact: "medium",
                    confidence: 0.62,
                },
                {
                    rawIndex: 1,
                    componentIndex: 0,
                    rawText: "kosher salt and black pepper",
                    name: "kosher salt",
                    searchQueries: ["salt"],
                    impact: "low",
                    confidence: 0.62,
                },
            ],
            resolveUncertainIngredients: async (requests) => {
                assignmentCalls += 1;
                expect(requests).toHaveLength(2);
                expect(requests.map((request) => request.reason)).toEqual([
                    "ambiguous_candidate",
                    "missing_quantity",
                ]);
                return new Map([
                    [
                        "0:0",
                        {
                            key: "0:0",
                            name: "red wine",
                            quantity: 1.5,
                            unit: "cup",
                            candidateId: "usda:300",
                            decision: "provider_match",
                            searchQueries: ["red wine"],
                            confidence: 0.93,
                            rationale:
                                "The generic red wine candidate fits the source line.",
                        },
                    ],
                    [
                        "1:0",
                        {
                            key: "1:0",
                            name: "salt",
                            quantity: 0.25,
                            unit: "tsp",
                            candidateId: "usda:301",
                            decision: "assumed",
                            searchQueries: ["salt"],
                            assumption:
                                "Estimated a conservative amount for seasoning to taste.",
                            confidence: 0.9,
                            rationale:
                                "Salt remains part of the recipe even though the source did not specify a quantity.",
                        },
                    ],
                ]);
            },
        };
        const draft = await previewRecipeUrl("https://example.com/recipe", {
            semanticResolver,
            fetchPage: async (url) => ({
                submittedUrl: url,
                finalUrl: url,
                html: `
                    <script type="application/ld+json">
                    {"@type":"Recipe","name":"Wine Potatoes","recipeYield":"6","recipeIngredient":["1 1/2 cups dry red wine, such as Cabernet Sauvignon","kosher salt and black pepper"],"recipeInstructions":"Cook."}
                    </script>
                `,
            }),
            foodSearch: {
                search: async (query) => ({
                    candidates: query.includes("wine") ? [wine] : [salt],
                    failures: [],
                }),
            },
        });

        expect(assignmentCalls).toBe(1);
        expect(
            draft.ingredient_review.map((entry) => entry.resolution),
        ).toEqual(["matched", "assumed"]);
        expect(
            draft.ingredient_review.some(
                (entry) =>
                    entry.resolution === "unresolved" ||
                    entry.resolution === "ambiguous",
            ),
        ).toBe(false);
        expect(draft.recipe.ingredients[1]).toMatchObject({
            name: "salt",
            quantity: 0.25,
            unit: "tsp",
            source_type: "usda",
            nutrients: { sodium_mg: 581.25 },
        });
        expect(draft.requires_review).toBe(false);
    });

    test("keeps the import usable when semantic normalization times out", async () => {
        const cupFlour: FoodCandidate = {
            ...candidate,
            providerFoodId: "400",
            name: "flour",
            portions: [
                {
                    id: "cup",
                    amount: 1,
                    unit: "cup",
                    label: "1 cup",
                    gramWeight: 120,
                    nutrients: {
                        calories: 437,
                        protein_g: 12.4,
                        carbs_g: 91.6,
                        fat_g: 1.2,
                    },
                },
            ],
            confidence: 0.95,
        };
        const semanticResolver: RecipeImportSemanticResolver = {
            label: "openrouter:openai/gpt-test",
            normalizeRecipe: async () => {
                throw new Error("simulated timeout");
            },
        };
        const draft = await previewRecipeUrl("https://example.com/recipe", {
            semanticResolver,
            fetchPage: async (url) => ({
                submittedUrl: url,
                finalUrl: url,
                html: `
                    <script type="application/ld+json">
                    {"@type":"Recipe","name":"Flour","recipeYield":"2","recipeIngredient":["2 cups flour"],"recipeInstructions":"Mix."}
                    </script>
                `,
            }),
            foodSearch: {
                search: async () => ({ candidates: [cupFlour], failures: [] }),
            },
        });

        expect(draft.ingredient_review[0]?.resolution).toBe("matched");
        expect(draft.ingredient_review[0]?.resolution).not.toBe("unresolved");
        expect(draft.requires_review).toBe(false);
        expect(
            draft.warnings.some(
                (item) => item.code === "semantic_ai_unavailable",
            ),
        ).toBe(true);
        expect(
            draft.warnings.find(
                (item) => item.code === "semantic_ai_unavailable",
            )?.blocking,
        ).toBe(false);
    });

    test("golden fixture keeps all 19 Coq au Vin ingredients assigned", async () => {
        const candidates = new Map<string, FoodCandidate>();
        let nextProviderId = 500;
        const candidateFor = (query: string): FoodCandidate => {
            const key = query.toLowerCase();
            const existing = candidates.get(key);
            if (existing) return existing;
            const food: FoodCandidate = {
                provider: "usda",
                providerFoodId: String(nextProviderId++),
                name: query,
                dataKind: "generic",
                portions: [
                    ...[
                        ["g", "1 gram"],
                        ["cup", "1 cup"],
                        ["tbsp", "1 tablespoon"],
                        ["tsp", "1 teaspoon"],
                        ["lb", "1 pound"],
                        ["piece", "1 piece"],
                        ["slice", "1 slice"],
                        ["clove", "1 clove"],
                        ["head", "1 head"],
                        ["sprig", "1 sprig"],
                    ].map(([unit, label]) => ({
                        id: unit,
                        amount: 1,
                        unit,
                        label,
                        gramWeight: 100,
                        nutrients: {
                            calories: 100,
                            protein_g: 2,
                            carbs_g: 10,
                            fat_g: 4,
                        },
                    })),
                ],
                attribution: {
                    label: "USDA FoodData Central",
                    url: `https://fdc.nal.usda.gov/food/${nextProviderId}`,
                },
                confidence: 0.7,
            };
            candidates.set(key, food);
            return food;
        };
        const semanticResolver: RecipeImportSemanticResolver = {
            label: "openrouter:openai/gpt-test",
            normalizeRecipe: async (recipe) =>
                recipe.ingredients.map((ingredient, rawIndex) => {
                    const lowImpact =
                        /\b(salt|pepper|thyme|parsley|bay leaves?)\b/i.test(
                            ingredient.rawText,
                        );
                    const name = ingredient.name
                        .replace(
                            /,?\s+(?:chopped|minced|grated|halved|sliced|shredded|such as)\b[\s\S]*$/i,
                            "",
                        )
                        .split(/\s+(?:or|and|plus)\s+/i)[0]!
                        .trim();
                    return {
                        rawIndex,
                        componentIndex: 0,
                        rawText: ingredient.rawText,
                        name,
                        quantity: ingredient.quantity ?? (lowImpact ? 0.25 : 1),
                        unit: ingredient.unit ?? (lowImpact ? "tsp" : "piece"),
                        searchQueries: [name],
                        impact: lowImpact ? "low" : "medium",
                        confidence: 0.9,
                    };
                }),
            resolveUncertainIngredients: async (requests) =>
                new Map(
                    requests.map((request) => {
                        const selected = request.candidates[0]!;
                        return [
                            request.key,
                            {
                                key: request.key,
                                name: request.ingredient.name,
                                quantity: request.ingredient.quantity ?? 0.25,
                                unit: request.ingredient.unit ?? "tsp",
                                candidateId: `${selected.provider}:${selected.providerFoodId}`,
                                decision: "provider_match" as const,
                                searchQueries: [request.ingredient.name],
                                confidence: 0.92,
                                rationale:
                                    "Selected the best supplied generic candidate.",
                            },
                        ];
                    }),
                ),
        };
        const draft = await previewRecipeUrl(
            "https://www.halfbakedharvest.com/slow-cooker-coq-au-vin/",
            {
                semanticResolver,
                fetchPage: async (url) => ({
                    submittedUrl: url,
                    finalUrl: url,
                    html: COQ_AU_VIN_FIXTURE,
                }),
                foodSearch: {
                    search: async (query) => ({
                        candidates: [candidateFor(query)],
                        failures: [],
                    }),
                },
            },
        );

        expect(draft.recipe.ingredients).toHaveLength(19);
        expect(draft.ingredient_review).toHaveLength(19);
        expect(
            draft.ingredient_review.every(
                (entry) =>
                    entry.resolution !== "unresolved" &&
                    entry.resolution !== "ambiguous",
            ),
        ).toBe(true);
        expect(
            draft.recipe.ingredients.every((ingredient) =>
                Boolean(ingredient.source_snapshot.raw_ingredient),
            ),
        ).toBe(true);
        expect(draft.requires_review).toBe(false);
        expect(draft.nutrition.status).toBe("complete");
        expect(draft.recipe.ingredients[2]).toMatchObject({
            source_type: "usda",
            quantity: 0.25,
            unit: "tsp",
        });
    });

    test("skips reranking for strong matches and labels a semantic selection as matched", async () => {
        const breadFlour: FoodCandidate = {
            ...candidate,
            providerFoodId: "101",
            name: "bread flour",
        };
        let rerankCalls = 0;
        const semanticResolver: RecipeImportSemanticResolver = {
            label: "openrouter:openai/gpt-test",
            normalizeRecipe: async () => [
                {
                    rawIndex: 0,
                    componentIndex: 0,
                    rawText: "100 g flour dish",
                    name: "flour dish",
                    quantity: 100,
                    unit: "g",
                    searchQueries: [],
                    impact: "medium",
                    confidence: 0.94,
                },
            ],
            chooseCandidates: async (requests) => {
                rerankCalls += 1;
                expect(requests).toHaveLength(1);
                return new Map([
                    [
                        requests[0]!.key,
                        {
                            candidateId: "usda:100",
                            confidence: 0.95,
                            rationale:
                                "The generic flour candidate is the best fit.",
                        },
                    ],
                ]);
            },
        };
        const draft = await previewRecipeUrl("https://example.com/recipe", {
            semanticResolver,
            fetchPage: async (url) => ({
                submittedUrl: url,
                finalUrl: url,
                html: `
                    <script type="application/ld+json">
                    {"@type":"Recipe","name":"Flour","recipeYield":"2 servings","recipeIngredient":["100 g flour dish"],"recipeInstructions":"Mix."}
                    </script>
                `,
            }),
            foodSearch: {
                search: async () => ({
                    candidates: [candidate, breadFlour],
                    failures: [],
                }),
            },
        });

        expect(rerankCalls).toBe(1);
        expect(draft.ingredient_review[0]?.resolution).toBe("matched");
        expect(draft.assumptions).toHaveLength(0);
        expect(draft.recipe.ingredients[0]?.source_snapshot).toMatchObject({
            candidate_selection_method: "semantic_ai",
        });
    });

    test("does not call candidate reranking when the first provider match is exact", async () => {
        let rerankCalls = 0;
        const semanticResolver: RecipeImportSemanticResolver = {
            label: "openrouter:openai/gpt-test",
            normalizeRecipe: async () => [
                {
                    rawIndex: 0,
                    componentIndex: 0,
                    rawText: "100 g all purpose flour",
                    name: "all purpose flour",
                    quantity: 100,
                    unit: "g",
                    searchQueries: ["all purpose flour", "flour"],
                    impact: "medium",
                    confidence: 0.99,
                },
            ],
            chooseCandidates: async () => {
                rerankCalls += 1;
                return new Map();
            },
        };
        await previewRecipeUrl("https://example.com/recipe", {
            semanticResolver,
            fetchPage: async (url) => ({
                submittedUrl: url,
                finalUrl: url,
                html: `
                    <script type="application/ld+json">
                    {"@type":"Recipe","name":"Flour","recipeYield":"2 servings","recipeIngredient":["100 g all purpose flour"],"recipeInstructions":"Mix."}
                    </script>
                `,
            }),
            foodSearch: {
                search: async () => ({
                    candidates: [candidate],
                    failures: [],
                }),
            },
        });

        expect(rerankCalls).toBe(0);
    });
});
