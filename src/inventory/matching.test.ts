import { describe, expect, test } from "bun:test";
import {
    bestInventoryMatch,
    canonicalInventoryUnit,
    combineGroceryQuantities,
    convertInventoryQuantity,
    evaluateRecipeAvailability,
    groceryIdentityKey,
    inventoryUnitFamily,
    normalizeGroceryName,
    normalizeInventoryName,
    sameGroceryIdentity,
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

describe("grocery identity primitives", () => {
    test("inventoryUnitFamily collapses mass and volume to base units", () => {
        expect(inventoryUnitFamily("lb")).toEqual({ key: "mass", base: "g" });
        expect(inventoryUnitFamily("Grams")).toEqual({
            key: "mass",
            base: "g",
        });
        expect(inventoryUnitFamily("cups")).toEqual({
            key: "volume",
            base: "ml",
        });
        expect(inventoryUnitFamily(null)).toEqual({
            key: "unitless",
            base: null,
        });
        expect(inventoryUnitFamily("")).toEqual({
            key: "unitless",
            base: null,
        });
        expect(inventoryUnitFamily("each")).toEqual({
            key: "unit:count",
            base: "count",
        });
        expect(inventoryUnitFamily("gal")).toEqual({
            key: "unit:gal",
            base: "gal",
        });
    });

    test("normalizeGroceryName strips merchandising words but never empties", () => {
        expect(normalizeGroceryName("Fresh Organic Flour")).toBe("flour");
        expect(normalizeGroceryName("Crème Brûlée Mix")).toBe(
            "creme brulee mix",
        );
        // A name that is only a stripped modifier falls back to the plain
        // normalization so the DB nonempty constraint still holds.
        expect(normalizeGroceryName("Fresh")).toBe("fresh");
        expect(normalizeGroceryName("!!!")).toBe("");
    });

    test("groceryIdentityKey is normalized name plus unit family", () => {
        expect(groceryIdentityKey({ name: "Flour", unit: "lb" })).toBe(
            "flour|mass",
        );
        expect(groceryIdentityKey({ name: "Flour", unit: "g" })).toBe(
            "flour|mass",
        );
        expect(groceryIdentityKey({ name: "Flour", unit: "cup" })).toBe(
            "flour|volume",
        );
        expect(groceryIdentityKey({ name: "Rice" })).toBe("rice|unitless");
        expect(groceryIdentityKey({ name: "Onion", unit: "each" })).toBe(
            "onion|unit:count",
        );
        expect(groceryIdentityKey({ name: "!!!" })).toBeNull();
    });

    test("sameGroceryIdentity matches within a family and never across", () => {
        expect(
            sameGroceryIdentity(
                { name: "Fresh Flour", unit: "g" },
                { name: "Flour", unit: "lb" },
            ),
        ).toBe(true);
        expect(
            sameGroceryIdentity(
                { name: "Flour", unit: "cup" },
                { name: "Flour", unit: "g" },
            ),
        ).toBe(false);
        expect(
            sameGroceryIdentity(
                { name: "Milk", unit: "gal" },
                { name: "Milk", unit: null },
            ),
        ).toBe(false);
        expect(
            sameGroceryIdentity(
                { name: "Rice", unit: null },
                { name: "Rice", unit: undefined },
            ),
        ).toBe(true);
    });

    test("combineGroceryQuantities converts within a family into the existing unit", () => {
        // 500 g into a lb row: 1 + 500/453.59237 = 2.102
        expect(combineGroceryQuantities(1, "lb", 500, "g")).toBe(2.102);
        // 4 tbsp into a cup row: 1 + 0.25 = 1.25
        expect(combineGroceryQuantities(1, "cup", 4, "tbsp")).toBe(1.25);
        // Aliases/plurals canonicalize before combining.
        expect(combineGroceryQuantities(2, "cup", 1, "cups")).toBe(3);
        expect(combineGroceryQuantities(null, "g", 250, "g")).toBe(250);
        // Unitless folds with unitless.
        expect(combineGroceryQuantities(2, null, 3, null)).toBe(5);
    });

    test("combineGroceryQuantities refuses cross-family and unitless/unit-bearing pairs", () => {
        expect(combineGroceryQuantities(1, "cup", 500, "g")).toBeNull();
        expect(combineGroceryQuantities(1, "gal", 2, null)).toBeNull();
        expect(combineGroceryQuantities(2, null, 1, "gal")).toBeNull();
        expect(combineGroceryQuantities(1, "loaf", 2, "slices")).toBeNull();
    });
});
