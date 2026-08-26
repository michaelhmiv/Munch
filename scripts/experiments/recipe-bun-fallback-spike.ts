import { fetchRecipePage } from "../../src/recipe-import/fetch.js";
import { parseRecipeHtml } from "../../src/recipe-import/parser.js";
import { fetch as wreqFetch } from "node-wreq";
import { scrapeRecipe } from "recipe-scrapers";

const targets = [
    { site: "Serious Eats", url: "https://www.seriouseats.com/foolproof-pan-pizza-recipe" },
    { site: "Simply Recipes", url: "https://www.simplyrecipes.com/recipes/banana_bread/" },
    { site: "Martha Stewart", url: "https://www.marthastewart.com/336138/basic-chicken-soup" },
    { site: "Food & Wine", url: "https://www.foodandwine.com/recipes/classic-beef-chili" },
    { site: "Maangchi", url: "https://www.maangchi.com/recipe/bibimbap" },
    { site: "Food52", url: "https://food52.com/recipes/27821-julia-child-s-coq-au-vin" },
    { site: "Love and Lemons", url: "https://www.loveandlemons.com/lemon-pasta/" },
] as const;

function parserSummary(html: string, url: string) {
    let munch: Record<string, unknown>;
    try {
        const parsed = parseRecipeHtml(html);
        munch = {
            ok: true,
            strategy: parsed.strategy,
            name: parsed.name,
            ingredients: parsed.ingredients.length,
            instructions: parsed.instructions.length,
        };
    } catch (error) {
        munch = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    let fallback: Record<string, unknown>;
    try {
        const result = scrapeRecipe(html, url, { safeParse: true }) as any;
        const data = result?.data ?? result?.value ?? result;
        const ingredientGroups = Array.isArray(data?.ingredients) ? data.ingredients : [];
        const ingredientCount = ingredientGroups.reduce((sum: number, group: any) => {
            if (Array.isArray(group?.items)) return sum + group.items.length;
            return sum + 1;
        }, 0);
        const instructions = Array.isArray(data?.instructions) ? data.instructions : [];
        fallback = {
            ok: result?.success !== false && !result?.error,
            result_keys: result && typeof result === "object" ? Object.keys(result) : [],
            data_keys: data && typeof data === "object" ? Object.keys(data) : [],
            name: data?.title ?? data?.name ?? null,
            ingredients: ingredientCount,
            instructions: instructions.length,
            error: result?.error?.message ?? null,
        };
    } catch (error) {
        fallback = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    return { munch, fallback };
}

for (const target of targets) {
    const row: Record<string, unknown> = { site: target.site, url: target.url };

    const nativeStart = performance.now();
    try {
        const page = await fetchRecipePage(target.url);
        row.native = {
            ok: true,
            ms: Math.round((performance.now() - nativeStart) * 100) / 100,
            bytes: Buffer.byteLength(page.html),
            ...parserSummary(page.html, target.url),
        };
    } catch (error) {
        row.native = {
            ok: false,
            ms: Math.round((performance.now() - nativeStart) * 100) / 100,
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
            ms: Math.round((performance.now() - wreqStart) * 100) / 100,
            bytes: Buffer.byteLength(html),
            final_url: response.url,
            timings: response.wreq?.timings ?? null,
            ...parserSummary(html, target.url),
        };
    } catch (error) {
        row.wreq = {
            ok: false,
            ms: Math.round((performance.now() - wreqStart) * 100) / 100,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    row.rss_mb = Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
    console.log(JSON.stringify(row));
}
