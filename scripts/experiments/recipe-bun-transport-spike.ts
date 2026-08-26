import { fetchRecipePage } from "../../src/recipe-import/fetch.js";
import { parseRecipeHtml } from "../../src/recipe-import/parser.js";
import { fetch as wreqFetch } from "node-wreq";

const targets = [
    { site: "Serious Eats", url: "https://www.seriouseats.com/foolproof-pan-pizza-recipe" },
    { site: "Simply Recipes", url: "https://www.simplyrecipes.com/recipes/banana_bread/" },
    { site: "Martha Stewart", url: "https://www.marthastewart.com/336138/basic-chicken-soup" },
    { site: "Food & Wine", url: "https://www.foodandwine.com/recipes/classic-beef-chili" },
    { site: "Maangchi", url: "https://www.maangchi.com/recipe/bibimbap" },
    { site: "Food52", url: "https://food52.com/recipes/27821-julia-child-s-coq-au-vin" },
] as const;

function munchParseSummary(html: string) {
    try {
        const parsed = parseRecipeHtml(html);
        return {
            parser_ok: true,
            parser_strategy: parsed.strategy,
            ingredient_count: parsed.ingredients.length,
            instruction_count: parsed.instructions.length,
        };
    } catch (error) {
        return {
            parser_ok: false,
            parser_error: error instanceof Error ? error.message : String(error),
        };
    }
}

for (const target of targets) {
    const row: Record<string, unknown> = { site: target.site, url: target.url };
    const nativeStart = performance.now();
    try {
        const page = await fetchRecipePage(target.url);
        row.native = {
            ok: true,
            ms: Number((performance.now() - nativeStart).toFixed(2)),
            bytes: Buffer.byteLength(page.html),
            ...munchParseSummary(page.html),
        };
    } catch (error) {
        row.native = {
            ok: false,
            ms: Number((performance.now() - nativeStart).toFixed(2)),
            error: error instanceof Error ? error.message : String(error),
        };
    }

    const wreqStart = performance.now();
    try {
        const response = await wreqFetch(target.url, {
            browser: "chrome_149",
            redirect: "follow",
            timeout: 5_000,
            throwHttpErrors: false,
        });
        const html = await response.text();
        row.wreq = {
            ok: response.ok,
            status: response.status,
            ms: Number((performance.now() - wreqStart).toFixed(2)),
            bytes: Buffer.byteLength(html),
            final_url: response.url,
            ...munchParseSummary(html),
        };
    } catch (error) {
        row.wreq = {
            ok: false,
            ms: Number((performance.now() - wreqStart).toFixed(2)),
            error: error instanceof Error ? error.message : String(error),
        };
    }

    row.rss_mb = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
    console.log(JSON.stringify(row));
}
