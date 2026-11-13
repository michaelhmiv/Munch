import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Water bottle presets (Michael, 2026-11-13): the Add water dialog
// leads with a 3×2 grid of one-tap bottle chips. A chip tap posts the
// converted ml to the existing water endpoint, closes the dialog,
// and confirms with the action toast — Undo deletes the entry just
// created. The manual form gains a unit dropdown (ml / fl oz) with
// fl oz the default; storage stays amount_ml. Following
// public/tools-to-top.test.ts, the real builders are extracted from
// app.js and executed with stubbed view helpers, so the assertions
// run on the shipped code, not copies.

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const patchesSource = readFileSync(
    new URL("./app-patches.js", import.meta.url),
    "utf8",
);
const cssSource = readFileSync(
    new URL("./app-overrides.css", import.meta.url),
    "utf8",
);

function fn(name: string) {
    return appSource.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))![0];
}

function number(value: unknown, digits = 0): string {
    if (value == null || Number.isNaN(Number(value))) return "—";
    return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: digits,
    }).format(Number(value));
}

const constDecl = appSource.match(/const WATER_ML_PER_FL_OZ = [^;]+;/)![0];

function waterContext(extra: Record<string, unknown> = {}) {
    return runInNewContext(
        constDecl +
            fn("waterOzToMl") +
            fn("waterBottlePresets") +
            fn("waterFormAmountMl") +
            fn("waterPresetChipsMarkup") +
            fn("addWaterDialogMarkup") +
            fn("updateWaterConvertHint") +
            "; ({ waterOzToMl, waterBottlePresets, waterFormAmountMl, waterPresetChipsMarkup, addWaterDialogMarkup, updateWaterConvertHint })",
        { number, ...extra },
    ) as {
        waterOzToMl: (oz: number) => number;
        waterBottlePresets: () => Array<{
            oz: number;
            ozLabel: string;
            ml: number;
        }>;
        waterFormAmountMl: (amount: unknown, unit: unknown) => number;
        waterPresetChipsMarkup: () => string;
        addWaterDialogMarkup: () => string;
        updateWaterConvertHint: (form: unknown) => void;
    };
}

const EXPECTED: Array<[number, string, number]> = [
    [12, "12", 355],
    [16.9, "16.9", 500],
    [20, "20", 591],
    [24, "24", 710],
    [32, "32", 946],
    [40, "40", 1183],
];

test("conversions: every preset oz lands on its exact stored ml", () => {
    const { waterOzToMl, waterBottlePresets } = waterContext();
    // 1 fl oz = 29.5735 ml, rounded to whole ml as the app displays.
    for (const [oz, , ml] of EXPECTED) {
        expect(waterOzToMl(oz)).toBe(ml);
    }
    expect(waterBottlePresets()).toEqual(
        EXPECTED.map(([oz, ozLabel, ml]) => ({ oz, ozLabel, ml })),
    );
});

test("dialog: the chip grid leads, above the manual form, no heading over it", () => {
    const { addWaterDialogMarkup } = waterContext();
    const html = addWaterDialogMarkup();
    // The grid is the first thing in the dialog body (no-filler law:
    // no heading or lead-in copy above the chips).
    expect(html.startsWith('<div class="preset-grid"')).toBe(true);
    expect(html.indexOf('class="preset-grid"')).toBeLessThan(
        html.indexOf('id="water-form"'),
    );
    expect(html).toContain(
        '<div class="form-divider"><span>Or enter an amount</span></div>',
    );
    // Six chips, each carrying its endpoint ml and both labels.
    expect(html.match(/data-action="water-preset"/g)).toHaveLength(6);
    for (const [, ozLabel, ml] of EXPECTED) {
        expect(html).toContain(`data-ml="${ml}" data-oz-label="${ozLabel}"`);
        expect(html).toContain(
            `<span class="oz">${ozLabel} oz</span><span class="ml">${number(ml)} ml</span>`,
        );
    }
});

test("dialog: manual form opens on fl oz / 12 with the stored-ml hint showing", () => {
    const { addWaterDialogMarkup } = waterContext();
    const html = addWaterDialogMarkup();
    expect(html).toContain("<span>Amount</span>");
    expect(html).not.toContain("Amount (milliliters)");
    expect(html).toContain('name="amount"');
    expect(html).toContain('value="12"');
    expect(html).toContain('<option value="oz" selected>fl oz</option>');
    expect(html).toContain('<option value="ml">ml</option>');
    // The hint is visible at open (fl oz is the default) and reads
    // exactly what will be stored for the opening value.
    expect(html).toContain('<p class="convert-hint">≈ 355 ml</p>');
    // Notes stays an unparsed personal-reference label.
    expect(html).toContain("<span>Notes</span>");
    expect(html).toContain('name="notes" placeholder="Optional"');
});

