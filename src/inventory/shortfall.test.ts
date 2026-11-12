import { describe, expect, test } from "bun:test";
import type { RecipeIngredientInput } from "../planning/repository.js";
import type { InventoryMatchableItem } from "./matching.js";
import { computePlanShortfall, type ShortfallMealInput } from "./shortfall.js";

function ingredient(
    name: string,
    quantity?: number,
    unit?: string,
    optional = false,
): RecipeIngredientInput {
    return {
        name,
        quantity,
        unit,
        optional,
        sourceType: "user_supplied",
    };
}

function meal(
    id: string,
    recipeName: string,
    servings: number,
    recipeServings: number,
    ingredients: RecipeIngredientInput[],
): ShortfallMealInput {
    return {
        planned_meal_id: id,
        recipe_name: recipeName,
        servings,
        recipe_servings: recipeServings,
        ingredients,
    };
}

function stock(
    name: string,
    quantity: number | null,
    unit: string | null,
    mode: "exact" | "approximate" | "presence_only" = "exact",
    state: "available" | "low" | "depleted" = "available",
): InventoryMatchableItem {
    return {
        id: `inv-${name}`,
        name,
        normalized_name: name.toLowerCase(),
        quantity,
        unit,
        quantity_mode: mode,
        stock_state: state,
        food_provider: null,
        provider_food_id: null,
    };
}

describe("computePlanShortfall", () => {
    test("missing ingredient surfaces with scaled need and occurrence reasons", () => {
        const items = computePlanShortfall(
            [
                meal("m1", "Work Lunch", 2, 2, [
                    ingredient("Sandwich bread", 1, "loaf"),
                ]),
                meal("m2", "Work Lunch", 2, 2, [
                    ingredient("Sandwich bread", 1, "loaf"),
                ]),
                meal("m3", "Work Lunch", 2, 2, [
                    ingredient("Sandwich bread", 1, "loaf"),
                ]),
                meal("m4", "Work Lunch", 2, 2, [
                    ingredient("Sandwich bread", 1, "loaf"),
                ]),
                meal("m5", "Work Lunch", 2, 2, [
                    ingredient("Sandwich bread", 1, "loaf"),
                ]),
            ],
            [],
        );
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            name: "Sandwich bread",
            need_quantity: 5,
            need_unit: "loaf",
            have_quantity: 0,
            short_quantity: 5,
            pantry_state: "none",
            planned_meal_id: "m1",
        });
        expect(items[0]!.reasons).toEqual([
            { recipe_name: "Work Lunch", planned_meal_id: "m1", times: 5 },
        ]);
    });

    test("planned servings scale the recipe's ingredient quantities", () => {
        const items = computePlanShortfall(
            [meal("m1", "Bread", 8, 4, [ingredient("Flour", 250, "g")])],
            [],
        );
        expect(items[0]!.need_quantity).toBe(500);
    });

    test("exact stock below the need reports the difference, never more", () => {
        const items = computePlanShortfall(
            [meal("m1", "Bread", 4, 4, [ingredient("Flour", 500, "g")])],
            [stock("Flour", 200, "g")],
        );
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            have_quantity: 200,
            short_quantity: 300,
            pantry_state: "short",
        });
    });

    test("stock converts across units in the same family", () => {
        const items = computePlanShortfall(
            [meal("m1", "Bread", 4, 4, [ingredient("Flour", 1, "lb")])],
            [stock("Flour", 200, "g")],
        );
        expect(items).toHaveLength(1);
        expect(items[0]!.have_quantity).toBeCloseTo(0.441, 2);
        expect(items[0]!.short_quantity).toBeCloseTo(0.559, 2);
    });

    test("multiple exact stock rows sum toward the need", () => {
        const items = computePlanShortfall(
            [meal("m1", "Bread", 4, 4, [ingredient("Flour", 500, "g")])],
            [stock("Flour", 300, "g"), stock("Flour", 250, "g")],
        );
        expect(items).toHaveLength(0);
    });

    test("approximate stock covers a need it cannot numerically prove", () => {
        const items = computePlanShortfall(
            [meal("m1", "Soup", 4, 4, [ingredient("Chicken stock", 4, "cup")])],
            [stock("Chicken stock", 1, "cup", "approximate")],
        );
        expect(items).toHaveLength(0);
    });

    test("presence-only stock covers the need", () => {
        const items = computePlanShortfall(
            [meal("m1", "Soup", 4, 4, [ingredient("Chicken stock", 4, "cup")])],
            [stock("Chicken stock", null, null, "presence_only")],
        );
        expect(items).toHaveLength(0);
    });

    test("exact stock that meets the need stays silent", () => {
        const items = computePlanShortfall(
            [meal("m1", "Bread", 4, 4, [ingredient("Flour", 500, "g")])],
            [stock("Flour", 500, "g")],
        );
        expect(items).toHaveLength(0);
    });

    test("optional and quantity-less ingredients never surface", () => {
        const items = computePlanShortfall(
            [
                meal("m1", "Salad", 2, 2, [
                    ingredient("Croutons", 1, "cup", true),
                    ingredient("Salt"),
                    ingredient("Olive oil", 2, "tbsp"),
                ]),
            ],
            [],
        );
        expect(items.map((item) => item.name)).toEqual(["Olive oil"]);
    });

    test("depleted stock counts as none", () => {
        const items = computePlanShortfall(
            [meal("m1", "Bread", 4, 4, [ingredient("Flour", 500, "g")])],
            [stock("Flour", 900, "g", "exact", "depleted")],
        );
        expect(items).toHaveLength(1);
        expect(items[0]!.pantry_state).toBe("none");
    });

    test("an empty plan produces no rows", () => {
        expect(computePlanShortfall([], [stock("Flour", 1, "g")])).toEqual([]);
    });
});
