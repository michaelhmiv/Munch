import { describe, expect, test } from "bun:test";
import { CodeFirstRecipeImportResolver } from "./code-first-resolver.js";
import type {
    ParsedRecipe,
    RecipeImportSemanticResolver,
} from "./types.js";
import { OpenRouterDecisionClient } from "../website-decision-client.js";

const recipe = (
    ingredients: ParsedRecipe["ingredients"],
): Pick<
    ParsedRecipe,
    "name" | "description" | "servings" | "instructions" | "ingredients"
> => ({
    name: "Source Fidelity Test",
    servings: 4,
    instructions: ["Mix."],
    ingredients,
});

const ingredient = (rawText: string) => ({
    rawText,
    name: rawText,
});

const client = () =>
    new OpenRouterDecisionClient(
        {
            apiKey: "or-test",
            model: "~typesafe/jev-latest",
            endpoint: "https://openrouter.example/api/alpha/decisions",
            timeoutMs: 5000,
            minConfidence: 0.75,
        },
        {
            fetcher: async () =>
                new Response(
                    JSON.stringify({
                        answers: {
                            q0: {
                                type: "choice",
                                choice: "NO_MATCH",
                                confidence: 0.96,
                            },
                        },
                    }),
                    { status: 200 },
                ),
        },
    );

