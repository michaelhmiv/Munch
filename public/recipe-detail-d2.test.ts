import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { formatRecipeQuantity } from "./quantity-format.js";

// Recipe detail, Option D2 (owner-approved 2026-11-13): actions at
// the top of the sheet, Edit / Archive as header utilities beside
// Close, per-serving nutrition as Today's macro tiles with a
// Micronutrients expand (fiber / sugar / sodium only), the grocery
// action at the Ingredients header, and edit-in-place. Exercised on
// the real render path lifted out of app.js with the dialog / api
// seams stubbed — the same harness shape as pantry-flag-surfaces.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const css = readFileSync(
    new URL("./app-overrides.css", import.meta.url),
    "utf8",
);

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

const fullNutrients = {
    calories: 100,
    protein_g: 5,
    carbs_g: 10,
    fat_g: 2,
};

function ingredient(
    name: string,
    nutrients: Record<string, number> | null,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        name,
        quantity: 1,
        unit: "cup",
        source_type: "usda",
        nutrients: nutrients ?? {},
        pantry_flag: null,
        ...extra,
    };
}

const perServing = {
    calories: 610.79,
    protein_g: 25.29,
    carbs_g: 31.43,
    fat_g: 42.86,
    fiber_g: 4.97,
    sugar_g: 3.21,
    sodium_mg: 790.72,
};

const resolvedRecipe = {
    id: "r-pot",
    name: "Cast-Iron Chicken Pot Pie",
    servings: 6,
    revision_id: "rev2",
    revision_number: 2,
    version: 3,
    nutrition_status: "complete",
    nutrition_per_serving: perServing,
    instructions: ["Heat the oven.", "Bake until deep golden."],
    ingredients: [
        ingredient("Chicken breast", fullNutrients),
        ingredient("Butter", fullNutrients, {
            pantry_flag: {
                state: "have",
                pantry_item_id: "p-butter",
                pantry_name: "Butter",
            },
        }),
    ],
};

const unavailableRecipe = {
    ...resolvedRecipe,
    id: "r-stew",
    name: "Pantry Stew",
    nutrition_status: "unavailable",
    nutrition_per_serving: {},
    ingredients: [
        ingredient("Zebra butter", null),
        ingredient("Zebra milk", null),
    ],
};

const partialRecipe = {
    ...resolvedRecipe,
    id: "r-partial",
    name: "Half-Matched Soup",
    nutrition_status: "partial",
    ingredients: [
        ingredient("Chicken breast", fullNutrients),
        ingredient("Unobtainium flakes", null),
    ],
};

interface Captured {
    title: string;
    body: string;
    headerActions: string;
}

async function render(recipe: Record<string, unknown>): Promise<{
    open: (id: string) => Promise<void>;
    edit: () => Promise<void>;
    calls: Captured[];
}> {
    const calls: Captured[] = [];
    const context: Record<string, unknown> = {
        sourceLabels: { usda: "USDA" },
        sourceClasses: {},
        formatRecipeQuantity,
        featureFlags: () => ({ cooks: true, plan: true, groceries: true }),
        api: async () => ({ recipe }),
        openDialog: (
            title: string,
            html: string,
            _actions: string,
            headerActions: string,
        ) => {
            calls.push({
                title,
                body: html,
                headerActions: headerActions ?? "",
            });
        },
        dialog: { querySelector: () => null },
        toast: () => {},
        calculateRecipeNutrition: async () => ({ healed: true }),
        recipeComposer: { ingredients: [], options: { clear: () => {} } },
    };
    runInNewContext(
        [
            extract("escapeHtml"),
            extract("number"),
            extract("sourceBadge"),
            extract("recipeIngredientResolved"),
            extract("recipeUnresolvedIngredients"),
            extract("recipeIngredientFromRecord"),
            flagChunk(),
            "let recipeDetailActionsHtml = '';",
            "let recipeDetailRecipe = null;",
            "let recipeDetailSteps = [];",
            "const recipeHealAttempts = new Set();",
            extract("recipeDetailActionsMarkup"),
            extract("recipeDetailHeaderActionsMarkup"),
            extract("recipeIngredientRowMarkup"),
            extract("recipeNutritionPanelMarkup"),
            extract("recipeGroceriesButtonMarkup"),
            extract("recipeDetailBodyMarkup"),
            extract("recipeDetailIngredientEditRowsMarkup"),
            extract("recipeDetailStepEditRowsMarkup"),
            extract("recipeDetailEditBodyMarkup"),
            extract("renderRecipeDetail"),
            // The extractor's regex drops the `async` keyword that
            // precedes the function name in app.js — restore it, or
            // the bodies' awaits do not parse.
            extract("enterRecipeDetailEdit").replace(
                "function enterRecipeDetailEdit(",
                "async function enterRecipeDetailEdit(",
            ),
            extract("openRecipe").replace(
                "function openRecipe(",
                "async function openRecipe(",
            ),
            "this.__open = openRecipe;",
            "this.__edit = enterRecipeDetailEdit;",
        ].join("\n"),
        context,
    );
    return {
        open: context.__open as (id: string) => Promise<void>,
        edit: context.__edit as () => Promise<void>,
        calls,
    };
}

