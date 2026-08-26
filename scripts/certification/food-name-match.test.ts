import { describe, expect, test } from "bun:test";
import { foodNameMatches } from "./food-name-match.js";

describe("production food corpus name matching", () => {
    test("accepts y-to-ies plurals", () => {
        expect(foodNameMatches("Strawberries, raw", ["strawberry"])).toBe(true);
        expect(foodNameMatches("Blueberries, raw", ["blueberry"])).toBe(true);
    });

    test("accepts ordinary plural forms", () => {
        expect(foodNameMatches("Carrots, raw", ["carrot"])).toBe(true);
        expect(foodNameMatches("Almonds", ["almond"])).toBe(true);
    });

    test("preserves multiword matching", () => {
        expect(foodNameMatches("Sweet potatoes, cooked", ["sweet potato"])).toBe(true);
        expect(foodNameMatches("Black beans, cooked", ["black bean"])).toBe(true);
        expect(foodNameMatches("Chocolate milk", ["milk"])).toBe(true);
    });

    test("rejects unrelated names", () => {
        expect(foodNameMatches("Candy coated chocolate", ["egg"])).toBe(false);
        expect(foodNameMatches("Milk chocolate", ["egg"])).toBe(false);
    });
});
