import type {
    ParsedRecipe,
    RecipeImportCandidateChoiceRequest,
    RecipeImportIngredientAssignmentRequest,
    RecipeImportIngredientIntent,
    RecipeImportSemanticResolver,
} from "./types.js";
import { parseIngredientText } from "./parser.js";
import { HybridRecipeImportResolver } from "./semantic-resolver.js";
import { OpenRouterDecisionClient } from "../website-decision-client.js";

const LOW_IMPACT_SOURCE =
    /\b(?:salt|pepper|thyme|parsley|oregano|basil|rosemary|sage|cumin|paprika|seasoning|spice|herb)\b/i;

function sourceIntent(
    ingredient: ParsedRecipe["ingredients"][number],
    rawIndex: number,
): RecipeImportIngredientIntent {
    return {
        rawIndex,
        componentIndex: 0,
        rawText: ingredient.rawText,
        name: ingredient.name,
        ...(ingredient.quantity === undefined
            ? {}
            : { quantity: ingredient.quantity }),
        ...(ingredient.unit ? { unit: ingredient.unit } : {}),
        ...(ingredient.preparation
            ? { preparation: ingredient.preparation }
            : {}),
        optional: Boolean(ingredient.optional),
        searchQueries: ingredient.searchQueries ?? [],
        impact: LOW_IMPACT_SOURCE.test(ingredient.name) ? "low" : "medium",
        confidence: 0.85,
    };
}

/**
 * Experimental recipe routing. Source extraction stays deterministic.
 * Qwen only interprets source lines containing multiple real ingredients,
 * or searches again after no candidate could be retrieved. Alternatives,
 * missing quantities and package-drain weights stay explicit review matters:
 * a model cannot know which option the cook chose or how much they used.
 */
export class CodeFirstRecipeImportResolver implements RecipeImportSemanticResolver {
    readonly label = "experiment:code-first+jev+targeted-qwen";
    private readonly hybrid: HybridRecipeImportResolver;

    constructor(
        private readonly generative: RecipeImportSemanticResolver,
        decisionClient: OpenRouterDecisionClient,
    ) {
        this.hybrid = new HybridRecipeImportResolver(generative, decisionClient);
    }

    async normalizeRecipe(
        recipe: Pick<
            ParsedRecipe,
            "name" | "description" | "servings" | "instructions" | "ingredients"
        >,
    ): Promise<RecipeImportIngredientIntent[]> {
        const compounds = recipe.ingredients.flatMap((ingredient, rawIndex) => {
            const needsSplit = parseIngredientText(ingredient.rawText).warnings.some(
                (warning) => warning.code === "compound_ingredient",
            );
            return needsSplit ? [{ ingredient, rawIndex }] : [];
        });
        if (compounds.length === 0) {
            console.info(
                `[code_first] phase=normalize mode=source ingredients=${recipe.ingredients.length} qwen_calls=0`,
            );
            return recipe.ingredients.map(sourceIntent);
        }

        // Ask Qwen only about problematic lines, never to rewrite source facts
        // on already parsed lines. Its local indexes are remapped below.
        const normalized = await this.generative.normalizeRecipe({
            name: recipe.name,
            description: recipe.description,
            servings: recipe.servings,
            instructions: recipe.instructions.slice(0, 20),
            ingredients: compounds.map(({ ingredient }) => ingredient),
        });
        const byIndex = new Map<number, RecipeImportIngredientIntent[]>();
        for (const intent of normalized) {
            const originalIndex = compounds[intent.rawIndex]?.rawIndex;
            if (originalIndex === undefined) {
                throw new Error("Qwen returned an unexpected source ingredient index.");
            }
            const entries = byIndex.get(originalIndex) ?? [];
            entries.push({ ...intent, rawIndex: originalIndex });
            byIndex.set(originalIndex, entries);
        }
        if (
            compounds.some(
                ({ rawIndex }) => (byIndex.get(rawIndex)?.length ?? 0) === 0,
            )
        ) {
            throw new Error("Qwen did not interpret every compound ingredient.");
        }

        const intents = recipe.ingredients.flatMap((ingredient, rawIndex) => {
            return byIndex.get(rawIndex) ?? [sourceIntent(ingredient, rawIndex)];
        });
        console.info(
            `[code_first] phase=normalize mode=targeted ingredients=${recipe.ingredients.length} compound_lines=${compounds.length} normalized_components=${intents.length}`,
        );
        return intents;
    }

    async resolveUncertainIngredients(
        requests: RecipeImportIngredientAssignmentRequest[],
    ) {
        // These issues require user/source facts, not invented model estimates.
        const actionable = requests.filter(
            (request) =>
                request.reason === "ambiguous_candidate" ||
                request.reason === "no_candidate",
        );
        const deferred = requests.length - actionable.length;
        console.info(
            `[code_first] phase=assign questions=${requests.length} actionable=${actionable.length} source_review=${deferred}`,
        );
        return this.hybrid.resolveUncertainIngredients(actionable);
    }

    chooseCandidates(requests: RecipeImportCandidateChoiceRequest[]) {
        return this.hybrid.chooseCandidates(requests);
    }
}
