import { describe, expect, test } from "bun:test";
import {
    aggregateTodayRange,
    buildRangeHierarchy,
    type RangeDayInput,
} from "./today-range.js";
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

    test("average delta is signed against the daily target, direction-aware", () => {
        const aggregate = aggregateTodayRange(week, goals);
        // Limit (calories): avg 1,950 vs 2,000 target → −50/day.
        expect(aggregate.macros.calories.direction).toBe("limit");
        expect(aggregate.macros.calories.averageDelta).toBe(-50);
        // Reach (protein): avg 105 vs 100 target → +5/day.
        expect(aggregate.macros.protein.direction).toBe("reach");
        expect(aggregate.macros.protein.averageDelta).toBe(5);
        // No target → no delta.
        const untargeted = aggregateTodayRange(week, null);
        expect(untargeted.macros.calories.averageDelta).toBeNull();
    });

    test("micros: delta only where a target exists; targets read generically", () => {
        const aggregate = aggregateTodayRange(week, goals);
        // Fiber has a reach target: avg 12.5 vs 28 → −15.5/day.
        expect(aggregate.micros.fiber.direction).toBe("reach");
        expect(aggregate.micros.fiber.averageDelta).toBe(-15.5);
        // Sodium has no goal field set → plain average, no delta,
        // no period target.
        expect(aggregate.micros.sodium.averageDelta).toBeNull();
        expect(aggregate.micros.sodium.periodTarget).toBeNull();
        expect(aggregate.micros.sodium.dailyAverage).toBe(1050);
        // A future opt-in sodium goal lights up with no code change:
        // same fixture, goal present → delta + period target appear.
        const withSodiumGoal = aggregateTodayRange(week, {
            ...goals,
            daily_sodium_mg: 2000,
        });
        expect(withSodiumGoal.micros.sodium.periodTarget).toBe(10000);
        expect(withSodiumGoal.micros.sodium.averageDelta).toBe(-950);
        expect(withSodiumGoal.micros.sodium.direction).toBe("limit");
    });

    test("alcohol is a meal-level limit micro, targeted from daily_alcohol_g", () => {
        const days: RangeDayInput[] = [
            {
                date: "2026-11-09",
                relation: "past",
                meals: [{ ...meal(800, 30, 50, 20), alcohol_g: 14 }],
                planned: null,
            },
            {
                date: "2026-11-10",
                relation: "past",
                meals: [{ ...meal(900, 30, 50, 20), alcohol_g: 0 }],
                planned: null,
            },
        ];
        const aggregate = aggregateTodayRange(days, {
            ...goals,
            daily_alcohol_g: 10,
        });
        expect(aggregate.micros.alcohol.total).toBe(14);
        expect(aggregate.micros.alcohol.dailyAverage).toBe(7);
        expect(aggregate.micros.alcohol.averageDelta).toBe(-3);
        expect(aggregate.micros.alcohol.direction).toBe("limit");
    });

    test("water aggregates as a reach target with its own logged-day average", () => {
        const days: RangeDayInput[] = [
            {
                date: "2026-11-09",
                relation: "past",
                meals: [meal(500, 20, 30, 10)],
                planned: null,
                waterMl: 2000,
            },
            {
                date: "2026-11-10",
                relation: "past",
                meals: [meal(500, 20, 30, 10)],
                planned: null,
                waterMl: 1000,
            },
            {
                date: "2026-11-11",
                relation: "past",
                meals: [],
                planned: null,
                waterMl: 0,
            },
        ];
        const aggregate = aggregateTodayRange(days, {
            ...goals,
            daily_water_ml: 2500,
        });
        expect(aggregate.water.totalMl).toBe(3000);
        expect(aggregate.water.daysWithWater).toBe(2);
        expect(aggregate.water.dailyAverageMl).toBe(1500);
        expect(aggregate.water.periodTargetMl).toBe(7500);
        expect(aggregate.water.averageDeltaMl).toBe(-1000);
        expect(aggregate.water.direction).toBe("reach");
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

describe("buildRangeHierarchy", () => {
    // 60 days, 2026-11-01 (a Sunday) through 2026-12-30, one meal of
    // 100 kcal per day — sums must reconcile at every level.
    const sixtyDays: RangeDayInput[] = Array.from({ length: 60 }, (_, i) => {
        const value = new Date("2026-11-01T12:00:00Z");
        value.setUTCDate(value.getUTCDate() + i);
        const date = value.toISOString().slice(0, 10);
        return {
            date,
            relation: "past" as const,
            meals: [meal(100, 5, 10, 2)],
            planned: null,
        };
    });

    test("a 60-day range opens as two month rows", () => {
        const hierarchy = buildRangeHierarchy(sixtyDays);
        expect(hierarchy.map((month) => month.month)).toEqual([
            "2026-11",
            "2026-12",
        ]);
        expect(hierarchy[0].calories).toBe(3000);
        expect(hierarchy[0].mealCount).toBe(30);
        expect(hierarchy[1].calories).toBe(3000);
        expect(hierarchy[1].mealCount).toBe(30);
    });

    test("month = sum of its weeks = sum of its days, at every level", () => {
        const hierarchy = buildRangeHierarchy(sixtyDays);
        for (const month of hierarchy) {
            const weekSum = month.weeks.reduce(
                (sum, week) => sum + week.calories,
                0,
            );
            const daySum = month.weeks
                .flatMap((week) => week.days)
                .reduce((sum, day) => sum + day.calories, 0);
            expect(weekSum).toBe(month.calories);
            expect(daySum).toBe(month.calories);
            for (const week of month.weeks) {
                expect(
                    week.days.reduce((sum, day) => sum + day.calories, 0),
                ).toBe(week.calories);
                expect(
                    week.days.reduce((sum, day) => sum + day.mealCount, 0),
                ).toBe(week.mealCount);
            }
        }
        const grandTotal = hierarchy.reduce(
            (sum, month) => sum + month.calories,
            0,
        );
        expect(grandTotal).toBe(6000);
    });

    test("planned-only days enter the hierarchy as zero actuals — projections never reconcile into it", () => {
        const planned = projectPlannedDay([
            {
                recipe_name: "Soup",
                meal_slot: "dinner",
                servings: 1,
                nutrition_per_serving: {
                    calories: 600,
                    protein_g: 20,
                    carbs_g: 60,
                    fat_g: 25,
                    fiber_g: 8,
                    sugar_g: 9,
                    sodium_mg: 700,
                },
                counted: true,
            },
        ]);
        const days: RangeDayInput[] = [
            {
                date: "2026-11-30",
                relation: "past",
                meals: [meal(500, 30, 40, 15)],
                planned: null,
            },
            {
                date: "2026-12-01",
                relation: "future",
                meals: [],
                planned,
            },
        ];
        const hierarchy = buildRangeHierarchy(days);
        // The planned day is present (its row can render, tagged
        // Planned) but contributes no actuals at any level.
        const december = hierarchy.find((month) => month.month === "2026-12");
        expect(december?.calories).toBe(0);
        expect(december?.mealCount).toBe(0);
        expect(december?.weeks[0].days[0]).toEqual({
            date: "2026-12-01",
            calories: 0,
            mealCount: 0,
        });
        const grandTotal = hierarchy.reduce(
            (sum, month) => sum + month.calories,
            0,
        );
        expect(grandTotal).toBe(500);
        // And the aggregate keeps the same line: the future day is a
        // planned day, not a logged or judged day.
        const aggregate = aggregateTodayRange(days, goals);
        expect(aggregate.plannedDays).toBe(1);
        expect(aggregate.daysWithMeals).toBe(1);
        expect(aggregate.macros.calories.daysJudged).toBe(1);
        expect(aggregate.macros.calories.total).toBe(500);
        expect(aggregate.plannedTotals?.calories).toBe(600);
    });

    test("weeks are Sunday-start; a week crossing a month boundary splits by month", () => {
        const hierarchy = buildRangeHierarchy(sixtyDays);
        const november = hierarchy[0];
        const december = hierarchy[1];
        // Nov 1 2026 is a Sunday: November's first week is full.
        expect(november.weeks[0].weekStart).toBe("2026-11-01");
        expect(november.weeks[0].days).toHaveLength(7);
        // The Nov 29 – Dec 5 week splits: 2 days under November
        // (weekStart Nov 29), 5 under December (same weekStart).
        const novemberTail = november.weeks.at(-1);
        expect(novemberTail?.weekStart).toBe("2026-11-29");
        expect(novemberTail?.days.map((day) => day.date)).toEqual([
            "2026-11-29",
            "2026-11-30",
        ]);
        const decemberHead = december.weeks[0];
        expect(decemberHead.weekStart).toBe("2026-11-29");
        expect(decemberHead.days.map((day) => day.date)).toEqual([
            "2026-12-01",
            "2026-12-02",
            "2026-12-03",
            "2026-12-04",
            "2026-12-05",
        ]);
    });
});
