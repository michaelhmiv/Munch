import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { defaultMealType } from "./meal-slot.js";
import { formatRecipeQuantity } from "./quantity-format.js";

// Cross-work slice 4 (§4) — "From my pantry" on the log flows.
// The dialog builders are extracted from app.js and executed with
// stubbed view helpers, following public/recipes-library.test.ts:
// assertions run on the real templates, not on copies of them.

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");

// Main's recipe-log dialog renders its meal-type select through
// mealTypeOptionsHtml(defaultMealType(...)) (meal-slot law): the
// harness supplies the real helper chunk and the real
// defaultMealType so assertions run on the shipped templates.
const mealTypeHelpers = appSource.slice(
    appSource.indexOf("const MEAL_TYPE_OPTIONS"),
    appSource.indexOf("function number("),
);

function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

test("recipe log dialog separates servings cooked from servings eaten", () => {
    const start = appSource.indexOf("function openRecipeLog");
    const end = appSource.indexOf("function openRecipePlan");
    const chunk = appSource.slice(start, end);
    let body = "";
    const context: Record<string, unknown> = {
        escapeHtml,
        number: (value: unknown, digits = 0) =>
            String(Number(Number(value ?? 0).toFixed(digits))),
        featureFlags: () => ({ pantry: true }),
        formatRecipeQuantity,
        defaultMealType,
        state: { bootstrap: { profile: { timezone: "UTC" } } },
        openDialog: (_title: string, html: string) => {
            body = html;
        },
    };
    runInNewContext(
        `${mealTypeHelpers}\n${chunk}\nthis.__open = openRecipeLog;`,
        context,
    );
    const open = context.__open as (
        id: string,
        rev: string,
        options?: { fromPantryDefault?: boolean },
    ) => void;

    open("recipe-1", "rev-1");
    expect(body).toContain("From my pantry");
    expect(body).toContain("Servings cooked");
    expect(body).toContain("Servings eaten");
    expect(body).toContain('name="servings_cooked"');
    expect(body).toContain('name="servings_consumed"');
    // Library default: unchecked, cooked field hidden.
    expect(body).not.toContain('name="from_pantry" checked');
    expect(body).toContain("data-cooked-field hidden");

    open("recipe-1", "rev-1", { fromPantryDefault: true });
    // Guided-cook default: checked, cooked field visible.
    expect(body).toContain('name="from_pantry" checked');
    expect(body).not.toContain("data-cooked-field hidden");
});

test("pantry module off hides the option entirely", () => {
    const start = appSource.indexOf("function openRecipeLog");
    const end = appSource.indexOf("function openRecipePlan");
    const chunk = appSource.slice(start, end);
    let body = "";
    const context: Record<string, unknown> = {
        escapeHtml,
        number: (value: unknown, digits = 0) =>
            String(Number(Number(value ?? 0).toFixed(digits))),
        featureFlags: () => ({ pantry: false }),
        formatRecipeQuantity,
        defaultMealType,
        state: { bootstrap: { profile: { timezone: "UTC" } } },
        openDialog: (_title: string, html: string) => {
            body = html;
        },
    };
    runInNewContext(
        `${mealTypeHelpers}\n${chunk}\nthis.__open = openRecipeLog;`,
        context,
    );
    (context.__open as (id: string, rev: string) => void)("r", "rev");
    expect(body).not.toContain("from_pantry");
    expect(body).not.toContain("servings_cooked");
    // The log itself is untouched by the module being off.
    expect(body).toContain('name="servings_consumed"');
});

test("draw-down summary rows are data-shaped: used amount + remainder, skipped named", () => {
    const start = appSource.indexOf("function openRecipeLog");
    const end = appSource.indexOf("function openRecipePlan");
    const chunk = appSource.slice(start, end);
    const context: Record<string, unknown> = {
        escapeHtml,
        number: (value: unknown, digits = 0) =>
            String(Number(Number(value ?? 0).toFixed(digits))),
        featureFlags: () => ({ pantry: true }),
        formatRecipeQuantity,
        openDialog: () => {},
    };
    runInNewContext(
        `${chunk}\nthis.__summary = drawdownSummaryMarkup;`,
        context,
    );
    const summary = context.__summary as (d: unknown) => string;
    const html = summary({
        status: "applied",
        lines: [
            {
                ingredient: "Rice",
                pantry_name: "Rice",
                status: "applied",
                used_quantity: 2,
                used_unit: "cup",
                remainder_text: "about half left",
            },
            {
                ingredient: "Chicken breast",
                pantry_name: "Chicken",
                status: "applied",
                used_quantity: 1.5,
                used_unit: "lb",
                remainder_text: "likely gone",
            },
            {
                ingredient: "Butter",
                pantry_name: "Butter",
                status: "applied",
                used_quantity: 0.5,
                used_unit: "cup",
                remainder_text: "about half left",
            },
            {
                ingredient: "Saffron",
                pantry_name: null,
                status: "skipped",
                used_quantity: null,
                used_unit: null,
                remainder_text: "",
                reason: "not in pantry",
            },
        ],
    });
    expect(html).toContain("food-row");
    expect(html).toContain("Rice");
    expect(html).toContain("−2 cup · about half left");
    expect(html).toContain("−1.5 lb · likely gone");
    // Volume measures render as US recipe fractions (2026-11-13
    // ruling); weights like the lb line above stay decimal.
    expect(html).toContain("−1/2 cup · about half left");
    expect(html).toContain("Saffron");
    expect(html).toContain("Skipped · not in pantry");
});

test("cook entry points carry the checked default; library/detail buttons do not", () => {
    const cookFinish = appSource.indexOf("cook-mode-finish");
    const cookChunk = appSource.slice(cookFinish, cookFinish + 900);
    expect(cookChunk).toContain('data-from-pantry="1"');
    expect(appSource).toContain(
        'data-action=\"log-cook-dish\" data-from-pantry=\"1\"',
    );
    // The recipe detail View's Log recipe button has no such marker.
    const detailLog = appSource.indexOf(
        'data-action="log-recipe" data-id="${escapeHtml(recipe.id)}"',
    );
    expect(detailLog).toBeGreaterThan(-1);
});

test("meal composer carries the checkbox only while the pantry module is on", () => {
    const composerStart = appSource.indexOf("function openMealComposer");
    const composerChunk = appSource.slice(composerStart, composerStart + 2600);
    expect(composerChunk).toContain("featureFlags().pantry");
    expect(composerChunk).toContain('name="from_pantry"');
    expect(composerChunk).toContain("From my pantry");
    // Single foods: no extra servings field rides the composer.
    expect(composerChunk).not.toContain("servings_cooked");
});

test("both submit paths send from_pantry and surface the returned summary", () => {
    expect(appSource).toContain('from_pantry: values.from_pantry === "on"');
    expect(appSource).toContain("queueDrawdownSummary(result.drawdown)");
    expect(appSource).toContain("showPendingDrawdownSummary()");
});
