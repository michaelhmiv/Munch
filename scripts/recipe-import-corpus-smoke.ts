import {
    fetchRecipePage,
    RecipeImportError,
} from "../src/recipe-import/fetch.js";
import { parseRecipeHtml } from "../src/recipe-import/parser.js";
import { RECIPE_IMPORT_CORPUS } from "../src/recipe-import/fixtures/recipe-corpus.js";

type CorpusResult = {
    id: string;
    site: string;
    url: string;
    ok: boolean;
    durationMs: number;
    finalUrl?: string;
    strategy?: string;
    name?: string;
    servings?: number;
    ingredients?: number;
    instructions?: number;
    warnings?: number;
    error?: string;
    errorCode?: string;
};

const requestedLimit = Number.parseInt(
    process.env.MUNCH_RECIPE_IMPORT_CORPUS_LIMIT ?? "20",
    10,
);
const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), RECIPE_IMPORT_CORPUS.length)
    : RECIPE_IMPORT_CORPUS.length;
const entries = RECIPE_IMPORT_CORPUS.slice(0, limit);
const concurrency = Math.min(
    Math.max(
        Number.parseInt(
            process.env.MUNCH_RECIPE_IMPORT_CORPUS_CONCURRENCY ?? "3",
            10,
        ) || 3,
        1,
    ),
    4,
);

async function checkEntry(
    entry: (typeof RECIPE_IMPORT_CORPUS)[number],
): Promise<CorpusResult> {
    const startedAt = Date.now();
    try {
        const page = await fetchRecipePage(entry.url);
        const parsed = parseRecipeHtml(page.html);
        if (!parsed.name || parsed.ingredients.length === 0) {
            throw new Error(
                "recipe metadata did not contain a name and ingredient list",
            );
        }
        if (parsed.instructions.length === 0) {
            throw new Error("recipe metadata did not contain instructions");
        }
        if (!Number.isFinite(parsed.servings) || parsed.servings <= 0) {
            throw new Error(
                "recipe metadata did not contain a positive serving yield",
            );
        }
        const result: CorpusResult = {
            id: entry.id,
            site: entry.site,
            url: entry.url,
            ok: true,
            durationMs: Date.now() - startedAt,
            finalUrl: page.finalUrl,
            strategy: parsed.strategy,
            name: parsed.name,
            servings: parsed.servings,
            ingredients: parsed.ingredients.length,
            instructions: parsed.instructions.length,
            warnings: parsed.warnings.length,
        };
        console.log(
            `[recipe_import_corpus] ok site=${entry.site} strategy=${parsed.strategy} ingredients=${parsed.ingredients.length} duration_ms=${result.durationMs}`,
        );
        return result;
    } catch (error) {
        const result: CorpusResult = {
            id: entry.id,
            site: entry.site,
            url: entry.url,
            ok: false,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof RecipeImportError
                ? { errorCode: error.code }
                : {}),
        };
        console.error(
            `[recipe_import_corpus] failed site=${entry.site} code=${result.errorCode ?? "unknown"} duration_ms=${result.durationMs} error=${result.error}`,
        );
        return result;
    }
}

const results: CorpusResult[] = [];
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
    requested: entries.length,
    passed: results.length - failures.length,
    failed: failures.length,
    unique_sites: new Set(entries.map((entry) => entry.site)).size,
    results,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exitCode = 1;
