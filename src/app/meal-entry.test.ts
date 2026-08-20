import { describe, expect, test } from "bun:test";
import { scaleNutrients } from "./meal-entry.js";

describe("web meal entry nutrition", () => {
    test("scales every reported nutrient without inventing missing values", () => {
        expect(
            scaleNutrients(
                {
                    calories: 95,
                    protein_g: 3.2,
                    sodium_mg: 140,
                },
                1.5,
            ),
        ).toEqual({
            calories: 142.5,
            protein_g: 4.8,
            sodium_mg: 210,
        });
    });

    test("rejects a non-positive scale", () => {
        expect(() => scaleNutrients({ calories: 1 }, 0)).toThrow(
            "Nutrition scale must be positive",
        );
    });
});
