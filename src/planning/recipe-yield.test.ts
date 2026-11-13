import { describe, expect, test } from "bun:test";
import {
    convertYieldQuantity,
    effectiveRecipeYields,
    estimateRecipeYield,
    normalizeYieldUnit,
    parseFractionSpec,
    resolveRecipePortion,
    shareFractionLabel,
    validateYield,
    yieldUnitFamily,
    type RecipePortionContext,
    type YieldEstimateIngredient,
} from "./recipe-yield.js";

// Michael's Smoked Mac and Cheese as the resolver stored it
// (revision 2): gram weights are the per-ingredient resolved totals.
const macIngredients: YieldEstimateIngredient[] = [
    { quantity: 1, unit: "lb", gram_weight: 453.59 },
    { quantity: 4, unit: "tbsp", gram_weight: 56 },
    { quantity: 4, unit: "tbsp", gram_weight: 31 },
    { quantity: 3, unit: "cup", gram_weight: 732 },
    { quantity: 1, unit: "cup", gram_weight: 240 },
    { quantity: 12, unit: "oz", gram_weight: 340.19 },
    { quantity: 12, unit: "oz", gram_weight: 340.19 },
];

const macContext: RecipePortionContext = {
    servings: 12,
    yields: { volume: { quantity: 12, unit: "cup" }, weight: null },
    ingredients: macIngredients,
};

describe("yield units", () => {
    test("normalizes aliases and classifies families", () => {
        expect(normalizeYieldUnit("Cups")).toBe("cup");
        expect(normalizeYieldUnit("grams")).toBe("g");
        expect(normalizeYieldUnit("fluid ounces")).toBe(null);
        expect(yieldUnitFamily("tbsp")).toBe("volume");
        expect(yieldUnitFamily("fl oz")).toBe("volume");
        expect(yieldUnitFamily("lb")).toBe("weight");
        expect(yieldUnitFamily("slice")).toBe(null);
        expect(yieldUnitFamily("serving")).toBe(null);
    });

    test("converts exactly within a family and refuses across families", () => {
        expect(convertYieldQuantity(1, "cup", "tbsp")).toBeCloseTo(16, 9);
        expect(convertYieldQuantity(1, "cup", "fl oz")).toBeCloseTo(8, 9);
        expect(convertYieldQuantity(1, "cup", "ml")).toBeCloseTo(
            236.5882365,
            9,
        );
        expect(convertYieldQuantity(1, "lb", "oz")).toBeCloseTo(16, 9);
        expect(convertYieldQuantity(1, "lb", "g")).toBeCloseTo(453.59237, 9);
        expect(convertYieldQuantity(1, "cup", "g")).toBe(null);
        expect(convertYieldQuantity(200, "g", "ml")).toBe(null);
        expect(convertYieldQuantity(1, "slice", "g")).toBe(null);
    });

    test("validates a yield against its slot family", () => {
        expect(() =>
            validateYield("volume", { quantity: 12, unit: "cups" }),
        ).not.toThrow();
        expect(() =>
            validateYield("volume", { quantity: 12, unit: "g" }),
        ).toThrow(/volume yield/);
        expect(() =>
            validateYield("weight", { quantity: 0, unit: "g" }),
        ).toThrow(/positive/);
    });
});

describe("yield estimation (the deterministic ingredient-sum anchor)", () => {
    test("sums gram weights into both slots for the mac and cheese", () => {
        const estimate = estimateRecipeYield(macIngredients);
        // 453.59 + 56 + 31 + 732 + 240 + 340.19 + 340.19 = 2192.97
        expect(estimate.weight).toEqual({ quantity: 2193, unit: "g" });
        // 2192.97 ml = 9.2699 cups, snapped to the nearest quarter cup.
        expect(estimate.volume).toEqual({ quantity: 9.25, unit: "cup" });
    });

    test("uses quantity conversions when no gram weight was resolved", () => {
        const estimate = estimateRecipeYield([
            { quantity: 2, unit: "cup" },
            { quantity: 500, unit: "g" },
        ]);
        // volume: 473.176 ml + 500 g-as-ml = 973.176 ml → 4.113 cups → 4
        expect(estimate.volume).toEqual({ quantity: 4, unit: "cup" });
        // mass: 473.176 (cup-as-grams proxy) + 500 = 973.176 → 973
        expect(estimate.weight).toEqual({ quantity: 973, unit: "g" });
    });

    test("returns no estimate when nothing carries bulk", () => {
        expect(estimateRecipeYield([])).toEqual({
            volume: null,
            weight: null,
        });
        expect(
            estimateRecipeYield([{ quantity: null, unit: null }, {}]),
        ).toEqual({ volume: null, weight: null });
        expect(estimateRecipeYield([{ quantity: 2, unit: "pinch" }])).toEqual({
            volume: null,
            weight: null,
        });
    });

    test("effective yields prefer the set yield and label the source", () => {
        const effective = effectiveRecipeYields(
            { volume: { quantity: 12, unit: "cups" }, weight: null },
            macIngredients,
        );
        expect(effective.volume).toEqual({
            quantity: 12,
            unit: "cup",
            family: "volume",
            source: "set",
        });
        expect(effective.weight?.source).toBe("estimated");
        expect(effective.weight?.quantity).toBe(2193);
    });
});

