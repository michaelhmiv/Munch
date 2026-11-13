import { describe, expect, test } from "bun:test";
import {
    formatRecipeQuantity,
    isRecipeVolumeUnit,
    recipeVolumeUnit,
} from "./quantity-format.js";

/**
 * Owner ruling (Michael, 2026-11-13): recipe-style volume quantities
 * display as conventional US recipe fractions — "1/3 cup", "2 1/2",
 * "1 3/4" — ASCII only, across the app. These vectors pin the style
 * character-for-character; the server twin (src/quantity-format.ts)
 * is pinned to the same table by src/quantity-format.test.ts.
 */
const QUANTITY_VECTORS: Array<
    [number | null, string | null | undefined, string | null]
> = [
    // The ruling's own examples and edges.
    [0.25, "cup", "1/4"],
    [1 / 3, "cup", "1/3"],
    [0.5, "cup", "1/2"],
    [0.75, "cup", "3/4"],
    [2.5, "cup", "2 1/2"],
    [1.75, "cup", "1 3/4"],
    [0.4, "cup", "3/8"], // nearest conventional value
    [10.5, "cup", "10 1/2"], // values ≥ 10 format the same way
    [12.25, "cup", "12 1/4"],
    [0, "cup", "0"], // zero untouched
    [null, "cup", null], // null untouched — caller keeps its empty state
    // Whole numbers stay whole.
    [1, "cup", "1"],
    [2, "cups", "2"],
    [3, "tbsp", "3"],
    // Snapping to halves, thirds, quarters, eighths.
    [0.333, "cup", "1/3"],
    [0.667, "cup", "2/3"],
    [1.333, "cup", "1 1/3"],
    [0.125, "tsp", "1/8"],
    [0.875, "cup", "7/8"],
    [0.2, "cup", "1/4"],
    [2.4, "cup", "2 3/8"],
    [0.0625, "cup", "1/8"], // exact 1/16 tie — 0 loses, never shows "0"
    [0.9375, "cup", "1"], // exact 15/16 tie — rounds up to the whole
    [0.99, "cup", "1"],
    // Unit aliases, case and plural spellings all count as volume.
    [0.5, "tablespoons", "1/2"],
    [0.5, "Teaspoon", "1/2"],
    [0.5, "fluid ounces", "1/2"],
    [0.5, "fl oz", "1/2"],
    [1.5, "sticks", "1 1/2"],
    [0.75, "pints", "3/4"],
    [0.25, "quart", "1/4"],
    // Weights, counts and unit-less quantities are NOT recipe
    // measures: null sends the caller back to its decimal formatting.
    [0.5, "oz", null],
    [0.5, "g", null],
    [0.5, "lb", null],
    [0.5, "kg", null],
    [0.5, "ml", null],
    [0.5, "serving", null],
    [0.5, "piece", null],
    [0.5, null, null],
    [0.5, undefined, null],
    [0.5, "", null],
    [Number.NaN, "cup", null],
];

describe("formatRecipeQuantity — owner-ruling vectors", () => {
    for (const [value, unit, expected] of QUANTITY_VECTORS) {
        test(`${value} ${unit ?? "(no unit)"} → ${expected}`, () => {
            expect(formatRecipeQuantity(value, unit)).toBe(expected);
        });
    }

    test("output is ASCII only — no unicode vulgar fractions", () => {
        for (const [value, unit] of QUANTITY_VECTORS) {
            const out = formatRecipeQuantity(value, unit);
            if (out != null) expect(/^[\x20-\x7E]*$/.test(out)).toBe(true);
        }
    });
});

describe("recipe volume unit recognition", () => {
    test("canonical units and aliases", () => {
        expect(recipeVolumeUnit("cup")).toBe("cup");
        expect(recipeVolumeUnit("Cups")).toBe("cup");
        expect(recipeVolumeUnit(" tablespoon ")).toBe("tbsp");
        expect(recipeVolumeUnit("fluid ounce")).toBe("fl oz");
        expect(recipeVolumeUnit("sticks")).toBe("stick");
        expect(isRecipeVolumeUnit("quart")).toBe(true);
    });

    test("weights and counts are not volume", () => {
        expect(recipeVolumeUnit("oz")).toBeNull();
        expect(recipeVolumeUnit("g")).toBeNull();
        expect(recipeVolumeUnit("whole")).toBeNull();
        expect(recipeVolumeUnit(null)).toBeNull();
        expect(isRecipeVolumeUnit(undefined)).toBe(false);
    });
});
