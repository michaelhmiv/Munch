import { describe, expect, test } from "bun:test";
import {
    projectPlannedDay,
    projectPlannedRange,
    type PlannedMealNutritionInput,
} from "./planned-projection.js";

const soup: PlannedMealNutritionInput = {
    planned_date: "2026-11-14",
    meal_slot: "dinner",
    recipe_name: "Tomato soup",
    servings: 2,
    nutrition_per_serving: {
        calories: 300,
        protein_g: 10,
        carbs_g: 40,
        fat_g: 12,
        fiber_g: 5,
        sugar_g: 9,
        sodium_mg: 700,
    },
};

const salad: PlannedMealNutritionInput = {
    planned_date: "2026-11-14",
    meal_slot: "lunch",
    recipe_name: "Green salad",
    servings: 1,
    nutrition_per_serving: {
        calories: 150,
        protein_g: 4,
        carbs_g: 10,
        fat_g: 9,
    },
};

const mystery: PlannedMealNutritionInput = {
    planned_date: "2026-11-14",
    meal_slot: "breakfast",
    recipe_name: "Grandma's casserole",
    servings: 1,
    nutrition_per_serving: {},
};

describe("projectPlannedDay", () => {
    test("full day: per-serving nutrition scales by servings and sums", () => {
        const projection = projectPlannedDay([soup, salad]);
        expect(projection.totals).toEqual({
            calories: 750,
            proteinG: 24,
            carbsG: 90,
            fatG: 33,
            fiberG: 10,
            sugarG: 18,
            sodiumMg: 1400,
        });
        expect(projection.countedMeals).toBe(2);
        expect(projection.notCounted).toEqual([]);
        expect(projection.partial).toBe(false);
        expect(projection.meals[0]).toMatchObject({
            recipe_name: "Tomato soup",
            meal_slot: "dinner",
            servings: 2,
            calories: 600,
        });
    });

    test("partial day: a recipe without nutrition is named, never zeroed in", () => {
        const projection = projectPlannedDay([soup, mystery]);
        expect(projection.totals.calories).toBe(600);
        expect(projection.countedMeals).toBe(1);
        expect(projection.partial).toBe(true);
        expect(projection.notCounted).toEqual([
            {
                recipe_name: "Grandma's casserole",
                meal_slot: "breakfast",
                servings: 1,
            },
        ]);
    });

    test("null nutrition and missing calories both count as unavailable", () => {
        const projection = projectPlannedDay([
            { ...mystery, nutrition_per_serving: null },
            {
                ...mystery,
                recipe_name: "No facts",
                nutrition_per_serving: { protein_g: 5 },
            },
        ]);
        expect(projection.countedMeals).toBe(0);
        expect(projection.totals.calories).toBe(0);
        expect(projection.notCounted).toHaveLength(2);
        expect(projection.partial).toBe(true);
    });

    test("empty day projects to zeros with nothing partial", () => {
        const projection = projectPlannedDay([]);
        expect(projection.totals.calories).toBe(0);
        expect(projection.countedMeals).toBe(0);
        expect(projection.notCounted).toEqual([]);
        expect(projection.partial).toBe(false);
    });
});

describe("projectPlannedRange", () => {
    test("groups by planned_date and projects each day independently", () => {
        const other: PlannedMealNutritionInput = {
            ...salad,
            planned_date: "2026-11-15",
        };
        const byDate = projectPlannedRange([soup, mystery, other]);
        expect([...byDate.keys()]).toEqual(["2026-11-14", "2026-11-15"]);
        expect(byDate.get("2026-11-14")?.partial).toBe(true);
        expect(byDate.get("2026-11-14")?.totals.calories).toBe(600);
        expect(byDate.get("2026-11-15")?.totals.calories).toBe(150);
        expect(byDate.get("2026-11-15")?.partial).toBe(false);
    });
});