describe("share resolution", () => {
    test("acceptance 1: every spelling of 1/12 resolves to the same share", () => {
        const byCup = resolveRecipePortion(macContext, {
            mode: "amount",
            amount: 1,
            unit: "cup",
        });
        const byFlOz = resolveRecipePortion(macContext, {
            mode: "amount",
            amount: 8,
            unit: "fl oz",
        });
        const byTbsp = resolveRecipePortion(macContext, {
            mode: "amount",
            amount: 16,
            unit: "tbsp",
        });
        const byMl = resolveRecipePortion(macContext, {
            mode: "amount",
            amount: 236.5882365,
            unit: "ml",
        });
        const byServing = resolveRecipePortion(macContext, {
            mode: "servings",
            servings: 1,
        });
        for (const resolved of [byFlOz, byTbsp, byMl, byServing]) {
            expect(resolved.factor).toBeCloseTo(byCup.factor, 12);
        }
        expect(byCup.factor).toBeCloseTo(1 / 12, 12);
        expect(byCup.record.share).toBe(0.083333);
        expect(byCup.record.servings_equivalent).toBe(1);
        expect(byCup.label).toBe("1 cup");
        expect(byCup.shareLabel).toBe("1/12");
        expect(byCup.record.yield_snapshot).toEqual({
            quantity: 12,
            unit: "cup",
            family: "volume",
            source: "set",
        });
    });

    test("amount labels use recipe fractions and plural units", () => {
        const resolved = resolveRecipePortion(macContext, {
            mode: "amount",
            amount: 2.5,
            unit: "cups",
        });
        expect(resolved.label).toBe("2 1/2 cups");
        const grams = resolveRecipePortion(
            {
                servings: 12,
                yields: {
                    volume: null,
                    weight: { quantity: 1800, unit: "g" },
                },
                ingredients: [],
            },
            { mode: "amount", amount: 200, unit: "g" },
        );
        expect(grams.label).toBe("200 g");
        expect(grams.factor).toBeCloseTo(200 / 1800, 12);
        expect(grams.record.yield_snapshot?.family).toBe("weight");
    });

    test("acceptance 2: fraction logging works with no yield at all", () => {
        const resolved = resolveRecipePortion(
            {
                servings: 8,
                yields: { volume: null, weight: null },
                ingredients: [],
            },
            parseFractionSpec({ value: "1/4" }),
        );
        expect(resolved.factor).toBe(0.25);
        expect(resolved.label).toBe("1/4 of the recipe");
        expect(resolved.shareLabel).toBe("1/4");
        expect(resolved.record.fraction_numerator).toBe(1);
        expect(resolved.record.fraction_denominator).toBe(4);
        expect(resolved.record.servings_equivalent).toBe(2);
        expect(resolved.record.yield_snapshot).toBe(null);
    });

    test("fraction keeps the exact numerator/denominator (1/3 never degrades)", () => {
        const fromString = parseFractionSpec({ value: "1/3" });
        expect(fromString).toEqual({
            mode: "fraction",
            value: 1 / 3,
            numerator: 1,
            denominator: 3,
        });
        const fromDecimal = parseFractionSpec({ value: 0.25 });
        expect(fromDecimal.numerator).toBe(1);
        expect(fromDecimal.denominator).toBe(4);
        const reduced = parseFractionSpec({ numerator: 2, denominator: 4 });
        expect(reduced.numerator).toBe(1);
        expect(reduced.denominator).toBe(2);
        const whole = resolveRecipePortion(macContext, {
            mode: "fraction",
            value: 1,
            numerator: 1,
            denominator: 1,
        });
        expect(whole.label).toBe("the whole recipe");
    });

    test("acceptance 6: cross-family amount is refused when the family has no yield", () => {
        // No stored yields and ingredients that carry no bulk → no
        // estimate either, so each family stands on its own.
        const bare: RecipePortionContext = {
            servings: 4,
            yields: { volume: { quantity: 6, unit: "cup" }, weight: null },
            ingredients: [{ quantity: null, unit: null }],
        };
        expect(() =>
            resolveRecipePortion(bare, {
                mode: "amount",
                amount: 200,
                unit: "g",
            }),
        ).toThrow(/no weight yield/);
        expect(
            resolveRecipePortion(bare, {
                mode: "amount",
                amount: 1,
                unit: "cup",
            }).factor,
        ).toBeCloseTo(1 / 6, 12);
        // A count/other unit is refused outright, never converted.
        expect(() =>
            resolveRecipePortion(bare, {
                mode: "amount",
                amount: 2,
                unit: "slices",
            }),
        ).toThrow(/not a volume or weight measure/);
    });

    test("amount against an estimated yield snapshots the estimate provenance", () => {
        const resolved = resolveRecipePortion(
            {
                servings: 12,
                yields: { volume: null, weight: null },
                ingredients: macIngredients,
            },
            { mode: "amount", amount: 1, unit: "cup" },
        );
        expect(resolved.record.yield_snapshot).toEqual({
            quantity: 9.25,
            unit: "cup",
            family: "volume",
            source: "estimated",
        });
        expect(resolved.factor).toBeCloseTo(1 / 9.25, 12);
    });

    test("shares above 1 are allowed (a double batch is a fact)", () => {
        const resolved = resolveRecipePortion(macContext, {
            mode: "amount",
            amount: 14,
            unit: "cup",
        });
        expect(resolved.factor).toBeCloseTo(7 / 6, 12);
        expect(resolved.shareLabel).toBe("7/6");
        expect(resolved.record.servings_equivalent).toBe(14);
    });

    test("servings mode preserves today's label language", () => {
        expect(
            resolveRecipePortion(macContext, {
                mode: "servings",
                servings: 1,
            }).label,
        ).toBe("1 serving");
        expect(
            resolveRecipePortion(macContext, {
                mode: "servings",
                servings: 2,
            }).label,
        ).toBe("2 servings");
    });

    test("share labels snap to simple fractions", () => {
        expect(shareFractionLabel(1 / 12)).toBe("1/12");
        expect(shareFractionLabel(0.5)).toBe("1/2");
        expect(shareFractionLabel(2)).toBe("2");
        expect(shareFractionLabel(0.0834)).toBe("0.083");
    });
});