describe("code-first source and model routing", () => {
    test("structured source ingredients avoid Qwen entirely", async () => {
        let qwenCalls = 0;
        const qwen: RecipeImportSemanticResolver = {
            normalizeRecipe: async () => {
                qwenCalls++;
                throw new Error("should not call Qwen");
            },
        };
        const resolver = new CodeFirstRecipeImportResolver(qwen, client());
        const intents = await resolver.normalizeRecipe(
            recipe([
                {
                    rawText: "1/3 c. olive oil",
                    name: "olive oil",
                    quantity: 1 / 3,
                    unit: "cup",
                },
                {
                    rawText: "2 15oz. cans beans",
                    name: "beans",
                    quantity: 30,
                    unit: "oz",
                },
            ]),
        );
        expect(qwenCalls).toBe(0);
        expect(intents).toHaveLength(2);
        expect(intents[0]).toMatchObject({
            rawIndex: 0,
            name: "olive oil",
            quantity: 1 / 3,
            unit: "cup",
        });
        expect(intents[1]).toMatchObject({
            rawIndex: 1,
            quantity: 30,
            unit: "oz",
        });
    });

    test("Qwen only sees compound lines and its indexes map back to the source", async () => {
        const seen: string[][] = [];
        const qwen: RecipeImportSemanticResolver = {
            normalizeRecipe: async (source) => {
                seen.push(source.ingredients.map((x) => x.rawText));
                return [
                    {
                        rawIndex: 0,
                        componentIndex: 0,
                        rawText: source.ingredients[0]!.rawText,
                        name: "lemon zest",
                        quantity: 1,
                        unit: "piece",
                        searchQueries: ["lemon zest"],
                        impact: "medium",
                        confidence: 0.95,
                    },
                    {
                        rawIndex: 0,
                        componentIndex: 1,
                        rawText: source.ingredients[0]!.rawText,
                        name: "lemon juice",
                        quantity: 1,
                        unit: "piece",
                        searchQueries: ["lemon juice"],
                        impact: "medium",
                        confidence: 0.95,
                    },
                ];
            },
        };
        const resolver = new CodeFirstRecipeImportResolver(qwen, client());
        const intents = await resolver.normalizeRecipe(
            recipe([
                {
                    rawText: "1 cup olive oil",
                    name: "olive oil",
                    quantity: 1,
                    unit: "cup",
                },
                {
                    rawText: "Grated zest and juice of 1 lemon",
                    name: "Grated zest and juice of 1 lemon",
                },
                {
                    rawText: "1 cup milk",
                    name: "milk",
                    quantity: 1,
                    unit: "cup",
                },
            ]),
        );
        expect(seen).toEqual([["Grated zest and juice of 1 lemon"]]);
        expect(resolver.resolvedSourceWarnings.get(1)).toEqual(
            new Set(["compound_ingredient", "quantity_unparsed"]),
        );
        expect(intents.map((x) => [x.rawIndex, x.componentIndex, x.name])).toEqual([
            [0, 0, "olive oil"],
            [1, 0, "lemon zest"],
            [1, 1, "lemon juice"],
            [2, 0, "milk"],
        ]);
    });

    test("strict preview clears only source warnings corrected by a verified compound split", async () => {
        const url = "https://example.com/compound";
        const compound = "Grated zest and juice of 1 lemon";
        const qwen: RecipeImportSemanticResolver = {
            normalizeRecipe: async () => [
                {
                    rawIndex: 0,
                    componentIndex: 0,
                    rawText: compound,
                    name: "lemon zest",
                    quantity: 1,
                    unit: "piece",
                    searchQueries: ["lemon zest"],
                    impact: "medium",
                    confidence: 0.95,
                },
                {
                    rawIndex: 0,
                    componentIndex: 1,
                    rawText: compound,
                    name: "lemon juice",
                    quantity: 1,
                    unit: "piece",
                    searchQueries: ["lemon juice"],
                    impact: "medium",
                    confidence: 0.95,
                },
            ],
        };
        const resolver = new CodeFirstRecipeImportResolver(qwen, client());
        const { previewRecipeUrl } = await import("./service.js");
        const draft = await previewRecipeUrl(url, {
            preserveSourceWarnings: true,
            semanticResolver: resolver,
            fetchPage: async () => ({
                submittedUrl: url,
                finalUrl: url,
                html: '<script type="application/ld+json">' +
                    JSON.stringify({
                        "@type": "Recipe",
                        name: "Lemon Test",
                        recipeYield: "4 servings",
                        recipeIngredient: ["1 cup olive oil", compound],
                        recipeInstructions: "Mix.",
                    }) +
                    "</script>",
            }),
            foodSearch: {
                search: async (query) => ({
                    candidates: [
                        {
                            provider: "usda",
                            providerFoodId: query,
                            name: query,
                            dataKind: "generic",
                            portions: [
                                {
                                    id: "piece",
                                    amount: 1,
                                    unit: "piece",
                                    label: "1 piece",
                                    gramWeight: 100,
                                    nutrients: { calories: 1 },
                                },
                                {
                                    id: "cup",
                                    amount: 1,
                                    unit: "cup",
                                    label: "1 cup",
                                    gramWeight: 100,
                                    nutrients: { calories: 1 },
                                },
                            ],
                            attribution: { label: "test food fixture" },
                            confidence: 0.95,
                        },
                    ],
                    failures: [],
                }),
            },
        });
        expect(draft.recipe.ingredients).toHaveLength(3);
        expect(draft.recipe.ingredients.map((x) => x.name)).toEqual([
            "olive oil",
            "lemon zest",
            "lemon juice",
        ]);
        expect(draft.warnings.map((x) => x.code)).not.toContain(
            "compound_ingredient",
        );
        expect(draft.warnings.map((x) => x.code)).not.toContain(
            "quantity_unparsed",
        );
    });

    test("never asks either model to invent a missing source quantity", async () => {
        let qwenCalls = 0;
        const qwen: RecipeImportSemanticResolver = {
            normalizeRecipe: async () => [],
            resolveUncertainIngredients: async () => {
                qwenCalls++;
                return new Map();
            },
        };
        const resolver = new CodeFirstRecipeImportResolver(qwen, client());
        const result = await resolver.resolveUncertainIngredients([
            {
                key: "0:0",
                reason: "missing_quantity",
                ingredient: {
                    rawText: "Splash of olive oil",
                    name: "olive oil",
                },
                candidates: [],
            },
        ]);
        expect(qwenCalls).toBe(0);
        expect(result.size).toBe(0);
    });
});
