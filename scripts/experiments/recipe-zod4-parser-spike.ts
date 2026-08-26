import { parseRecipeHtml } from "../../src/recipe-import/parser.js";
import { scrapeRecipe } from "recipe-scrapers";

const target = "https://www.loveandlemons.com/lemon-pasta/";
const response = await fetch(target, {
    headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "MunchRecipeImporter/1.0 (+https://munch.business)",
    },
});
if (!response.ok) throw new Error(`Love & Lemons returned HTTP ${response.status}`);
const html = await response.text();

let munch: Record<string, unknown>;
try {
    const parsed = parseRecipeHtml(html);
    munch = {
        ok: true,
        name: parsed.name,
        ingredients: parsed.ingredients.length,
        instructions: parsed.instructions.length,
    };
} catch (error) {
    munch = { ok: false, error: error instanceof Error ? error.message : String(error) };
}

const result: any = await scrapeRecipe(html, target, { safeParse: true });
const data = result?.data;
const ingredientGroups = Array.isArray(data?.ingredients) ? data.ingredients : [];
const ingredientCount = ingredientGroups.reduce((sum: number, group: any) => {
    const items = Array.isArray(group?.items) ? group.items : [];
    return sum + items.length;
}, 0);
const instructionGroups = Array.isArray(data?.instructions) ? data.instructions : [];
const instructionCount = instructionGroups.reduce((sum: number, group: any) => {
    const items = Array.isArray(group?.items) ? group.items : [];
    return sum + items.length;
}, 0);

console.log(JSON.stringify({
    target,
    munch,
    fallback: {
        success: result?.success ?? false,
        error: result?.error?.message ?? null,
        title: data?.title ?? null,
        ingredients: ingredientCount,
        instructions: instructionCount,
    },
    rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
}));
