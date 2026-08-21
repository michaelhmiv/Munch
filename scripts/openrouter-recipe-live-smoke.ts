import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FoodCandidate } from "../src/food-providers/types.js";
import {
    getWebsiteRecipeImportSemanticResolver,
    recipeImportAiConfig,
} from "../src/recipe-import/semantic-resolver.js";
import { previewRecipeUrl } from "../src/recipe-import/service.js";

const fixture = readFileSync(
    fileURLToPath(
        new URL(
            "../src/recipe-import/fixtures/half-baked-harvest-coq-au-vin.html",
            import.meta.url,
        ),
    ),
    "utf8",
);

const portionUnits = [
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
] as const;

function candidateFor(query: string): FoodCandidate {
    const providerFoodId = `live-smoke-${encodeURIComponent(query).slice(0, 180)}`;
    return {
        provider: "usda",
        providerFoodId,
        name: query,
        dataKind: "generic",
        portions: portionUnits.map(([unit, label]) => ({
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
        attribution: { label: "CI fixture" },
        confidence: 0.7,
    };
}

const config = recipeImportAiConfig();
if (!config) {
    throw new Error(
        "OPENROUTER_API_KEY is required. Run this workflow manually with the repository secret configured.",
    );
}

const semanticResolver = getWebsiteRecipeImportSemanticResolver();
if (!semanticResolver) {
    throw new Error("The website OpenRouter resolver is disabled.");
}

const draft = await previewRecipeUrl(
    "https://www.halfbakedharvest.com/slow-cooker-coq-au-vin/",
    {
        semanticResolver,
        fetchPage: async (url) => ({
            submittedUrl: url,
            finalUrl: url,
            html: fixture,
        }),
        foodSearch: {
            search: async (query) => ({
                candidates: [candidateFor(query)],
                failures: [],
            }),
        },
    },
);

const unresolved = draft.ingredient_review.filter(
    (entry) =>
        entry.resolution === "unresolved" || entry.resolution === "ambiguous",
);
const rawIngredients = new Set(
    draft.ingredient_review.map((entry) => entry.raw_text),
);
if (rawIngredients.size < 19 || unresolved.length > 0) {
    throw new Error(
        `Recipe assignment smoke failed: raw_ingredients=${rawIngredients.size} unresolved=${unresolved.length}`,
    );
}
if (draft.requires_review) {
    throw new Error("Recipe assignment smoke unexpectedly requires review.");
}
if (draft.nutrition.status !== "complete") {
    throw new Error(
        `Recipe assignment smoke returned incomplete nutrition: ${draft.nutrition.status}`,
    );
}

console.log(
    JSON.stringify({
        ok: true,
        model: config.model,
        response_format: config.responseFormat,
        response_healing: config.responseHealing,
        ingredients: draft.recipe.ingredients.length,
        raw_ingredients: rawIngredients.size,
        unresolved: unresolved.length,
        nutrition_status: draft.nutrition.status,
    }),
);
