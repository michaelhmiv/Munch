#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import { fetchRecipePage, RecipeImportError } from "../../src/recipe-import/fetch.js";
import { parseRecipeHtml } from "../../src/recipe-import/parser.js";

const [mode, first, second] = process.argv.slice(2);

function emit(value: Record<string, unknown>): void {
    console.log(JSON.stringify(value));
}

if (mode === "fetch") {
    if (!first || !second) throw new Error("usage: fetch <url> <output-path>");
    const started = performance.now();
    try {
        const page = await fetchRecipePage(first);
        await writeFile(second, page.html, "utf8");
        emit({
            ok: true,
            status: 200,
            final_url: page.finalUrl,
            duration_ms: Number((performance.now() - started).toFixed(2)),
            bytes: Buffer.byteLength(page.html),
        });
    } catch (error) {
        emit({
            ok: false,
            status: error instanceof RecipeImportError ? error.status : null,
            final_url: null,
            duration_ms: Number((performance.now() - started).toFixed(2)),
            bytes: 0,
            error: error instanceof Error ? error.message : String(error),
        });
    }
} else if (mode === "parse") {
    if (!first) throw new Error("usage: parse <html-path>");
    const started = performance.now();
    try {
        const html = await Bun.file(first).text();
        const parsed = parseRecipeHtml(html);
        emit({
            ok: true,
            duration_ms: Number((performance.now() - started).toFixed(2)),
            strategy: parsed.strategy,
            name: parsed.name,
            ingredients: parsed.ingredients.length,
            instructions: parsed.instructions.length,
            warnings: parsed.warnings.map((warning) => warning.code),
        });
    } catch (error) {
        emit({
            ok: false,
            duration_ms: Number((performance.now() - started).toFixed(2)),
            error: error instanceof Error ? error.message : String(error),
        });
    }
} else {
    throw new Error("usage: recipe-munch-bridge.ts <fetch|parse> ...");
}
