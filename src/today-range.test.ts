import { describe, expect, test } from "bun:test";
import { aggregateTodayRange, type RangeDayInput } from "./today-range.js";
import { projectPlannedDay } from "./planned-projection.js";

const goals = {
    daily_calories: 2000,
    daily_protein_g: 100,
    daily_carbs_g: 250,
    daily_fat_g: 70,
    daily_fiber_g: 28,
    daily_sugar_g: 50,
};

function meal(
    calories: number,
    protein: number,
    carbs: number,
    fat: number,
    items: RangeDayInput["meals"][number]["items"] = [],
): RangeDayInput["meals"][number] {
    return {
        calories,
        protein_g: protein,
        carbs_g: carbs,
        fat_g: fat,
        items,
    };
}

// Mon–Fri: four logged days, one untracked day. Protein meets its
// floor on 3 of 4 logged days; calories stay under the ceiling on 3.
const week: RangeDayInput[] = [
    {
        date: "2026-11-09",
        relation: "past",
        meals: [
            meal(1900, 120, 200, 60, [
                {
                    fiberG: 30,
                    sugarG: 40,
                    sodiumMg: 1800,
                    saturatedFatG: 20,
                    potassiumMg: 3000,
                    cholesterolMg: 200,
                },
            ]),
        ],
        planned: null,
    },
    {
        date: "2026-11-10",
        relation: "past",
        meals: [
            meal(2100, 90, 260, 80, [
                {
                    fiberG: 20,
                    sugarG: 60,
                    sodiumMg: 2400,
                    saturatedFatG: 30,
                    potassiumMg: 2500,
                    cholesterolMg: 260,
                },
            ]),
        ],
        planned: null,
    },
    { date: "2026-11-11", relation: "past", meals: [], planned: null },
    {
        date: "2026-11-12",
        relation: "past",
        meals: [meal(1800, 110, 190, 55)],
        planned: null,
    },
    {
        date: "2026-11-13",
        relation: "past",
        meals: [meal(2000, 100, 240, 70)],
        planned: null,
    },
];

describe("aggregateTodayRange", () => {
    test("totals, per-logged-day averages, period targets, days-on-target", () => {
        const aggregate = aggregateTodayRange(week, goals);
        expect(aggregate.days).toBe(5);
        expect(aggregate.daysWithMeals).toBe(4);

        expect(aggregate.macros.calories.total).toBe(7800);
        // Averages divide by logged days (4), not calendar days (5).
        expect(aggregate.macros.calories.dailyAverage).toBe(1950);
        // Period target = daily × calendar days, labeled as such.
        expect(aggregate.macros.calories.periodTarget).toBe(10000);
        // Ceiling: 1900 ✓, 2100 ✗, 1800 ✓, 2000 ✓ (at-or-below meets).
        expect(aggregate.macros.calories.daysOnTarget).toBe(3);
        expect(aggregate.macros.calories.daysJudged).toBe(4);

        // Floor: 120 ✓, 90 ✗, 110 ✓, 100 ✓ (at-or-above meets).
        expect(aggregate.macros.protein.daysOnTarget).toBe(3);
        expect(aggregate.macros.protein.total).toBe(420);
        expect(aggregate.macros.protein.dailyAverage).toBe(105);
    });

    test("micros get the same treatment; period targets only where a daily target exists", () => {
        const aggregate = aggregateTodayRange(week, goals);
        expect(aggregate.micros.fiber.total).toBe(50);
        expect(aggregate.micros.fiber.dailyAverage).toBe(12.5);
        expect(aggregate.micros.fiber.periodTarget).toBe(140);
        expect(aggregate.micros.sugar.periodTarget).toBe(250);
        expect(aggregate.micros.sodium.total).toBe(4200);
        expect(aggregate.micros.sodium.periodTarget).toBeNull();
        expect(aggregate.micros.potassium.total).toBe(5500);
    });

    test("no goals: targets and on-target counts are null, totals still sum", () => {
        const aggregate = aggregateTodayRange(week, null);
        expect(aggregate.macros.calories.periodTarget).toBeNull();
        expect(aggregate.macros.calories.daysOnTarget).toBeNull();
        expect(aggregate.macros.calories.total).toBe(7800);
    });

    test("planned projections aggregate apart — never inside actual totals", () => {
        const planned = projectPlannedDay([
            {
                recipe_name: "Soup",
                meal_slot: "dinner",
                servings: 1,
                nutrition_per_serving: {
                    calories: 500,
                    protein_g: 20,
                    carbs_g: 50,
                    fat_g: 15,
                    fiber_g: 6,
                    sugar_g: 8,
                    sodium_mg: 900,
                },
            },
        ]);
        const mixed: RangeDayInput[] = [
            week[0],
            { date: "2026-11-14", relation: "future", meals: [], planned },
            { date: "2026-11-15", relation: "future", meals: [], planned },
        ];
        const aggregate = aggregateTodayRange(mixed, goals);
        expect(aggregate.macros.calories.total).toBe(1900);
        expect(aggregate.plannedDays).toBe(2);
        expect(aggregate.plannedTotals?.calories).toBe(1000);
        expect(aggregate.plannedTotals?.proteinG).toBe(40);
    });

    test("empty range: zeros, no planned totals", () => {
        const aggregate = aggregateTodayRange(
            [
                {
                    date: "2026-11-16",
                    relation: "future",
                    meals: [],
                    planned: null,
                },
            ],
            goals,
        );
        expect(aggregate.daysWithMeals).toBe(0);
        expect(aggregate.macros.calories.total).toBe(0);
        expect(aggregate.macros.calories.dailyAverage).toBe(0);
        expect(aggregate.plannedTotals).toBeNull();
    });
});
