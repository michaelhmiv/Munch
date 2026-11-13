import { describe, expect, test } from "bun:test";
import {
    bestInventoryMatch,
    canonicalInventoryUnit,
    convertInventoryQuantity,
    evaluateRecipeAvailability,
    normalizeInventoryName,
    crossFamilyInventoryUnits,
    greyBandMatchCandidates,
    isPantryGreyBandScore,
    type InventoryMatchableItem,
} from "./matching.js";

const inventory = [
    {
        id: "beef",
        name: "Ground Beef",
        normalized_name: "ground beef",
        quantity: 1.25,
        unit: "lb",
        quantity_mode: "exact" as const,
        stock_state: "available" as const,
        food_provider: null,
        provider_food_id: null,
    },
    {
        id: "avocado",
        name: "Avocados",
        normalized_name: "avocados",
        quantity: 2,
        unit: "whole",
        quantity_mode: "exact" as const,
        stock_state: "available" as const,
        food_provider: null,
        provider_food_id: null,
    },
    {
        id: "spinach",
        name: "Fresh Organic Spinach",
        normalized_name: normalizeInventoryName("Fresh Organic Spinach"),
        quantity: null,
        unit: null,
        quantity_mode: "presence_only" as const,
        stock_state: "low" as const,
        food_provider: null,
        provider_food_id: null,
    },
];

describe("inventory matching", () => {
    test("normalizes common merchandising words", () => {
        expect(
            normalizeInventoryName("Fresh Organic Yellow Onion - Large"),
        ).toBe("yellow onion");
    });

    test("normalizes unit aliases and converts compatible units", () => {
        expect(canonicalInventoryUnit("pounds")).toBe("lb");
        expect(convertInventoryQuantity(16, "oz", "lb")).toBeCloseTo(1, 6);
        expect(convertInventoryQuantity(1, "lb", "cup")).toBeNull();
    });

    test("finds generic food matches without requiring exact labels", () => {
        expect(
            bestInventoryMatch(inventory, { name: "ground beef" })?.item.id,
        ).toBe("beef");
        expect(
            bestInventoryMatch(inventory, { name: "spinach" })?.item.id,
        ).toBe("spinach");
    });

    test("ranks a recipe with only optional omissions as ready", () => {
        const result = evaluateRecipeAvailability(
            [
                { name: "Ground beef", quantity: 1, unit: "lb" },
                { name: "Avocado", quantity: 1, unit: "whole" },
                { name: "Parsley", optional: true },
                { name: "Salt" },
            ],
            inventory,
            ["salt", "pepper"],
        );
        expect(result.readiness).toBe("ready_now");
        expect(result.missing_required).toEqual([]);
        expect(result.missing_optional).toEqual(["Parsley"]);
    });

    test("calculates exact quantity shortages", () => {
        const result = evaluateRecipeAvailability(
            [{ name: "Ground beef", quantity: 2, unit: "lb" }],
            inventory,
        );
        expect(result.readiness).toBe("almost_there");
        expect(result.shortages).toEqual([
            { ingredient: "Ground beef", missing_quantity: 0.75, unit: "lb" },
        ]);
    });

    test("presence-only stock produces likely rather than exact readiness", () => {
        const result = evaluateRecipeAvailability(
            [{ name: "Spinach" }],
            inventory,
        );
        expect(result.readiness).toBe("likely_ready");
    });
});

describe("grey band candidates (seat B3)", () => {
    const mk = (
        over: Partial<InventoryMatchableItem>,
    ): InventoryMatchableItem => ({
        id: "x",
        name: "cheddar aged cheese",
        normalized_name: "cheddar aged cheese",
        quantity: 1,
        unit: "cup",
        quantity_mode: "exact",
        stock_state: "available",
        food_provider: null,
        provider_food_id: null,
        ...over,
    });
    test("band boundaries are inclusive at 0.50 and 0.75", () => {
        expect(isPantryGreyBandScore(0.5)).toBe(true);
        expect(isPantryGreyBandScore(0.75)).toBe(true);
        expect(isPantryGreyBandScore(0.499)).toBe(false);
        expect(isPantryGreyBandScore(0.751)).toBe(false);
    });
    test("grey candidates include unit-incompatible pairs (the seat must see them)", () => {
        const candidates = greyBandMatchCandidates([mk({})], {
            name: "cheddar cheese",
            quantity: 1,
            unit: "lb",
        });
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.unitsCompatible).toBe(false);
        expect(candidates[0]!.score).toBeCloseTo(0.667, 3);
        // ...while bestInventoryMatch still refuses them, as today.
        expect(
            bestInventoryMatch([mk({})], {
                name: "cheddar cheese",
                unit: "lb",
            }),
        ).toBeNull();
    });
    test("cross-family detection is mass vs volume only", () => {
        expect(crossFamilyInventoryUnits("lb", "cup")).toBe(true);
        expect(crossFamilyInventoryUnits("ml", "kg")).toBe(true);
        expect(crossFamilyInventoryUnits("lb", "oz")).toBe(false);
        expect(crossFamilyInventoryUnits("count", "cup")).toBe(false);
        expect(crossFamilyInventoryUnits(null, "cup")).toBe(false);
    });
});
