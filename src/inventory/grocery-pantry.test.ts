import { describe, expect, test } from "bun:test";
import {
    attachPantryFlags,
    attachPantryMatches,
    isOnGroceryList,
    pantryFlagForItem,
    pantryMatchForGroceryItem,
} from "./grocery-pantry.js";
import { normalizeInventoryName } from "./matching.js";
import type { PantryItem } from "./repository.js";

function pantryItem(overrides: Partial<PantryItem>): PantryItem {
    const name = overrides.name ?? "Milk";
    return {
        id: "item-1",
        name,
        normalized_name: normalizeInventoryName(name),
        quantity: 1,
        unit: "gal",
        quantity_mode: "exact",
        stock_state: "available",
        location: "fridge",
        food_provider: null,
        provider_food_id: null,
        barcode: null,
        note: null,
        version: 1,
        updated_at: "2026-11-11T00:00:00.000Z",
        ...overrides,
    };
}

describe("grocery → pantry presence match", () => {
    test("an item listed in the pantry matches on presence alone", () => {
        const match = pantryMatchForGroceryItem({ name: "Milk" }, [
            pantryItem({}),
        ]);
        expect(match).toEqual({
            pantry_item_id: "item-1",
            pantry_name: "Milk",
        });
    });

    test("the match carries identity only — no amount, unit, or tier", () => {
        const match = pantryMatchForGroceryItem({ name: "Milk" }, [
            pantryItem({ quantity: 0.25, unit: "cup" }),
        ]);
        expect(match).not.toBeNull();
        expect(Object.keys(match!).sort()).toEqual([
            "pantry_item_id",
            "pantry_name",
        ]);
    });

    test("a low-stock pantry item still counts as present", () => {
        const match = pantryMatchForGroceryItem({ name: "Milk" }, [
            pantryItem({ stock_state: "low", quantity: 0.1, unit: "cup" }),
        ]);
        expect(match?.pantry_item_id).toBe("item-1");
    });

    test("a presence-only pantry item (no quantity tracked) matches", () => {
        const match = pantryMatchForGroceryItem({ name: "Soy sauce" }, [
            pantryItem({
                id: "item-2",
                name: "Soy sauce",
                quantity: null,
                unit: null,
                quantity_mode: "presence_only",
            }),
        ]);
        expect(match?.pantry_item_id).toBe("item-2");
    });

    test("a depleted pantry item is not present — no badge", () => {
        const match = pantryMatchForGroceryItem({ name: "Milk" }, [
            pantryItem({ stock_state: "depleted", quantity: 0 }),
        ]);
        expect(match).toBeNull();
    });

    test("an item absent from the pantry does not match", () => {
        const match = pantryMatchForGroceryItem({ name: "Eggs" }, [
            pantryItem({}),
        ]);
        expect(match).toBeNull();
    });

    test("name variants match the way the shared matcher scores them", () => {
        const match = pantryMatchForGroceryItem({ name: "milk" }, [
            pantryItem({ id: "item-3", name: "Whole Milk" }),
        ]);
        expect(match?.pantry_item_id).toBe("item-3");
    });

    test("a receipt-style brand-prefixed name matches a plain list name at the deterministic layer", () => {
        // The owner's case: the receipt stocked "HT Whole Milk", the
        // list just says "milk". Normalization + containment in the
        // shared matcher settles it (measured score 0.82) — no model
        // decision is involved anywhere in this module.
        const match = pantryMatchForGroceryItem({ name: "milk" }, [
            pantryItem({ id: "item-9", name: "HT Whole Milk" }),
        ]);
        expect(match?.pantry_item_id).toBe("item-9");
    });

    test("attachPantryMatches annotates every item, matched or not", () => {
        const items = attachPantryMatches(
            [{ name: "Milk" }, { name: "Eggs" }],
            [pantryItem({})],
        );
        expect(items[0]!.pantry_match?.pantry_item_id).toBe("item-1");
        expect(items[1]!.pantry_match).toBeNull();
    });

    test("an empty pantry (module off) matches nothing", () => {
        const items = attachPantryMatches([{ name: "Milk" }], []);
        expect(items[0]!.pantry_match).toBeNull();
    });
});

