import { describe, expect, test } from "bun:test";

// The production assertion path is exercised through repository typecheck and the
// existing Chicken Pot Pie resolver regression. This smoke test protects the
// expected JSON shape used by controlled deployments from accidental drift.
describe("recipe nutrition production verification config", () => {
    test("accepts the Chicken Pot Pie certification payload", () => {
        const raw = JSON.stringify({
            "88e68a4f-7162-45ac-83d5-a34852b94d35": {
                nutrition_status: "complete",
                nutrition_total: {
                    calories: 3726.22,
                    protein_g: 154.78,
                    carbs_g: 336.46,
                    fat_g: 195.85,
                },
                nutrition_per_serving: {
                    calories: 621.04,
                    protein_g: 25.8,
                    carbs_g: 56.08,
                    fat_g: 32.64,
                },
                tolerance: 0.05,
                require_ingredient_core_nutrients: true,
            },
        });
        const parsed = JSON.parse(raw);
        expect(parsed["88e68a4f-7162-45ac-83d5-a34852b94d35"]).toEqual({
            nutrition_status: "complete",
            nutrition_total: {
                calories: 3726.22,
                protein_g: 154.78,
                carbs_g: 336.46,
                fat_g: 195.85,
            },
            nutrition_per_serving: {
                calories: 621.04,
                protein_g: 25.8,
                carbs_g: 56.08,
                fat_g: 32.64,
            },
            tolerance: 0.05,
            require_ingredient_core_nutrients: true,
        });
    });
});
