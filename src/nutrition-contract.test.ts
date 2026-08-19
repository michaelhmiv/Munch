import { describe, expect, test } from "bun:test";
import type { Meal, NutritionGoals } from "./storage.js";
import {
    buildNutritionRangeContract,
    inclusiveDateSpanDays,
    sumNutrition,
} from "./nutrition-contract.js";

function meal(id: string, loggedAt: string, values: Partial<Meal> = {}): Meal {
    return {
        id,
        user_id: "00000000-0000-0000-0000-000000000001",
        logged_at: loggedAt,
        meal_type: "lunch",
        description: id,
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        sugar_g: null,
        alcohol_g: null,
        notes: null,
        idempotency_key: null,
        ...values,
    };
}

const goals: NutritionGoals = {
    user_id: "00000000-0000-0000-0000-000000000001",
    daily_calories: 2200,
    daily_protein_g: 180,
    daily_carbs_g: 200,
    daily_fat_g: 75,
    daily_fiber_g: 30,
    daily_sugar_g: 50,
    daily_alcohol_g: null,
    daily_water_ml: 2500,
    target_weight_g: 86183,
    updated_at: "2026-08-19T00:00:00.000Z",
};

describe("canonical nutrition contract", () => {
    test("counts inclusive calendar ranges", () => {
        expect(inclusiveDateSpanDays("2026-08-01", "2026-08-01")).toBe(1);
        expect(inclusiveDateSpanDays("2026-08-01", "2026-08-07")).toBe(7);
        expect(() => inclusiveDateSpanDays("2026-08-07", "2026-08-01")).toThrow(
            "Invalid date range",
        );
    });

    test("uses one total calculation for calories and macros", () => {
        const meals = [
            meal("a", "2026-08-18T12:00:00.000Z", {
                calories: 600,
                protein_g: 40,
                carbs_g: 60,
                fat_g: 20,
            }),
            meal("b", "2026-08-18T18:00:00.000Z", {
                calories: 400,
                protein_g: 30,
                carbs_g: 30,
                fat_g: 15,
            }),
        ];
        expect(sumNutrition(meals)).toEqual({
            calories: 1000,
            proteinG: 70,
            carbsG: 90,
            fatG: 35,
            fiberG: 0,
            sugarG: 0,
            alcoholG: 0,
        });
    });

    test("carries the exact stored goals into range snapshots", () => {
        const contract = buildNutritionRangeContract({
            meals: [
                meal("a", "2026-08-18T12:00:00.000Z", {
                    calories: 1800,
                    protein_g: 150,
                    carbs_g: 170,
                    fat_g: 65,
                }),
            ],
            startDate: "2026-08-18",
            endDate: "2026-08-19",
            timezone: "UTC",
            goals,
        });
        expect(contract.goals).toEqual(goals);
        expect(contract.calendarDays).toBe(2);
        expect(contract.loggedDays).toBe(1);
        expect(contract.averages.proteinG).toBe(150);
        expect(contract.days[0]?.calories).toBe(1800);
        expect(contract.days[0]?.proteinG).toBe(150);
    });

    test("does not treat missing partial nutrients as confirmed zero", () => {
        const contract = buildNutritionRangeContract({
            meals: [
                meal("legacy", "2026-08-17T12:00:00.000Z", {
                    calories: 1000,
                    protein_g: 100,
                }),
                meal("modern", "2026-08-18T12:00:00.000Z", {
                    calories: 1200,
                    protein_g: 120,
                    fiber_g: 30,
                    sugar_g: 20,
                    alcohol_g: 0,
                }),
            ],
            startDate: "2026-08-17",
            endDate: "2026-08-18",
            timezone: "UTC",
            goals,
        });
        expect(contract.averages.calories).toBe(1100);
        expect(contract.averages.proteinG).toBe(110);
        expect(contract.averages.fiberG).toBe(30);
        expect(contract.averages.sugarG).toBe(20);
        expect(contract.averages.alcoholG).toBe(0);
        expect(contract.nutrientCoverage).toEqual({
            fiberDays: 1,
            sugarDays: 1,
            alcoholDays: 1,
        });
    });

    test("groups meals using the saved timezone", () => {
        const contract = buildNutritionRangeContract({
            meals: [
                meal("late", "2026-08-19T02:00:00.000Z", {
                    calories: 500,
                }),
            ],
            startDate: "2026-08-18",
            endDate: "2026-08-18",
            timezone: "America/New_York",
            goals,
        });
        expect(contract.days).toHaveLength(1);
        expect(contract.days[0]?.date).toBe("2026-08-18");
    });
});
