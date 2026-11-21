import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as repository from "./repository.js";
import { normalizeSavedFoodLabel } from "./repository.js";

describe("saved food labels", () => {
    test("normalizes case, accents, punctuation, and whitespace", () => {
        expect(normalizeSavedFoodLabel("  Café-au-Lait  Yogurt! ")).toBe(
            "cafe au lait yogurt",
        );
    });

    test("keeps deterministic words for uniqueness and lookup", () => {
        expect(normalizeSavedFoodLabel("My Usual PB&J")).toBe("my usual pb j");
        expect(normalizeSavedFoodLabel("my-usual   pb j")).toBe(
            "my usual pb j",
        );
    });
});

describe("recent meal item quantity (W2 Finding 1)", () => {
    // munch.meal_items stores quantity-scaled totals alongside the
    // logged quantity. The repository layer must carry BOTH raw values
    // (stored totals + raw quantity) so the app serializer can
    // normalize to per-quantity, exactly like Usuals do. Accessed via
    // the module namespace: on unmodified main the export does not
    // exist, which is the fail-before state.
    const recentMealItemFromRow = (repository as Record<string, unknown>)
        .recentMealItemFromRow as
        | ((row: Record<string, unknown>) => repository.RecentMealItemMemory)
        | undefined;

    test("recentMealItemFromRow preserves logged quantity alongside stored totals", () => {
        expect(typeof recentMealItemFromRow).toBe("function");
        const result = recentMealItemFromRow!({
            meal_id: "m1",
            item_id: "i1",
            name: "Greek yogurt",
            quantity: "2.000",
            portion_label: "1 cup",
            calories: "300.00",
            protein_g: "20.00",
            source_type: "usda",
            provider: "usda",
            provider_food_id: "123",
            confidence: "0.95",
            logged_at: "2026-11-10T12:00:00Z",
        });
        expect(result.quantity).toBe(2);
        // Nutrients stay the stored totals at this layer — no division.
        expect(result.nutrients).toEqual({ calories: 300, protein_g: 20 });

        const nullQuantity = recentMealItemFromRow!({
            meal_id: "m1",
            item_id: "i2",
            name: "Greek yogurt",
            quantity: null,
            portion_label: "1 cup",
            calories: "300.00",
            source_type: "usda",
            provider: "usda",
            provider_food_id: "123",
            confidence: null,
            logged_at: "2026-11-10T12:00:00Z",
        });
        expect(nullQuantity.quantity).toBeNull();
    });

    test("searchRecentMealItems and listRecentMealItems SQL queries select i.quantity", () => {
        const source = readFileSync(
            new URL("./repository.ts", import.meta.url),
            "utf8",
        );
        const searchStart = source.indexOf(
            "export async function searchRecentMealItems",
        );
        const listStart = source.indexOf(
            "export async function listRecentMealItems",
        );
        expect(searchStart).toBeGreaterThanOrEqual(0);
        expect(listStart).toBeGreaterThan(searchStart);
        expect(source.slice(searchStart, listStart)).toContain("i.quantity");
        expect(source.slice(listStart)).toContain("i.quantity");
    });
});
