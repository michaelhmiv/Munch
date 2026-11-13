import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Tools-to-top audit §2/§5 (missed-work audit N3/N6): two approved
// placements that never landed. The Trends "+ Add a chart" tool sat
// after every chart card and the Digest; Today's Add water / Add
// weight lived only at the foot of the Daily-details aside and
// inside the cards' collapsible decompositions. Following
// public/pantry-drawdown.test.ts, the real builders are extracted
// from app.js and executed with stubbed view helpers, so the
// assertions run on the shipped templates, not copies.

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const cssSource = readFileSync(
    new URL("./app-overrides.css", import.meta.url),
    "utf8",
);

function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function chunkBetween(startMarker: string, endMarker: string): string {
    const start = appSource.indexOf(startMarker);
    const end = appSource.indexOf(endMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return appSource.slice(start, end);
}

function paintTrendsHtml(cards: Array<{ key: string; size: string }>): string {
    const chunk = chunkBetween(
        "function paintTrends",
        "async function renderTrends",
    );
    const content = { innerHTML: "" };
    const context: Record<string, unknown> = {
        content,
        escapeHtml,
        formatDate: (value: unknown) => String(value),
        state: {
            trendsEditing: false,
            trendsData: {
                cards,
                startDate: "2026-11-09",
                endDate: "2026-11-15",
            },
        },
        trendsRangeKey: () => "week",
        TRENDS_RANGE_TITLES: { week: "This week" },
        TRENDS_RANGES: [{ key: "week", label: "Week", days: 7 }],
        trendsCardMarkup: (card: { key: string }) =>
            `<section class="panel trends-card" data-card-key="${card.key}">chart</section>`,
        trendsDigestMarkup: () =>
            `<section class="panel trends-card trends-digest">digest</section>`,
    };
    runInNewContext(`${chunk}\nthis.__paint = paintTrends;`, context);
    (context.__paint as () => void)();
    return content.innerHTML;
}

test("Trends: the add-chart control sits in the heading row, before every card and the Digest (N3)", () => {
    const html = paintTrendsHtml([{ key: "alpha", size: "full" }]);

    // Exactly one add control, relabelled for the heading row, riding
    // in the actions group beside the Edit toggle.
    expect(html.match(/data-action="trends-add"/g)).toHaveLength(1);
    expect(html).toContain(">+ Chart</button>");
    expect(html).not.toContain("+ Add a chart");
    const actionsAt = html.indexOf('class="trends-actions"');
    const editAt = html.indexOf('data-action="trends-edit-toggle"');
    const addAt = html.indexOf('data-action="trends-add"');
    expect(actionsAt).toBeGreaterThanOrEqual(0);
    expect(editAt).toBeGreaterThan(actionsAt);
    expect(addAt).toBeGreaterThan(editAt);

    // The pin: the control precedes the first chart card in DOM
    // order, and precedes the Digest it used to sit below.
    expect(addAt).toBeLessThan(html.indexOf('data-card-key="alpha"'));
    expect(addAt).toBeLessThan(html.indexOf("trends-digest"));
});

test("Trends: an empty dashboard keeps the top add control and no longer points below", () => {
    const html = paintTrendsHtml([]);
    expect(html).toContain("Your dashboard is empty");
    expect(html).not.toContain("Add a chart below");
    expect(html.match(/data-action="trends-add"/g)).toHaveLength(1);
    expect(html.indexOf('data-action="trends-add"')).toBeLessThan(
        html.indexOf("trends-empty"),
    );
});

function loadMetricCard(): (
    label: string,
    value: unknown,
    unit: string,
    target: unknown,
    primary?: boolean,
    detail?: Record<string, unknown> | null,
) => string {
    const percentChunk = chunkBetween(
        "function percent(",
        "function sourceBadge",
    );
    const cardChunk = chunkBetween(
        "function metricCard(",
        "function metricDetailRow",
    );
    const context: Record<string, unknown> = {
        escapeHtml,
        number: (value: unknown, digits = 0) =>
            String(Number(Number(value ?? 0).toFixed(digits))),
    };
    runInNewContext(
        `${percentChunk}\n${cardChunk}\nthis.__metricCard = metricCard;`,
        context,
    );
    return context.__metricCard as never;
}

test("Today: Water and Weight cards carry their add button at the card head (N6)", () => {
    const metricCard = loadMetricCard();

    const water = metricCard("Water", 1250, " ml", 2500, false, {
        key: "today-water",
        targetLink: true,
        headAction: { action: "add-water", label: "Add water" },
        body: "<p>entries</p>",
    });
    expect(water).toContain('class="metric-head-add"');
    expect(water.match(/data-action="add-water"/g)).toHaveLength(1);
    expect(water).toContain('aria-label="Add water"');
    // The pin: the head button renders before — outside — the
    // collapsible decomposition the Add action used to hide inside.
    expect(water.indexOf('data-action="add-water"')).toBeLessThan(
        water.indexOf('id="metric-detail-today-water"'),
    );

    const weight = metricCard("Weight", 180, " lb", null, false, {
        key: "today-weight",
        headAction: { action: "add-weight", label: "Add weight" },
        body: "<p>entries</p>",
    });
    expect(weight.match(/data-action="add-weight"/g)).toHaveLength(1);
    expect(weight.indexOf('data-action="add-weight"')).toBeLessThan(
        weight.indexOf('id="metric-detail-today-weight"'),
    );
});

test("Today: the head add button is opt-in — cards without headAction render none", () => {
    const metricCard = loadMetricCard();
    const rangeWater = metricCard("Water", 5000, " ml", 17500, false, {
        key: "range-water",
        body: "<p>per-day rows</p>",
    });
    expect(rangeWater).not.toContain("metric-head-add");
    expect(rangeWater).toContain('data-action="toggle-metric-detail"');
    const plain = metricCard("Calories", 1800, " kcal", 2200, true);
    expect(plain).not.toContain("metric-head-add");
});

test("Today: renderToday wires the head actions into the Water and Weight cards", () => {
    const today = chunkBetween(
        "async function renderToday",
        "async function renderRangeToday",
    );
    expect(today).toContain(
        'headAction: { action: "add-water", label: "Add water" }',
    );
    expect(today).toContain(
        'headAction: { action: "add-weight", label: "Add weight" }',
    );
    // Both belong to the Daily-details summary grid, which renders
    // ahead of the entries lists the buttons used to sit under.
    expect(today.indexOf('headAction: { action: "add-water"')).toBeLessThan(
        today.indexOf("Hydration entries"),
    );
    expect(today.indexOf('headAction: { action: "add-weight"')).toBeLessThan(
        today.indexOf("Weight entries"),
    );
    // The aside's duplicate full-size pair is retired: with the head
    // buttons in place it was a second visible control with the same
    // name and action (the mobile e2e journeys resolve "Add water"
    // by role, and duplicate visible matches break them). The
    // in-detail copies stay — they live in waterMetricDetail /
    // weightMetricDetail, outside this chunk, inside the hidden
    // decomposition.
    expect(today).not.toContain(">Add water</button>");
    expect(today).not.toContain(">Add weight</button>");
});

test("tools-to-top styles: head-add and trends-actions exist; the parked bottom button's style is gone", () => {
    expect(cssSource).toContain(".trends-actions");
    expect(cssSource).toContain(".operate-view .metric-head-add");
    expect(cssSource).not.toContain(".trends-add {");
});
