import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { formatRecipeQuantity } from "./quantity-format.js";

// Pantry-presence flags on the remaining add-decision surfaces
// (owner ruling, Nov 13): the recipe detail's ingredient rows —
// exercised on the real openRecipe lifted out of app.js with the
// dialog/api seams stubbed — plus wiring pins for the guided-plan
// preview row and the recipe grocery toast's skip counts.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extract(name: string): string {
    const match = source.match(
        new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`app.js function not found: ${name}`);
    return match[0];
}

function flagChunk() {
    const start = source.indexOf("const PANTRY_FLAG_CHECK_SVG");
    const end = source.indexOf("// Grocery rows render the same component");
    if (start < 0 || end < 0 || end <= start)
        throw new Error("pantry flag chunk not found in app.js");
    return source.slice(start, end);
}

const fullNutrients = { calories: 100, protein_g: 5, carbs_g: 10, fat_g: 2 };
function ingredient(
    name: string,
    pantry_flag: unknown,
): Record<string, unknown> {
    return {
        name,
        quantity: 1,
        unit: "cup",
        source_type: "usda",
        nutrients: fullNutrients,
        pantry_flag,
    };
}

const recipe = {
    id: "r1",
    name: "Flag Story",
    servings: 4,
    revision_id: "rev1",
    revision_number: 2,
    version: 1,
    nutrition_status: "complete",
    nutrition_per_serving: {
        calories: 300,
        protein_g: 10,
        carbs_g: 20,
        fat_g: 5,
    },
    instructions: ["Cook."],
    ingredients: [
        ingredient("Butter", {
            state: "have",
            pantry_item_id: "p-butter",
            pantry_name: "Butter",
        }),
        ingredient("Onion", {
            state: "listed",
            pantry_item_id: null,
            pantry_name: null,
        }),
        ingredient("Milk", {
            state: "none",
            pantry_item_id: null,
            pantry_name: null,
        }),
        ingredient("Rice", null),
    ],
};

async function renderRecipeDetail(): Promise<string> {
    let body = "";
    const context: Record<string, unknown> = {
        sourceLabels: { usda: "USDA" },
        sourceClasses: {},
        formatRecipeQuantity,
        featureFlags: () => ({ cooks: true, plan: true, groceries: true }),
        api: async () => ({ recipe }),
        openDialog: (_title: string, html: string) => {
            body = html;
        },
        dialog: { querySelector: () => null },
        recipeComposer: { ingredients: [], options: { clear: () => {} } },
    };
    runInNewContext(
        [
            extract("escapeHtml"),
            extract("number"),
            extract("sourceBadge"),
            extract("recipeIngredientResolved"),
            extract("recipeUnresolvedIngredients"),
            flagChunk(),
            "let recipeDetailActionsHtml = '';",
            "let recipeDetailRecipe = null;",
            "let recipeDetailSteps = [];",
            extract("recipeDetailActionsMarkup"),
            extract("recipeDetailHeaderActionsMarkup"),
            extract("recipeIngredientRowMarkup"),
            extract("recipeNutritionPanelMarkup"),
            extract("recipeGroceriesButtonMarkup"),
            extract("recipeDetailBodyMarkup"),
            extract("renderRecipeDetail"),
            // The extractor's regex drops the `async` keyword that
            // precedes the function name in app.js — restore it, or
            // the body's awaits do not parse.
            extract("openRecipe").replace(
                "function openRecipe(",
                "async function openRecipe(",
            ),
            "this.__open = openRecipe;",
        ].join("\n"),
        context,
    );
    await (context.__open as (id: string) => Promise<void>)("r1");
    return body;
}

describe("recipe detail ingredient flags", () => {
    test("each row carries its state — have, listed, none — before any tap", async () => {
        const body = await renderRecipeDetail();
        const rows = body.split("recipe-ingredient-row");
        const rowFor = (name: string) =>
            rows.find((row) => row.includes(`<strong>${name}</strong>`)) ?? "";
        expect(rowFor("Butter")).toContain("pantry-flag pantry-flag-have");
        expect(rowFor("Butter")).toContain("In your pantry");
        expect(rowFor("Onion")).toContain("pantry-flag pantry-flag-listed");
        expect(rowFor("Onion")).toContain("On your list");
        expect(rowFor("Milk")).toContain("pantry-flag pantry-flag-none");
        expect(rowFor("Milk")).toContain("Not in pantry");
    });

    test("a null flag (Pantry module off) renders no flag on the row", async () => {
        const body = await renderRecipeDetail();
        const riceRow =
            body
                .split("recipe-ingredient-row")
                .find((row) => row.includes("<strong>Rice</strong>")) ?? "";
        expect(riceRow).not.toContain("pantry-flag");
    });
});

describe("add-surface wiring", () => {
    test("the guided-plan preview row renders the same flag component", () => {
        expect(source).toContain(
            "${pantryFlagMarkup(item.pantry_flag)}<small>",
        );
    });

    test("the recipe grocery toast reports the pantry gate's skip counts", () => {
        const start = source.indexOf('form.id === "recipe-groceries-form"');
        expect(start).toBeGreaterThan(-1);
        const block = source.slice(start, start + 2600);
        expect(block).toContain("result.skipped_in_pantry");
        expect(block).toContain("already in your pantry");
        expect(block).toContain("result.skipped_on_list");
        expect(block).toContain("already on your list");
    });

    test("the shortfall add handlers never add an on-list row", () => {
        const single = source.indexOf('action === "shortfall-add"');
        expect(source.slice(single, single + 320)).toContain("!item.on_list");
        const all = source.indexOf('action === "shortfall-add-all"');
        expect(source.slice(all, all + 420)).toContain("!item.on_list");
    });
});
