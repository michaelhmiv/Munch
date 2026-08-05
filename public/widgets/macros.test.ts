// Behaviour tests for the shared macro-panel partial and for the import
// widget's alcohol gate.
//
// Widget code is inline template JS, so it has no import surface: `macros.js` is
// evaluated here the way the assembler splices it into a page — with the fmt/esc
// helpers each template supplies — and the caption strings are asserted against
// real values. Without this the wording is pinned by nothing at all.
import { test, expect } from "bun:test";

const SRC = "./public/widgets/src";

// The same fmt/esc every template defines before including macros.js.
function fmt(n: number, decimals?: number) {
    if (n == null || isNaN(n)) return "0";
    const r = decimals ? n.toFixed(decimals) : Math.round(n);
    return Number(r).toLocaleString();
}
const esc = (s: unknown) => String(s);

type Bits = { goalLine: string; over: boolean; pct: number | null };
type Macro = { key: string; direction?: string };
type Vals = Record<string, number | null>;
const macrosApi = await (async () => {
    const src = await Bun.file(`${SRC}/shared/macros.js`).text();
    // `document`/`window` are left undefined so the partial's delegated event
    // wiring (guarded by `typeof document`) stays out of the way.
    const factory = new Function(
        "fmt",
        "esc",
        `${src}\nreturn { macroBits, MACROS, macroPanel };`,
    );
    return factory(fmt, esc) as {
        macroBits: (
            m: Macro,
            vals: Record<string, number>,
            goal: Record<string, number> | null,
            wording?: { under?: string; over?: string },
        ) => Bits;
        MACROS: Macro[];
        macroPanel: (
            vals: Vals,
            goal?: Vals | null,
            wording?: { under?: string; over?: string },
            meals?: unknown[],
            opts?: { drinkUnit?: string },
        ) => string;
    };
})();

const macroOf = (key: string) => {
    const m = macrosApi.MACROS.find((x) => x.key === key);
    if (!m) throw new Error(`no MACROS entry for ${key}`);
    return m;
};
const line = (
    key: string,
    val: number,
    target: number | null,
    wording?: { under?: string; over?: string },
) =>
    macrosApi.macroBits(
        macroOf(key),
        { [key]: val },
        target === null ? null : { [key]: target },
        wording,
    ).goalLine;

// A ceiling is a limit to stay under, never a budget with something "left" in
// it — the wording a user trying to drink less reads as permission, and which
// says nothing at all averaged over a week.
test("a ceiling under its limit reads as being under it, not as budget left", () => {
    expect(line("alcohol_g", 0, 20)).toBe("limit 20 g · 20 g under");
    expect(line("sugar_g", 31.9, 45)).toBe("limit 45 g · 13.1 g under");
    expect(line("alcohol_g", 0, 20)).not.toContain("left");
});

test("a ceiling exceeded reads as over, and is flagged", () => {
    expect(line("sugar_g", 58.1, 45)).toBe("limit 45 g · 13.1 g over");
    expect(
        macrosApi.macroBits(
            macroOf("sugar_g"),
            { sugar_g: 58.1 },
            { sugar_g: 45 },
        ).over,
    ).toBe(true);
});

test("exactly at a ceiling is its own state, not '0 g under'", () => {
    expect(line("alcohol_g", 20, 20)).toBe("limit 20 g · at limit");
});

// The most likely alcohol limit there is. A floor of 0 stays meaningless.
test("a ceiling target of 0 is a real limit", () => {
    expect(line("alcohol_g", 0, 0)).toBe("limit 0 g · at limit");
    expect(line("alcohol_g", 5.2, 0)).toBe("limit 0 g · 5.2 g over");
    const b = macrosApi.macroBits(
        macroOf("alcohol_g"),
        { alcohol_g: 5.2 },
        { alcohol_g: 0 },
    );
    expect(b.over).toBe(true);
    // Percent of zero must not reach the caption as Infinity/NaN.
    expect(Number.isFinite(b.pct)).toBe(true);
});

test("a floor target of 0 is still no goal", () => {
    expect(line("protein_g", 40, 0)).toBe("no goal set");
    expect(line("protein_g", 40, null)).toBe("no goal set");
});

