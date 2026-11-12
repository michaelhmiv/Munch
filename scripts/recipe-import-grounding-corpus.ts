/**
 * Live recipe-import grounding corpus.
 *
 * Recipe-import corpus smoke only proves pages parse. This lane runs a
 * small set of real recipe URLs through the full importer with the
 * real food search service and asserts that ingredients resolve to
 * provider-grounded foods (USDA / Open Food Facts with a provider food
 * id) at or above the floors recorded in the fixture, instead of
 * silently degrading to model estimates when ingredient text carries
 * noise such as "(284g)" into the search query.
 *
 * This fetches live pages and calls live providers, so it is gated
 * behind RUN_RECIPE_IMPORT_GROUNDING_CORPUS=1 and runs only from the
 * recipe-import-grounding-corpus workflow (dispatch + weekly). Floors
 * were measured on 2026-11-11; see the fixture header for the numbers
 * and the reasoning.
 */
import { previewRecipeUrl } from "../src/recipe-import/service.js";
import {
    RECIPE_GROUNDING_AGGREGATE_FLOOR,
    RECIPE_GROUNDING_CORPUS,
    RECIPE_GROUNDING_PER_RECIPE_FLOOR,
} from "../src/recipe-import/fixtures/recipe-grounding-corpus.js";

interface GroundingResult {
    id: string;
    submittedUrl: string;
    recipeName?: string;
    strategy?: string;
    ingredients: number;
    grounded: number;
    groundedRate?: number;
    perRecipeFloorMet?: boolean;
    error?: string;
}

async function main(): Promise<void> {
    if (process.env.RUN_RECIPE_IMPORT_GROUNDING_CORPUS !== "1") {
        console.log(
            JSON.stringify({
                skipped: true,
                reason: "Set RUN_RECIPE_IMPORT_GROUNDING_CORPUS=1 to run the live recipe grounding corpus.",
            }),
        );
        return;
    }

    const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
    const limit = limitArg
        ? Math.max(1, Number.parseInt(limitArg.slice("--limit=".length), 10))
        : RECIPE_GROUNDING_CORPUS.length;
    const entries = RECIPE_GROUNDING_CORPUS.slice(0, limit);
    const results: GroundingResult[] = [];

    for (const entry of entries) {
        try {
            const draft = await previewRecipeUrl(entry.recipeUrl);
            const ingredients = draft.recipe.ingredients;
            const grounded = ingredients.filter(
                (ingredient) =>
                    (ingredient.source_type === "usda" ||
                        ingredient.source_type === "open_food_facts") &&
                    Boolean(ingredient.provider_food_id),
            ).length;
            const groundedRate =
                ingredients.length > 0 ? grounded / ingredients.length : 0;
            results.push({
                id: entry.id,
                submittedUrl: entry.recipeUrl,
                recipeName: draft.recipe.title,
                strategy: draft.parser.strategy,
                ingredients: ingredients.length,
                grounded,
                groundedRate,
                perRecipeFloorMet:
                    draft.parser.strategy === entry.expectedStrategy &&
                    ingredients.length > 0 &&
                    draft.recipe.instructions.length > 0 &&
                    groundedRate >= RECIPE_GROUNDING_PER_RECIPE_FLOOR,
            });
        } catch (error) {
            results.push({
                id: entry.id,
                submittedUrl: entry.recipeUrl,
                ingredients: 0,
                grounded: 0,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const totalIngredients = results.reduce(
        (sum, result) => sum + result.ingredients,
        0,
    );
    const totalGrounded = results.reduce(
        (sum, result) => sum + result.grounded,
        0,
    );
    const aggregateRate =
        totalIngredients > 0 ? totalGrounded / totalIngredients : 0;
    const corpusPassed =
        results.every((result) => result.perRecipeFloorMet === true) &&
        aggregateRate >= RECIPE_GROUNDING_AGGREGATE_FLOOR;

    console.log(
        JSON.stringify(
            {
                corpus: "recipe-import-grounding",
                perRecipeFloor: RECIPE_GROUNDING_PER_RECIPE_FLOOR,
                aggregateFloor: RECIPE_GROUNDING_AGGREGATE_FLOOR,
                totalIngredients,
                totalGrounded,
                aggregateRate,
                corpusPassed,
                results,
            },
            null,
            2,
        ),
    );
    process.exit(corpusPassed ? 0 : 1);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
