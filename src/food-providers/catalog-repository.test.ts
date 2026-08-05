import { describe, expect, test } from "bun:test";
import {
    hashCatalogIdentity,
    normalizeFoodText,
    validateCatalogCandidate,
} from "./catalog-repository.js";
import type { FoodCandidate } from "./types.js";

function candidate(overrides: Partial<FoodCandidate> = {}): FoodCandidate {
    return {
        provider: "open_food_facts",
        providerFoodId: "4099100316896",
        name: "Simply Nature Organic Graintastic",
        brand: "Simply Nature",
        barcode: "4099100316896",
        dataKind: "packaged",
        nutrientsPer100g: {
            calories: 244.444,
            protein_g: 13.333,
            carbs_g: 48.889,
            fat_g: 2.222,
            fiber_g: 11.111,
            sugar_g: 6.667,
            sodium_mg: 255.556,
        },
        portions: [
            {
                id: "serving",
                amount: 1,
                unit: "slice",
                label: "1 slice (45 g)",
                gramWeight: 45,
                nutrients: {
                    calories: 110,
                    protein_g: 6,
                    carbs_g: 22,
                    fat_g: 1,
                    fiber_g: 5,
                    sugar_g: 3,
                    sodium_mg: 115,
                },
            },
        ],
        sourceUpdatedAt: "2026-08-05T00:00:00.000Z",
        attribution: {
            label: "Open Food Facts",
            url: "https://world.openfoodfacts.org/product/4099100316896",
            license: "ODbL 1.0",
        },
        confidence: 0.9,
        raw: { code: "4099100316896" },
        ...overrides,
    };
}

describe("persistent food catalog helpers", () => {
    test("normalizes names and brands consistently", () => {
        expect(normalizeFoodText("  Simply—Nature   GRAINtastic ")).toBe(
            "simply nature graintastic",
        );
    });

    test("identity hashes are deterministic without exposing input", () => {
        const first = hashCatalogIdentity("4099100316896");
        expect(first).toBe(hashCatalogIdentity("4099100316896"));
        expect(first).not.toContain("4099100316896");
        expect(first).toHaveLength(64);
    });

    test("accepts the Simply Nature regression fixture", () => {
        expect(() => validateCatalogCandidate(candidate())).not.toThrow();
    });

    test("rejects negative nutrients instead of coercing them", () => {
        expect(() =>
            validateCatalogCandidate(
                candidate({ nutrientsPer100g: { calories: -1 } }),
            ),
        ).toThrow("Invalid nutrient value");
    });

    test("preserves missing nutrients as missing", () => {
        const value = candidate({ nutrientsPer100g: { calories: 110 } });
        validateCatalogCandidate(value);
        expect(value.nutrientsPer100g?.protein_g).toBeUndefined();
    });

    test("rejects malformed serving weights and barcodes", () => {
        expect(() =>
            validateCatalogCandidate(candidate({ barcode: "123" })),
        ).toThrow("Invalid barcode");
        const invalid = candidate();
        invalid.portions[0]!.gramWeight = Number.NaN;
        expect(() => validateCatalogCandidate(invalid)).toThrow(
            "Invalid portion gram weight",
        );
    });
});