// Floors keep the wording they always had, including the caller override that
// trends uses for its averages.
test("floors are unchanged, and only floors take the wording override", () => {
    expect(line("protein_g", 145, 160)).toBe("of 160 g · 15 g left");
    expect(line("protein_g", 175, 160)).toBe("of 160 g · 15 g over");
    expect(line("protein_g", 145, 160, { under: "under" })).toBe(
        "of 160 g · 15 g under",
    );
    // A ceiling ignores it: "left" must not be reachable through the override.
    expect(line("sugar_g", 31.9, 45, { under: "left" })).toBe(
        "limit 45 g · 13.1 g under",
    );
});

// ---- interactive tiles: the accessible name -------------------------------
//
// `role="button"` makes a tile's children presentational, so the ring's own
// aria-label, the macro name and the goal caption all vanish from the
// accessibility tree. A tile that discloses something must therefore carry its
// value and goal state in its OWN name, or a screen-reader user hears the
// action and no numbers at all — while the static tile next to it reads them
// out in full. Verified against a real a11y-tree snapshot; pinned here.
const VALS = {
    calories: 2035,
    protein_g: 148,
    carbs_g: 205,
    fat_g: 74,
    fiber_g: 26.4,
    sugar_g: 58.2,
    alcohol_g: 12.5,
    water_ml: 2100,
};
const GOALS = {
    calories: 2200,
    protein_g: 160,
    carbs_g: 220,
    fat_g: 70,
    fiber_g: 30,
    sugar_g: 45,
    alcohol_g: 20,
    water_ml: 2500,
};
const MEALS = [
    { description: "Porridge", calories: 400, protein_g: 12, carbs_g: 60 },
];

// Every tile that is a button, by macro key → its accessible name.
function tileLabels(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of html.matchAll(
        /data-macro="([^"]+)"[^>]*aria-label="([^"]*)"/g,
    ))
        out[m[1]!] = m[2]!;
    return out;
}

test("an interactive tile names its value and goal state, then the action", () => {
    const labels = tileLabels(
        macrosApi.macroPanel(VALS, GOALS, undefined, MEALS),
    );
    expect(labels.calories).toBe(
        "Calories 2,035 kcal, of 2,200 kcal, 165 kcal left. Show the meals that contributed.",
    );
    expect(labels.carbs_g).toBe(
        "Carbs 205 g, of 220 g, 15 g left. Show fiber and sugar, and the meals that contributed.",
    );
});

// The panel trends builds: no meals, so carbs is a button only because of its
// sub-components — and its panel was fully static (fully readable) before.
test("a tile made interactive by sub-components alone still names its value", () => {
    const labels = tileLabels(macrosApi.macroPanel(VALS, GOALS));
    expect(Object.keys(labels)).toEqual(["carbs_g"]);
    expect(labels.carbs_g).toBe(
        "Carbs 205 g, of 220 g, 15 g left. Show fiber and sugar.",
    );
});

test("no goal is still a value, not a bare action", () => {
    const labels = tileLabels(
        macrosApi.macroPanel(VALS, null, undefined, MEALS),
    );
    expect(labels.protein_g).toBe(
        "Protein 148 g, no goal set. Show the meals that contributed.",
    );
});

// A regression net over every shape the panel can take: whatever the wording
// ends up being, the number must be in the name.
test("every interactive tile carries its formatted value, and none is spoken as '·'", () => {
    const cases: Array<[Vals, Vals | null, { under?: string } | undefined]> = [
        [VALS, GOALS, undefined],
        [VALS, GOALS, { under: "under" }],
        [VALS, null, undefined],
        [{ ...VALS, fat_g: 0, calories: 4120 }, GOALS, undefined],
    ];
    for (const [vals, goal, wording] of cases) {
        const labels = tileLabels(
            macrosApi.macroPanel(vals, goal, wording, MEALS),
        );
        expect(Object.keys(labels).length).toBeGreaterThan(0);
        for (const [key, label] of Object.entries(labels)) {
            const m = macroOf(key) as Macro & { label: string; unit: string };
            // Hero and ring tiles — the only interactive ones — are whole
            // numbers, so the value reads exactly as it does on screen.
            expect(
                label.startsWith(`${m.label} ${fmt(vals[key]!, 0)} ${m.unit},`),
            ).toBe(true);
            // "·" is decoration a screen reader either skips or calls
            // "middle dot"; the spoken name separates with a comma.
            expect(label).not.toContain("·");
        }
    }
});

// The static tiles are the reason the button ones needed fixing — they were
// always readable, and must stay that way.
test("a static tile keeps its ring label and goal caption exposed", () => {
    const html = macrosApi.macroPanel(VALS, GOALS);
    expect(html).toContain('aria-label="Protein 148 g"');
    expect(html).toContain("of 160 g · 12 g left");
    // …and is not a button, so those children are not presentational.
    expect(html).not.toContain('data-macro="protein_g"');
});

