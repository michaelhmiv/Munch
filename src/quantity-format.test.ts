import { describe, expect, test } from "bun:test";
import { formatRecipeQuantity as formatClientQuantity } from "../public/quantity-format.js";
import {
    formatRecipeQuantity,
    isRecipeVolumeUnit,
    recipeVolumeUnit,
} from "./quantity-format";

/**
 * The server twin of the one client formatter (public/quantity-
 * format.js) must never drift from it: this table — the same vectors
 * pinned client-side in public/quantity-format.test.ts — runs
 * through BOTH implementations and demands identical output.
 * Owner ruling (Michael, 2026-11-13): conventional US recipe
 * fractions for volume measures, ASCII mixed-number style.
 */
const QUANTITY_VECTORS: Array<
    [number | null, string | null | undefined, string | null]
> = [
    [0.25, "cup", "1/4"],
    [1 / 3, "cup", "1/3"],
    [0.5, "cup", "1/2"],
    [0.75, "cup", "3/4"],
    [2.5, "cup", "2 1/2"],
    [1.75, "cup", "1 3/4"],
    [0.4, "cup", "3/8"],
    [10.5, "cup", "10 1/2"],
    [12.25, "cup", "12 1/4"],
    [0, "cup", "0"],
    [null, "cup", null],
    [1, "cup", "1"],
    [2, "cups", "2"],
    [3, "tbsp", "3"],
    [0.333, "cup", "1/3"],
    [0.667, "cup", "2/3"],
    [1.333, "cup", "1 1/3"],
    [0.125, "tsp", "1/8"],
    [0.875, "cup", "7/8"],
    [0.2, "cup", "1/4"],
    [2.4, "cup", "2 3/8"],
    [0.0625, "cup", "1/8"],
    [0.9375, "cup", "1"],
    [0.99, "cup", "1"],
    [0.5, "tablespoons", "1/2"],
    [0.5, "Teaspoon", "1/2"],
    [0.5, "fluid ounces", "1/2"],
    [0.5, "fl oz", "1/2"],
    [1.5, "sticks", "1 1/2"],
    [0.75, "pints", "3/4"],
    [0.25, "quart", "1/4"],
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

describe("formatRecipeQuantity — server twin matches the pinned vectors", () => {
    for (const [value, unit, expected] of QUANTITY_VECTORS) {
        test(`${value} ${unit ?? "(no unit)"} → ${expected}`, () => {
            expect(formatRecipeQuantity(value, unit)).toBe(expected);
        });
    }
});

describe("client/server parity — one formatter, two runtimes", () => {
    test("identical output across the whole vector table", () => {
        for (const [value, unit] of QUANTITY_VECTORS) {
            expect(formatClientQuantity(value, unit)).toBe(
                formatRecipeQuantity(value, unit),
            );
        }
    });

    test("unit recognition agrees", () => {
        for (const unit of [
            "cup",
            "Cups",
            " tablespoon ",
            "fluid ounce",
            "sticks",
            "quart",
            "oz",
            "g",
            "whole",
            null,
            undefined,
        ]) {
            expect(isRecipeVolumeUnit(unit)).toBe(
                recipeVolumeUnit(unit) != null,
            );
        }
    });
});
