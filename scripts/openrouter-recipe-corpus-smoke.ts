import type { FoodCandidate } from "../src/food-providers/types.js";
import {
    getWebsiteRecipeImportSemanticResolver,
    recipeImportAiConfig,
} from "../src/recipe-import/semantic-resolver.js";
import { previewRecipeUrl } from "../src/recipe-import/service.js";
import { RECIPE_IMPORT_CORPUS } from "../src/recipe-import/fixtures/recipe-corpus.js";

type AiCorpusResult = {
    id: string;
    site: string;
    url: string;
    ok: boolean;
    durationMs: number;
    ingredients?: number;
    assumptions?: number;
    unresolved?: number;
    ambiguous?: number;
    requiresReview?: boolean;
    nutritionStatus?: string;
    error?: string;
};

const config = recipeImportAiConfig();
if (!config) {
    throw new Error(
        "OPENROUTER_API_KEY is required for the live AI corpus smoke.",
    );
}

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
    const providerFoodId = `live-corpus-${encodeURIComponent(query).slice(0, 180)}`;
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

const requestedLimit = Number.parseInt(
    process.env.MUNCH_RECIPE_IMPORT_CORPUS_LIMIT ?? "20",
    10,
);
const entries = RECIPE_IMPORT_CORPUS.slice(
    0,
    Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), RECIPE_IMPORT_CORPUS.length)
        : RECIPE_IMPORT_CORPUS.length,
);
const concurrency = Math.min(
    Math.max(
        Number.parseInt(
            process.env.MUNCH_RECIPE_IMPORT_CORPUS_CONCURRENCY ?? "2",
            10,
        ) || 2,
        1,
    ),
    2,
);

async function checkEntry(
    entry: (typeof RECIPE_IMPORT_CORPUS)[number],
): Promise<AiCorpusResult> {
    const startedAt = Date.now();
    try {
        const semanticResolver = getWebsiteRecipeImportSemanticResolver();
        if (!semanticResolver)
            throw new Error("website AI resolver is disabled");
        const draft = await previewRecipeUrl(entry.url, {
            semanticResolver,
            foodSearch: {
                search: async (query) => ({
                    candidates: [candidateFor(query)],
                    failures: [],
                }),
            },
        });
        const unresolved = draft.ingredient_review.filter(
            (item) => item.resolution === "unresolved",
        ).length;
        const ambiguous = draft.ingredient_review.filter(
            (item) => item.resolution === "ambiguous",
        ).length;
        const blockingWarnings = draft.warnings.filter(
            (warning) => warning.blocking !== false,
        ).length;
        const ok =
            draft.recipe.ingredients.length > 0 &&
            unresolved === 0 &&
            ambiguous === 0 &&
            !draft.requires_review &&
            blockingWarnings === 0 &&
            draft.nutrition.status === "complete";
        const result: AiCorpusResult = {
            id: entry.id,
            site: entry.site,
            url: entry.url,
            ok,
            durationMs: Date.now() - startedAt,
            ingredients: draft.recipe.ingredients.length,
            assumptions: draft.assumptions.length,
            unresolved,
            ambiguous,
            requiresReview: draft.requires_review,
            nutritionStatus: draft.nutrition.status,
            ...(ok
                ? {}
                : {
                      error: `blocking_warnings=${blockingWarnings} status=${draft.status}`,
                  }),
        };
        console.log(
            `[recipe_import_ai_corpus] ${ok ? "ok" : "failed"} site=${entry.site} ingredients=${result.ingredients} assumptions=${result.assumptions} unresolved=${unresolved} ambiguous=${ambiguous} duration_ms=${result.durationMs}`,
        );
        return result;
    } catch (error) {
        const result: AiCorpusResult = {
            id: entry.id,
            site: entry.site,
            url: entry.url,
            ok: false,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
        };
        console.error(
            `[recipe_import_ai_corpus] failed site=${entry.site} duration_ms=${result.durationMs} error=${result.error}`,
        );
        return result;
    }
}

const results: AiCorpusResult[] = [];
let nextIndex = 0;
async function worker(): Promise<void> {
    while (true) {
        const index = nextIndex++;
        const entry = entries[index];
        if (!entry) return;
        results[index] = await checkEntry(entry);
    }
}

await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, () =>
        worker(),
    ),
);

const failures = results.filter((result) => !result.ok);
const report = {
    ok: failures.length === 0,
    model: config.model,
    response_format: config.responseFormat,
    response_healing: config.responseHealing,
    requested: entries.length,
    passed: results.length - failures.length,
    failed: failures.length,
    results,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exitCode = 1;