// ---- import widget: the alcohol opt-in ------------------------------------
//
// The assembled importer is evaluated without its initWidget bootstrap so the
// mapping and row-building rules are exercised exactly as the host receives them.
const importWidget = await (async () => {
    const { getWidgetHtml } = await import("../../src/widgets");
    const html = await getWidgetHtml("import-meals");
    const script = html.slice(
        html.lastIndexOf("<script>") + "<script>".length,
        html.lastIndexOf("</script>"),
    );
    const boot = script.indexOf("initWidget({");
    if (boot === -1) throw new Error("import-meals bootstrap not found");
    const factory = new Function(
        `${script.slice(0, boot)}
         return {
             S,
             setDrinkUnit: (unit) => { CFG = Object.assign({}, CFG, { drink_unit: unit }); },
             autoMap,
             mappingView,
             buildRows,
         };`,
    );
    return factory() as {
        S: Record<string, any>;
        setDrinkUnit: (unit: string | null) => void;
        autoMap: () => void;
        mappingView: () => string;
        buildRows: () => boolean;
    };
})();

function prepareImport(
    headers: string[],
    row: string[],
    drinkUnit: string | null,
) {
    const widget = importWidget;
    widget.setDrinkUnit(drinkUnit);
    widget.S.table = {
        headers,
        rows: [row],
        sourceLines: [2],
        encoding: "utf-8",
        delimiter: ",",
        decimalSeparator: ".",
        warnings: [],
        skippedTotalsRows: 0,
        skippedBlankRows: 0,
    };
    widget.S.sourceApp = "";
    widget.S.dateFormat = "iso";
    widget.S.dateAmbiguous = false;
    widget.S.energyUnit = "kcal";
    widget.autoMap();
    return widget;
}

const WITH_ALCOHOL = [
    ["Date", "Food Name", "Energy (kcal)", "Alcohol (g)"],
    ["2026-07-18", "Pinot noir", "610", "17.4"],
] as const;
const NO_ALCOHOL = [
    ["Date", "Food Name", "Energy (kcal)", "Protein (g)"],
    ["2026-07-18", "Porridge", "310", "9.2"],
] as const;

test("a file with alcohol data explains the exclusion when tracking is off", () => {
    const widget = prepareImport(WITH_ALCOHOL[0], WITH_ALCOHOL[1], null);
    const html = widget.mappingView();
    expect(html).toContain("Alcohol column excluded");
    expect(html).toContain("Alcohol tracking is off");
    expect(html).toContain("will not be imported");
    expect(html).not.toContain("17.4");
    expect(html).not.toContain('data-field="alcohol_g"');

    expect(widget.buildRows()).toBe(true);
    expect(widget.S.rows[0]).not.toHaveProperty("alcohol_g");
});

test("tracking on exposes and serializes the alcohol column", () => {
    const widget = prepareImport(WITH_ALCOHOL[0], WITH_ALCOHOL[1], "us");
    const html = widget.mappingView();
    expect(html).not.toContain("Alcohol column excluded");
    expect(html).toContain('data-field="alcohol_g"');

    expect(widget.buildRows()).toBe(true);
    expect(widget.S.rows[0].alcohol_g).toBe(17.4);
});

test("no alcohol notice appears when the file has no alcohol column", () => {
    const widget = prepareImport(NO_ALCOHOL[0], NO_ALCOHOL[1], null);
    const html = widget.mappingView();
    expect(html).not.toContain("Alcohol column excluded");
    expect(html).not.toContain("Alcohol tracking is off");
});

test("the alcohol gate ignores polyols and ABV percentage columns", () => {
    const widget = prepareImport(
        ["Date", "Food Name", "Sugar Alcohols (g)", "ABV"],
        ["2026-07-18", "Protein bar", "4.1", "0"],
        null,
    );
    expect(widget.mappingView()).not.toContain("Alcohol column excluded");
});

test("the importer defaults to alcohol tracking off", async () => {
    const html = await Bun.file(`${SRC}/templates/import-meals.html`).text();
    const cfg = html.slice(html.indexOf("let CFG = {"));
    expect(cfg.slice(0, cfg.indexOf("};"))).toContain("drink_unit: null");
    expect(html).toContain(
        'CFG.drink_unit === "us" || CFG.drink_unit === "uk"',
    );
    expect(html).toContain("alcohol_g: alcoholTracked()");
});
