import type { Meal, NutritionGoals } from "./storage.js";
import { coveredDailyAverage, dayCarries } from "./insights.js";
import { dateInTz } from "./tz.js";

export interface NutritionTotals {
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    fiberG: number;
    sugarG: number;
    alcoholG: number;
}

export interface NutritionRangeDay {
    date: string;
    totals: NutritionTotals;
    mealCount: number;
}

export interface NutritionRangeContract {
    startDate: string;
    endDate: string;
    timezone: string;
    calendarDays: number;
    loggedDays: number;
    mealCount: number;
    totals: NutritionTotals;
    averages: NutritionTotals;
    goals: NutritionGoals | null;
    days: NutritionRangeDay[];
    nutrientCoverage: {
        fiberDays: number;
        sugarDays: number;
        alcoholDays: number;
    };
}

export function validateLocalDate(value: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error("Invalid date");
    }
    return value;
}

export function inclusiveDateSpanDays(startDate: string, endDate: string): number {
    const start = Date.parse(`${validateLocalDate(startDate)}T00:00:00Z`);
    const end = Date.parse(`${validateLocalDate(endDate)}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw new Error("Invalid date range");
    }
    return Math.floor((end - start) / 86_400_000) + 1;
}

export function sumNutrition(meals: Meal[]): NutritionTotals {
    return meals.reduce<NutritionTotals>(
        (result, meal) => {
            result.calories += meal.calories ?? 0;
            result.proteinG += meal.protein_g ?? 0;
            result.carbsG += meal.carbs_g ?? 0;
            result.fatG += meal.fat_g ?? 0;
            result.fiberG += meal.fiber_g ?? 0;
            result.sugarG += meal.sugar_g ?? 0;
            result.alcoholG += meal.alcohol_g ?? 0;
            return result;
        },
        {
            calories: 0,
            proteinG: 0,
            carbsG: 0,
            fatG: 0,
            fiberG: 0,
            sugarG: 0,
            alcoholG: 0,
        },
    );
}

function roundOne(value: number): number {
    return Number(value.toFixed(1));
}

function average(value: number, days: number): number {
    return days === 0 ? 0 : roundOne(value / days);
}

/**
 * Canonical web/MCP-compatible range calculation.
 *
 * Calories and the primary macros divide by logged days, matching the existing
 * nutrition-summary semantics. Fiber, sugar, and alcohol use the shared
 * coverage rule from insights.ts so a missing historical nutrient value is not
 * silently treated as a confirmed zero.
 */
export function buildNutritionRangeContract(input: {
    meals: Meal[];
    startDate: string;
    endDate: string;
    timezone: string;
    goals: NutritionGoals | null;
}): NutritionRangeContract {
    const { meals, timezone, goals } = input;
    const startDate = validateLocalDate(input.startDate);
    const endDate = validateLocalDate(input.endDate);
    const calendarDays = inclusiveDateSpanDays(startDate, endDate);

    const byDate = new Map<string, Meal[]>();
    for (const meal of meals) {
        const localDate = dateInTz(meal.logged_at, timezone);
        const group = byDate.get(localDate) ?? [];
        group.push(meal);
        byDate.set(localDate, group);
    }

    const days = [...byDate.entries()]
        .map(([date, entries]) => ({
            date,
            totals: sumNutrition(entries),
            mealCount: entries.length,
        }))
        .sort((left, right) => left.date.localeCompare(right.date));

    const totals = sumNutrition(meals);
    const loggedDays = days.length;
    const mealsByLoggedDay = days.map((day) => byDate.get(day.date) ?? []);
    const fiber = coveredDailyAverage(mealsByLoggedDay, "fiber_g");
    const sugar = coveredDailyAverage(mealsByLoggedDay, "sugar_g");
    const alcohol = coveredDailyAverage(mealsByLoggedDay, "alcohol_g");

    return {
        startDate,
        endDate,
        timezone,
        calendarDays,
        loggedDays,
        mealCount: meals.length,
        totals,
        averages: {
            calories: average(totals.calories, loggedDays),
            proteinG: average(totals.proteinG, loggedDays),
            carbsG: average(totals.carbsG, loggedDays),
            fatG: average(totals.fatG, loggedDays),
            fiberG: fiber.avg == null ? 0 : roundOne(fiber.avg),
            sugarG: sugar.avg == null ? 0 : roundOne(sugar.avg),
            alcoholG: alcohol.avg == null ? 0 : roundOne(alcohol.avg),
        },
        goals,
        days,
        nutrientCoverage: {
            fiberDays: fiber.days,
            sugarDays: sugar.days,
            alcoholDays: alcohol.days,
        },
    };
}

export function mealCarriesTrackedNutrient(
    meals: Meal[],
    nutrient: "fiber_g" | "sugar_g" | "alcohol_g",
): boolean {
    return dayCarries(meals, nutrient);
}
