import { describe, expect, test } from "bun:test";
import {
    attachPantryMatches,
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