test("dialog: rejected pieces stay out — no My bottle, no flavored-drink copy", () => {
    const { addWaterDialogMarkup } = waterContext();
    const html = addWaterDialogMarkup().toLowerCase();
    expect(html).not.toContain("my bottle");
    expect(html).not.toContain("flavored");
    expect(html).not.toContain("finished a bottle");
});

test("manual conversion: oz converts, ml stores as typed, junk is NaN", () => {
    const { waterFormAmountMl } = waterContext();
    expect(waterFormAmountMl("12", "oz")).toBe(355);
    expect(waterFormAmountMl("16.9", "oz")).toBe(500);
    expect(waterFormAmountMl("40", "oz")).toBe(1183);
    expect(waterFormAmountMl("350", "ml")).toBe(350);
    expect(waterFormAmountMl("20000", "ml")).toBe(20000);
    expect(Number.isNaN(waterFormAmountMl("", "oz"))).toBe(true);
    expect(Number.isNaN(waterFormAmountMl("abc", "ml"))).toBe(true);
    expect(Number.isNaN(waterFormAmountMl(undefined, "oz"))).toBe(true);
});

test("hint: shows the stored ml in oz mode, hides in ml mode and when empty", () => {
    const { updateWaterConvertHint } = waterContext();
    const hint = { hidden: true, textContent: "" };
    const form = {
        elements: {
            amount: { value: "16.9" },
            unit: { value: "oz" },
        },
        querySelector: (selector: string) =>
            selector === ".convert-hint" ? hint : null,
    };
    updateWaterConvertHint(form);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe("≈ 500 ml");

    form.elements.unit.value = "ml";
    updateWaterConvertHint(form);
    expect(hint.hidden).toBe(true);

    form.elements.unit.value = "oz";
    form.elements.amount.value = "";
    updateWaterConvertHint(form);
    expect(hint.hidden).toBe(true);

    form.elements.amount.value = "40";
    updateWaterConvertHint(form);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe("≈ 1,183 ml");
});

test("chip action: posts the chip ml, toasts with Undo, Undo deletes the created entry", () => {
    const start = appSource.indexOf('action === "water-preset"');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = appSource.slice(start, start + 1800);
    // Posts exactly the chip's converted ml to the existing endpoint.
    expect(block).toContain("Number(button.dataset.ml)");
    expect(block).toContain('api("/api/app/water", {');
    expect(block).toContain("body: JSON.stringify({ amount_ml: amountMl })");
    // Closes and refreshes before confirming.
    expect(block).toContain("closeAppDialog()");
    expect(block).toContain("renderRoute()");
    // The confirmation is the action toast naming oz and stored ml.
    expect(block).toContain("toastAction(");
    expect(block).toContain(
        "`Water added — ${button.dataset.ozLabel} oz (${number(amountMl)} ml).`",
    );
    expect(block).toContain('"Undo"');
    // Undo is a real delete of the entry the POST returned.
    expect(block).toContain("result?.entry?.id");
    expect(block).toContain("`/api/app/water/${encodeURIComponent(entryId)}`");
    expect(block).toContain('method: "DELETE"');
});

test("wiring: add-water opens the new dialog; the form branch converts before posting", () => {
    const openStart = appSource.indexOf('action === "add-water"');
    expect(appSource.slice(openStart, openStart + 200)).toContain(
        'openDialog("Add water", addWaterDialogMarkup())',
    );

    const submitStart = appSource.indexOf('form.id === "water-form"');
    const submitBlock = appSource.slice(submitStart, submitStart + 500);
    expect(submitBlock).toContain(
        "amount_ml: waterFormAmountMl(values.amount, values.unit)",
    );
    expect(submitBlock).toContain('api("/api/app/water", {');
});

test("patches layer no longer shadows add-water (app.js owns the dialog)", () => {
    // Same removal pattern as duplicate-meal (491c37d): the capture-
    // phase stub showed the old ml-only form and starved app.js.
    expect(patchesSource).not.toContain('"add-water"');
    expect(patchesSource).not.toContain('id="water-form"');
    // The neighboring intercepts are untouched.
    expect(patchesSource).toContain('"edit-meal"');
    expect(patchesSource).toContain('"add-weight"');
});

test("css: chips draw 54px; the manual controls draw 31px at 76px wide", () => {
    const chip = cssSource.match(/\.preset-chip \{[^}]*\}/)![0];
    expect(chip).toContain("min-height: 54px");
    expect(chip).toContain("border: 1px solid #8a7c63");
    expect(chip).toContain("border-radius: 10px");
    const input = cssSource.match(/\.amount-row \.amount-input \{[^}]*\}/)![0];
    expect(input).toContain("width: 76px");
    expect(input).toContain("height: 31px");
    const select = cssSource.match(/\.unit-select \{[^}]*\}/)![0];
    expect(select).toContain("height: 31px");
});
