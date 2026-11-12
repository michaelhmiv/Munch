import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Next Up removal (plan-brain brief, Part 2): the standing
 * suggestion section is gone from Today — no panel, no fetch, no
 * action handlers, no "Ask about today" entry — and the single ad
 * slot keeps its place directly under the day summary panel. The
 * rest of Today is unchanged. These source assertions pin the
 * removal so the section cannot quietly grow back; rendered
 * behavior is covered by the packaged-app e2e (ad-slot position +
 * next-up absence in mobile-parity).
 */
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");

test("app.js carries no Next Up machinery", () => {
    // Behavior-bearing tokens only: identifiers, classes, testids,
    // and the endpoint. (Comments may still name the removed
    // section when documenting the removal itself.)
    expect(source).not.toContain("next-up");
    expect(source).not.toContain("nextUp");
    expect(source).not.toContain('data-testid="next-up"');
    expect(source).not.toContain("/api/app/guidance/next-up");
});

test("Today has no chat entry row (the brain lives on Plan, not Today)", () => {
    expect(source).not.toContain('chatEntryRow(\n        "today"');
    expect(source).not.toContain('chatEntryRow("today"');
    expect(source).not.toContain("Ask about today");
});

test("renderToday: macros panel, then the ad slot, then the dashboard grid", () => {
    const start = source.indexOf("async function renderToday() {");
    expect(start).toBeGreaterThan(-1);
    const render = source.slice(start, start + 6_000);
    const macrosAt = render.indexOf("todayMacrosPanel(data, goals)");
    const adAt = render.indexOf("todayAdSlotMarkup()");
    const gridAt = render.indexOf("dashboard-grid");
    expect(macrosAt).toBeGreaterThan(-1);
    expect(adAt).toBeGreaterThan(macrosAt);
    expect(gridAt).toBeGreaterThan(adAt);
    // The day itself is untouched: meals, water, weight, drafts,
    // and planned-today all still render.
    for (const marker of [
        "groupedMeals(data.meals)",
        "waterMetricDetail",
        "weightMetricDetail",
        "pendingDraftCard",
        "Planned today",
    ]) {
        expect(render).toContain(marker);
    }
});
