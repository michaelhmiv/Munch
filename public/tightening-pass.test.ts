import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/**
 * Tightening & hierarchy pass (approved 2026-11-21; audit package in
 * munch-evidence/tightening-audit-2026-11-21). Rearrangement and
 * spacing only — these tests pin the structural moves so they
 * cannot quietly revert:
 *  1. Today: the Water/Weight summary grid carries NO inline
 *     two-column style (ruling 1) — the stylesheet's single-column
 *     rows apply; the grid's panels compose Daily details, Meals
 *     (with Planned today at its foot), then the entry lists.
 *  2. Today + Plan: empty meal slots / empty days collapse to
 *     their header rows.
 *  3. Meal Plan: the "Today" chip (ruling 3) renders in the
 *     heading, marks today's group, and scrolls to it.
 *  4. Composer + Draft review: submit actions ride sticky bottom
 *     bars; the settings save bar sticks too (ruling 2), and the
 *     empty goal-change preview stays hidden until populated.
 */
const appJs = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const overrides = readFileSync(
    new URL("./app-overrides.css", import.meta.url),
    "utf8",
);
const accountSettings = readFileSync(
    new URL("./account-settings.css", import.meta.url),
    "utf8",
);
const pantryCss = readFileSync(
    new URL("./pantry.css", import.meta.url),
    "utf8",
);
const editorialCss = readFileSync(
    new URL("./editorial.css", import.meta.url),
    "utf8",
);

function extract(name: string): string {
    const match = appJs.match(
        new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`app.js function not found: ${name}`);
    return match[0];
}

function ruleBlock(css: string, selector: string): string {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`CSS rule not found: ${selector}`);
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    return css.slice(open, close + 1);
}

/** The tightening section sits at the end of app-overrides.css, so
 * for selectors that also have earlier base rules the LAST block is
 * the one that wins the cascade — and the one these tests pin. */
function lastRuleBlock(css: string, selector: string): string {
    const start = css.lastIndexOf(selector);
    if (start < 0) throw new Error(`CSS rule not found: ${selector}`);
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    return css.slice(open, close + 1);
}

describe("Today hierarchy", () => {
    const start = appJs.indexOf("async function renderToday() {");
    const render = appJs.slice(start, start + 10_000);

    test("the summary grid emits no inline grid-template-columns (ruling 1)", () => {
        expect(start).toBeGreaterThan(-1);
        expect(render).not.toContain("grid-template-columns");
        expect(render).toContain('<div class="summary-grid">');
    });

    test("panels compose Daily details + Meals on a lived day, entries last", () => {
        expect(render).toContain("${dailyDetailsPanel}${mealsSection}");
        expect(render).toContain("${mealsSection}${dailyDetailsPanel}");
        expect(render).toContain("${entriesPanel}");
        // Planned today rides at the foot of the Meals panel.
        expect(render).toContain("${mealsPanel}${plannedTodayBlock}");
        // The summary cards live in the Daily details panel.
        const detailsAt = render.indexOf("const dailyDetailsPanel");
        const waterAt = render.indexOf('metricCard("Water"');
        const entriesAt = render.indexOf("const entriesPanel");
        expect(detailsAt).toBeGreaterThan(-1);
        expect(waterAt).toBeGreaterThan(detailsAt);
        expect(entriesAt).toBeGreaterThan(waterAt);
    });

    test("Today's meal groups render with the empty-slot collapse on", () => {
        expect(render).toContain("groupedMeals(data.meals, true)");
    });
});

describe("groupedMeals empty-slot collapse", () => {
    const groupedMeals = runInNewContext(
        `${extract("groupedMeals")}; groupedMeals`,
        {
            mealCard: () => "<article>card</article>",
            number: (value: number) => String(Math.round(value)),
        },
    ) as (meals: unknown[], collapse?: boolean) => string;

    test("collapsed: an empty slot is its header row only", () => {
        const html = groupedMeals([], true);
        expect(html).toContain("No entries");
        expect(html).not.toContain("No lunch logged.");
        expect(html).not.toContain("No snack logged.");
        expect(html).not.toContain("meal-card");
    });

    test("default (History): the empty card still renders", () => {
        const html = groupedMeals([]);
        expect(html).toContain("No lunch logged.");
    });

    test("a logged meal still renders its card either way", () => {
        const meals = [{ meal_type: "lunch", calories: 400 }];
        expect(groupedMeals(meals, true)).toContain("<article>card</article>");
        expect(groupedMeals(meals, true)).toContain("400 kcal");
    });
});