function actionsRow(body: string): string {
    const start = body.indexOf("recipe-detail-actions");
    const end = body.indexOf("nutrition-label");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return body.slice(start, end);
}

describe("D2 header utilities", () => {
    test("Edit and Archive ride in the header as .header-util, Edit first", async () => {
        const { open, calls } = await render(resolvedRecipe);
        await open("r-pot");
        const header = calls[0].headerActions;
        expect(header).toContain('data-action="edit-recipe-detail"');
        expect(header).toContain('data-action="archive-recipe"');
        expect(header.split("header-util")).toHaveLength(3);
        expect(header.indexOf("edit-recipe-detail")).toBeLessThan(
            header.indexOf("archive-recipe"),
        );
        expect(header).toContain(">Edit</button>");
        expect(header).toContain(">Archive</button>");
        // Neither utility leaks into the body or the action row.
        expect(calls[0].body).not.toContain("archive-recipe");
        expect(calls[0].body).not.toContain("edit-recipe-detail");
    });

    test("the header-util style carries the ≥44px overlay hit area", () => {
        expect(css).toContain(".header-util {");
        const rule = css.slice(css.indexOf(".header-util {"));
        expect(rule.slice(0, 900)).toContain("height: 31px");
        expect(css).toContain(".header-util::after");
        expect(css).toContain("inset: -7px -4px");
    });
});

describe("D2 top action row", () => {
    test("resolved: Start cook is primary; no Calculate; short labels", async () => {
        const { open, calls } = await render(resolvedRecipe);
        await open("r-pot");
        const body = calls[0].body;
        const row = actionsRow(body);
        expect(row).toContain('data-action="start-recipe-cook"');
        expect(row).toContain("button button-primary");
        expect(row).toContain(">Start cook</button>");
        expect(row).toContain('data-action="log-recipe"');
        expect(row).toContain(">Log recipe</button>");
        expect(row).toContain('data-action="plan-recipe"');
        expect(row).toContain(">+ Plan</button>");
        expect(row).not.toContain("Add to plan");
        expect(row).not.toContain("calculate-recipe-nutrition");
        // Order: Start cook, Log recipe, + Plan.
        expect(row.indexOf("start-recipe-cook")).toBeLessThan(
            row.indexOf("log-recipe"),
        );
        expect(row.indexOf("log-recipe")).toBeLessThan(
            row.indexOf("plan-recipe"),
        );
        // The row sits under the meta line, above the nutrition.
        expect(body.indexOf("recipe-meta")).toBeLessThan(
            body.indexOf("recipe-detail-actions"),
        );
    });

    test("unavailable: Calculate is primary and Start cook steps down", async () => {
        const { open, calls } = await render(unavailableRecipe);
        await open("r-stew");
        const row = actionsRow(calls[0].body);
        expect(row).toContain('data-action="calculate-recipe-nutrition"');
        expect(row).toContain(">Calculate nutrition</button>");
        const calculateTag = row.slice(
            row.indexOf("<button"),
            row.indexOf(">", row.indexOf("<button")),
        );
        expect(calculateTag).toContain("button-primary");
        const cookStart = row.indexOf('data-action="start-recipe-cook"');
        const cookTag = row.slice(
            row.lastIndexOf("<button", cookStart),
            row.indexOf(">", cookStart),
        );
        expect(cookTag).toContain("button-secondary");
        expect(cookTag).not.toContain("button-primary");
        // Calculate leads the row.
        expect(row.indexOf("calculate-recipe-nutrition")).toBeLessThan(
            row.indexOf("start-recipe-cook"),
        );
    });

    test("partial: Calculate appears alongside the tiles", async () => {
        const { open, calls } = await render(partialRecipe);
        await open("r-partial");
        const body = calls[0].body;
        expect(body).toContain('data-action="calculate-recipe-nutrition"');
        expect(body).toContain("macro-tile");
        expect(body).toContain("Calculated from 1 of 2 ingredients.");
    });

    test("the grocery action sits at the Ingredients header, not in the row", async () => {
        const { open, calls } = await render(resolvedRecipe);
        await open("r-pot");
        const body = calls[0].body;
        expect(actionsRow(body)).not.toContain("recipe-groceries");
        const head = body.indexOf("recipe-section-head");
        const button = body.indexOf('data-action="recipe-groceries"');
        const list = body.indexOf("recipe-ingredients");
        expect(head).toBeGreaterThan(-1);
        expect(button).toBeGreaterThan(head);
        expect(button).toBeLessThan(list);
        expect(body).toContain(">+ Grocery list</button>");
    });
});

