import { describe, expect, test } from "bun:test";
import {
    scanMealItem,
    scanRecipe,
    scanRecipeIngredient,
    type StoredIngredientRecord,
    type StoredMealItemRecord,
} from "./prefilter.js";

function ingredient(
    overrides: Partial<StoredIngredientRecord>,
): StoredIngredientRecord {
    return {
        name: "ingredient",
        quantity: 1,
        unit: null,
        gramWeight: 100,
        nutrients: { calories: 100, protein_g: 5, carbs_g: 10, fat_g: 4 },
        sourceSnapshot: {},
        ...overrides,
    };
}

describe("Pass 1 signature (i): assumed portion implausible (milk)", () => {
    test("catches the mac & cheese milk: assumed match, 61 g cup", () => {
        const milk = ingredient({
            name: "Whole Milk",
            quantity: 3,
            unit: "cup",
            gramWeight: 183,
            nutrients: { calories: 111.63 },
            sourceSnapshot: {
                automatic_nutrition: {
                    resolution: "assumed_provider_match",
                    provider_data_kind: "generic",
                    implied_grams_per_unit: 61,
                    portion_label: "Guideline amount per cup of hot cereal",
                },
            },
        });
        expect(scanRecipeIngredient(milk)).toContain(
            "assumed_portion_implausible",
        );
    });

    test("silent on a sane assumed match (244 g cup)", () => {
        const milk = ingredient({
            name: "Whole Milk",
            quantity: 3,
            unit: "cup",
            gramWeight: 732,
            nutrients: { calories: 446.52 },
            sourceSnapshot: {
                automatic_nutrition: {
                    resolution: "assumed_provider_match",
                    provider_data_kind: "generic",
                    implied_grams_per_unit: 244,
                },
            },
        });
        expect(scanRecipeIngredient(milk)).toEqual([]);
    });

    test("silent on a plain provider_match even at the same weight", () => {
        const milk = ingredient({
            name: "Whole Milk",
            quantity: 3,
            unit: "cup",
            gramWeight: 183,
            sourceSnapshot: {
                automatic_nutrition: {
                    resolution: "provider_match",
                    implied_grams_per_unit: 61,
                },
            },
        });
        expect(scanRecipeIngredient(milk)).toEqual([]);
    });
});

describe("Pass 1 signature (ii): packaged profile implausible (cheddar)", () => {
    test("catches packaged cheddar with double-digit sugar per 100 g", () => {
        // 12 oz (340 g) of cheddar carrying 48.65 g sugar = 14.3 g/100 g.
        const cheddar = ingredient({
            name: "Sharp Cheddar Cheese",
            quantity: 12,
            unit: "oz",
            gramWeight: 340,
            nutrients: { calories: 1370, sugar_g: 48.65 },
            sourceSnapshot: {
                automatic_nutrition: {
                    resolution: "provider_match",
                    provider_data_kind: "packaged",
                    provider_food_name: "Sharp Cheddar Cheese",
                },
            },
        });
        expect(scanRecipeIngredient(cheddar)).toContain(
            "packaged_profile_implausible",
        );
    });

    test("silent on a real packaged cheddar (trace sugar)", () => {
        const cheddar = ingredient({
            name: "Sharp Cheddar Cheese",
            quantity: 12,
            unit: "oz",
            gramWeight: 340,
            nutrients: { calories: 1370, sugar_g: 1.7 },
            sourceSnapshot: {
                automatic_nutrition: {
                    resolution: "provider_match",
                    provider_data_kind: "packaged",
                    provider_food_name: "Sharp Cheddar Cheese",
                },
            },
        });
        expect(scanRecipeIngredient(cheddar)).toEqual([]);
    });

    test("silent on sweet packaged food that is not a hard cheese", () => {
        const candy = ingredient({
            name: "Chocolate Hazelnut Spread",
            quantity: 2,
            unit: "tbsp",
            gramWeight: 37,
            nutrients: { calories: 200, sugar_g: 21 },
            sourceSnapshot: {
                automatic_nutrition: {
                    resolution: "provider_match",
                    provider_data_kind: "packaged",
                    provider_food_name: "Chocolate Hazelnut Spread",
                },
            },
        });
        expect(scanRecipeIngredient(candy)).toEqual([]);
    });
});

describe("Pass 1 signature (iii): unresolved in totals (flour) + partial", () => {
    test("catches an unresolved ingredient counted as zero", () => {
        const flour = ingredient({
            name: "All-Purpose Flour",
            quantity: 4,
            unit: "tbsp",
            gramWeight: null,
            nutrients: {},
            sourceSnapshot: {
                automatic_nutrition: {
                    resolution: "unresolved",
                    reason: "no_compatible_provider_portion",
                },
            },
        });
        expect(scanRecipeIngredient(flour)).toContain("unresolved_in_totals");
    });

    test("a partial recipe with no flagged row is still a suspect", () => {
        const scan = scanRecipe({
            nutritionStatus: "partial",
            ingredients: [ingredient({ name: "Rice" })],
        });
        expect(scan.suspect).toBe(true);
        expect(scan.recipeLevelSignatures).toContain("partial_recipe");
    });

    test("a clean complete recipe is not a suspect", () => {
        const scan = scanRecipe({
            nutritionStatus: "complete",
            ingredients: [
                ingredient({
                    name: "Olive Oil",
                    quantity: 2,
                    unit: "tbsp",
                    gramWeight: 27,
                    nutrients: { calories: 239 },
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "provider_match",
                            provider_data_kind: "generic",
                        },
                    },
                }),
            ],
        });
        expect(scan.suspect).toBe(false);
        expect(scan.flagged).toEqual([]);
    });
});

describe("Pass 1 signature (iv): meal items", () => {
    const item = (
        overrides: Partial<StoredMealItemRecord>,
    ): StoredMealItemRecord => ({
        name: "item",
        quantity: 1,
        portionLabel: null,
        gramWeight: 100,
        nutrients: { calories: 200 },
        ...overrides,
    });

    test("catches kcal/100 g above physical possibility (>900)", () => {
        const impossible = item({
            name: "Mystery Sauce",
            gramWeight: 50,
            nutrients: { calories: 500 }, // 1000 kcal/100 g
        });
        expect(scanMealItem(impossible).signatures).toContain(
            "meal_density_impossible",
        );
    });

    test("real olive oil at ~884 kcal/100 g is NOT flagged", () => {
        const oil = item({
            name: "Olive Oil",
            portionLabel: "1 tbsp",
            gramWeight: 13.5,
            nutrients: { calories: 119 },
        });
        expect(scanMealItem(oil).signatures).toEqual([]);
    });

    test("catches a 61 g 'cup' meal item (milk signature in a meal)", () => {
        const milk = item({
            name: "Whole Milk",
            portionLabel: "1 cup",
            gramWeight: 61,
            nutrients: { calories: 37 },
        });
        expect(scanMealItem(milk).signatures).toContain(
            "meal_unit_weight_implausible",
        );
    });

    test("a real cup of milk (244 g) is NOT flagged", () => {
        const milk = item({
            name: "Whole Milk",
            portionLabel: "1 cup",
            gramWeight: 244,
            nutrients: { calories: 149 },
        });
        expect(scanMealItem(milk).signatures).toEqual([]);
    });

    test("honey at high density is NOT flagged", () => {
        const honey = item({
            name: "Honey",
            portionLabel: "1 tbsp",
            gramWeight: 21,
            nutrients: { calories: 64 }, // ~305 kcal/100 g, density 1.42
        });
        expect(scanMealItem(honey).signatures).toEqual([]);
    });
});