describe("on-list presence", () => {
    const open = [
        { name: "Onion", unit: "count" },
        { name: "Milk", unit: "gal" },
        { name: "Rice", unit: null },
    ];

    test("a name-and-unit match on the open list is listed", () => {
        expect(isOnGroceryList({ name: "onion", unit: "count" }, open)).toBe(
            true,
        );
        expect(isOnGroceryList({ name: "Milk", unit: "gal" }, open)).toBe(true);
    });

    test("a unit that cannot be the same measure is not listed", () => {
        expect(isOnGroceryList({ name: "Onion", unit: "cup" }, open)).toBe(
            false,
        );
    });

    test("a missing unit on either side still counts as listed", () => {
        expect(isOnGroceryList({ name: "Rice" }, open)).toBe(true);
        expect(isOnGroceryList({ name: "Milk" }, open)).toBe(true);
    });

    test("an absent name is not listed", () => {
        expect(isOnGroceryList({ name: "Flour", unit: "cup" }, open)).toBe(
            false,
        );
    });
});

describe("three-state pantry flag", () => {
    const pantry = [pantryItem({})]; // Milk, available
    const open = [{ name: "Onion", unit: null }];

    test("available stock flags have", () => {
        expect(pantryFlagForItem({ name: "Milk" }, pantry, open)).toEqual({
            state: "have",
            pantry_item_id: "item-1",
            pantry_name: "Milk",
        });
    });

    test("low stock still flags have — presence, never an amount", () => {
        const low = [
            pantryItem({ stock_state: "low", quantity: 0.1, unit: "cup" }),
        ];
        expect(pantryFlagForItem({ name: "Milk" }, low, []).state).toBe("have");
    });

    test("depleted stock flags none, not have", () => {
        const depleted = [pantryItem({ stock_state: "depleted", quantity: 0 })];
        expect(pantryFlagForItem({ name: "Milk" }, depleted, [])).toEqual({
            state: "none",
            pantry_item_id: null,
            pantry_name: null,
        });
    });

    test("absent from pantry and list flags none", () => {
        expect(pantryFlagForItem({ name: "Flour" }, pantry, open).state).toBe(
            "none",
        );
    });

    test("on the open list flags listed", () => {
        expect(pantryFlagForItem({ name: "Onion" }, pantry, open)).toEqual({
            state: "listed",
            pantry_item_id: null,
            pantry_name: null,
        });
    });

    test("listed outranks have at add moments — and keeps the pantry identity", () => {
        const flag = pantryFlagForItem({ name: "Milk" }, pantry, [
            { name: "Milk", unit: null },
        ]);
        expect(flag.state).toBe("listed");
        expect(flag.pantry_item_id).toBe("item-1");
        expect(flag.pantry_name).toBe("Milk");
    });

    test("the flag never carries an amount, whatever the state", () => {
        for (const flag of [
            pantryFlagForItem({ name: "Milk" }, pantry, open),
            pantryFlagForItem({ name: "Onion" }, pantry, open),
            pantryFlagForItem({ name: "Flour" }, pantry, open),
        ]) {
            expect(Object.keys(flag).sort()).toEqual([
                "pantry_item_id",
                "pantry_name",
                "state",
            ]);
        }
    });

    test("attachPantryFlags annotates every item with its state", () => {
        const flagged = attachPantryFlags(
            [{ name: "Milk" }, { name: "Onion" }, { name: "Flour" }],
            pantry,
            open,
        );
        expect(flagged.map((item) => item.pantry_flag.state)).toEqual([
            "have",
            "listed",
            "none",
        ]);
    });
});