describe("Meal Plan hierarchy", () => {
    test("empty days collapse — no 'No meals planned.' body remains", () => {
        expect(appJs).not.toContain("No meals planned.");
        expect(appJs).toContain('data-plan-today="true"');
    });

    test("the Today chip renders in the heading and scrolls to today's group (ruling 3)", () => {
        expect(appJs).toContain('data-action="plan-jump-today"');
        expect(appJs).toContain(">Today</button>");
        const handlerAt = appJs.indexOf('action === "plan-jump-today"');
        expect(handlerAt).toBeGreaterThan(-1);
        const handler = appJs.slice(handlerAt, handlerAt + 300);
        expect(handler).toContain('querySelector("[data-plan-today]")');
        expect(handler).toContain("scrollIntoView");
    });
});

describe("Composer + draft sticky bars", () => {
    test("meal type leads the composer form, ahead of Find foods", () => {
        const start = appJs.indexOf("function openMealComposer(");
        const form = appJs.slice(start, start + 6_000);
        const typeAt = form.indexOf("<span>Meal type</span>");
        const searchAt = form.indexOf("meal-composer-search");
        expect(typeAt).toBeGreaterThan(-1);
        expect(searchAt).toBeGreaterThan(typeAt);
    });

    test("Log food rides in the composer sticky bar", () => {
        expect(appJs).toContain(
            '<div class="composer-sticky-bar"><button class="button button-primary" type="submit">Log food</button></div>',
        );
        expect(
            ruleBlock(overrides, "#meal-form .composer-sticky-bar"),
        ).toContain("position: sticky");
    });

    test("draft review actions carry the sticky bar class", () => {
        expect(appJs).toContain("meal-draft-actions draft-sticky-bar");
        expect(
            ruleBlock(overrides, ".meal-draft-actions.draft-sticky-bar"),
        ).toContain("position: sticky");
    });
});

describe("Settings (ruling 2 + preview)", () => {
    test("the save bar is sticky at the page bottom", () => {
        const block = ruleBlock(accountSettings, ".settings-savebar");
        expect(block).toContain("position: sticky");
        expect(block).toContain("bottom: 0");
    });

    test("the goal-change preview stays hidden while empty", () => {
        expect(ruleBlock(overrides, "#goal-change-preview:empty")).toContain(
            "display: none",
        );
    });
});

describe("spacing values from the approved frames", () => {
    test("app overrides carry the tightened values", () => {
        expect(ruleBlock(overrides, ".today-view .meal-groups")).toContain(
            "gap: 2px",
        );
        expect(lastRuleBlock(overrides, ".meal-draft-review")).toContain(
            "gap: 9px",
        );
        expect(lastRuleBlock(overrides, ".trends-view .trends-card")).toContain(
            "padding: 12px 14px 10px",
        );
        expect(
            lastRuleBlock(overrides, ".recipes-view .recipe-panel"),
        ).toContain("padding: 6px 0 2px");
    });

    test("pantry spacing trims landed", () => {
        expect(pantryCss).toContain("padding: 8px 14px 40px");
        expect(lastRuleBlock(pantryCss, ".inventory-section {")).toContain(
            "padding-top: 10px",
        );
        expect(ruleBlock(pantryCss, ".planner-row")).toContain(
            "margin-top: 6px",
        );
    });

    test("editorial (homepage + connect) trims landed", () => {
        expect(ruleBlock(editorialCss, ".block")).toContain(
            "padding: 26px 0 8px",
        );
        expect(ruleBlock(editorialCss, ".cta")).toContain(
            "padding: 30px 0 34px",
        );
    });
});
