import { describe, expect, test } from "bun:test";
import { canonicalizeFoodSearchQuery } from "./query-normalization.js";

describe("food search query canonicalization", () => {
    test.each([
        ["2 carrots ($0.50)", "2 carrots"],
        ["1 tbsp extra virgin olive oil, divided", "extra virgin olive oil"],
        ["2 cloves garlic, minced", "garlic"],
        ["½ cup yellow onion, diced", "yellow onion"],
        ["1/4 tsp black pepper, for serving", "black pepper"],
        ["3 cups spinach (chopped)", "spinach"],
    ])("removes recipe syntax from %s", (input, expected) => {
        expect(canonicalizeFoodSearchQuery(input)).toBe(expected);
    });

    test.each([
        "90% lean ground beef",
        "Simply Nature Grain-Tastic Organic Bread",
        "Coca-Cola Zero Sugar 12 oz",
        "7 Up Zero Sugar",
    ])("preserves food identity in %s", (input) => {
        expect(canonicalizeFoodSearchQuery(input)).toBe(input);
    });
});