describe("D2 nutrition label", () => {
    test("four macro tiles with per-serving values", async () => {
        const { open, calls } = await render(resolvedRecipe);
        await open("r-pot");
        const body = calls[0].body;
        expect(body).toContain("Nutrition · per serving");
        expect(body.split('macro-tile"').length - 1).toBe(4);
        expect(body).toContain("Calories");
        expect(body).toContain("Protein");
        expect(body).toContain("Carbohydrates");
        expect(body).toContain("Fat");
        expect(body).toContain("611");
        expect(body).toContain("25.3");
        expect(body).toContain(">per serving</span>");
        expect(body).toContain(
            "Per-serving nutrition is calculated from the ingredient source snapshots pinned to this revision.",
        );
    });

    test("micronutrients start collapsed and carry only fiber, sugar, sodium", async () => {
        const { open, calls } = await render(resolvedRecipe);
        await open("r-pot");
        const body = calls[0].body;
        expect(body).toContain('data-action="toggle-recipe-micros"');
        expect(body).toContain('aria-expanded="false"');
        const microsStart = body.indexOf('<div class="macro-micros" hidden>');
        const micros = body.slice(
            microsStart,
            body.indexOf('<p class="recipe-note">', microsStart),
        );
        expect(microsStart).toBeGreaterThan(-1);
        expect(micros).toContain("Fiber");
        expect(micros).toContain("Sugar");
        expect(micros).toContain("Sodium");
        expect(micros).toContain("791 mg");
        expect(micros).not.toContain("Potassium");
        expect(micros).not.toContain("Calcium");
        expect(micros).not.toContain("Iron");
        expect(micros).not.toContain("Vitamin");
    });

    test("unavailable nutrition renders the labeled empty state, no tiles", async () => {
        const { open, calls } = await render(unavailableRecipe);
        await open("r-stew");
        const body = calls[0].body;
        expect(body).toContain("Nutrition · per serving");
        expect(body).toContain("nutrition-empty");
        expect(body).toContain("No per-serving nutrition yet");
        expect(body).not.toContain("macro-tile");
    });

    test("ingredient rows keep their pantry flags on the new sheet", async () => {
        const { open, calls } = await render(resolvedRecipe);
        await open("r-pot");
        const body = calls[0].body;
        const butterRow =
            body
                .split("recipe-ingredient-row")
                .find((row) => row.includes("<strong>Butter</strong>")) ?? "";
        expect(butterRow).toContain("pantry-flag pantry-flag-have");
        expect(butterRow).toContain("In your pantry");
    });
});

describe("D2 edit in place", () => {
    test("the same sheet's lists become editable rows; one form only", async () => {
        const { open, edit, calls } = await render(resolvedRecipe);
        await open("r-pot");
        await edit();
        expect(calls).toHaveLength(2);
        const body = calls[1].body;
        expect(body).toContain('id="recipe-detail-edit-form"');
        expect(body.split("<form")).toHaveLength(2);
        expect(body).not.toContain("<details");
        expect(body).not.toContain('id="recipe-edit-form"');
        // Save + Cancel ride at the top.
        expect(body).toContain(">Save new revision</button>");
        expect(body).toContain('data-action="cancel-recipe-detail-edit"');
        const row = actionsRow(body);
        expect(row).toContain("Save new revision");
        expect(row).toContain("Cancel");
        // Meta: Editing flag, servings input, next revision named.
        expect(body).toContain("editing-flag");
        expect(body).toContain(">Editing</span>");
        expect(body).toContain('name="servings"');
        expect(body).toContain('value="6"');
        expect(body).toContain("saving creates revision 3");
        // Ingredient rows are inputs in the same list, values live.
        expect(body).toContain('data-detail-field="name"');
        expect(body).toContain('value="Chicken breast"');
        expect(body).toContain('data-detail-field="quantity"');
        expect(body).toContain('data-detail-field="unit"');
        expect(body).toContain('data-action="add-recipe-detail-ingredient"');
        expect(body).toContain('data-action="add-recipe-detail-step"');
        // Steps are textareas with their text.
        expect(body).toContain("data-detail-step");
        expect(body).toContain("Bake until deep golden.");
        // Tiles stay as the reference, marked as recalculating.
        expect(body).toContain("recalculates on save");
        expect(body).not.toContain("toggle-recipe-micros");
        // Edit mode shows no header utilities (Close only).
        expect(calls[1].headerActions).toBe("");
    });

    test("the old second-form edit surface is gone from app.js", () => {
        expect(source).not.toContain("recipe-edit-details");
        expect(source).not.toContain("Edit recipe revision");
        expect(source).not.toContain("maybeAutoHealRecipe");
        expect(source).toContain('"recipe-detail-edit-form"');
    });
});
