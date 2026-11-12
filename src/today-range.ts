/**
 * Today range mode (cohesion program, slice 2): the deterministic
 * aggregation behind a calendar range on Today. Pure arithmetic — no
 * AI (the owner's AI-benefit test). Conventions:
 *
 * - Averages divide by LOGGED days (days with at least one logged
 *   meal), matching the canonical range contract in
 *   nutrition-contract.ts — an untracked day is not a zero day.
 * - Period target = the daily target × calendar days in the range,
 *   labeled as such in the UI.
 * - Days-on-target is judged per logged day against the daily target.
 *   Direction: protein and fiber are floors (at-or-above meets);
 *   calories, carbs, fat, sugar, and sodium are ceilings (at-or-below
 *   meets).
 * - Planned projections NEVER fold into actual totals: they aggregate
 *   separately and the UI labels them separately.
 */

import type {
    PlannedDayProjection,
    ProjectedTotals,
} from "./planned-projection.js";

export interface RangeMealItemInput {
    fiberG?: number | null;
    sugarG?: number | null;
    sodiumMg?: number | null;
    saturatedFatG?: number | null;
    potassiumMg?: number | null;
    cholesterolMg?: number | null;
}

export interface RangeMealInput {
    calories?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
    items?: readonly RangeMealItemInput[];
}

export interface RangeDayInput {
    date: string;
    relation: "past" | "today" | "future";
    meals: readonly RangeMealInput[];
    planned: PlannedDayProjection | null;
}

export interface MacroAggregate {
    total: number;
    /** Total ÷ logged days (0 when nothing was logged). */
    dailyAverage: number;
    /** Daily target × calendar days, or null when no target is set. */
    periodTarget: number | null;
    dailyTarget: number | null;
    /** Logged days meeting the daily target; null when no target. */
    daysOnTarget: number | null;
    /** Days the on-target count is judged over (logged days). */
    daysJudged: number;
}

export interface MicroAggregate {
    total: number;
    dailyAverage: number;
    periodTarget: number | null;
    dailyTarget: number | null;
}

export interface TodayRangeAggregate {
    /** Calendar days in the range. */
    days: number;
    /** Days (past/today) with at least one logged meal. */
    daysWithMeals: number;
    /** Days carrying a planned projection (today/future). */
    plannedDays: number;
    macros: {
        calories: MacroAggregate;
        protein: MacroAggregate;
        carbs: MacroAggregate;
        fat: MacroAggregate;
    };
    micros: {
        fiber: MicroAggregate;
        sugar: MicroAggregate;
        sodium: MicroAggregate;
        saturatedFat: MicroAggregate;
        potassium: MicroAggregate;
        cholesterol: MicroAggregate;
    };
    /** Planned totals across the range, kept apart from actuals. */
    plannedTotals: ProjectedTotals | null;
}

export interface RangeGoalsInput {
    daily_calories?: number | null;
    daily_protein_g?: number | null;
    daily_carbs_g?: number | null;
    daily_fat_g?: number | null;
    daily_fiber_g?: number | null;
    daily_sugar_g?: number | null;
}

const MACRO_FIELDS = {
    calories: { meal: "calories", goal: "daily_calories", floor: false },
    protein: { meal: "protein_g", goal: "daily_protein_g", floor: true },
    carbs: { meal: "carbs_g", goal: "daily_carbs_g", floor: false },
    fat: { meal: "fat_g", goal: "daily_fat_g", floor: false },
} as const;

const MICRO_FIELDS = {
    fiber: { item: "fiberG", goal: "daily_fiber_g" },
    sugar: { item: "sugarG", goal: "daily_sugar_g" },
    sodium: { item: "sodiumMg", goal: null },
    saturatedFat: { item: "saturatedFatG", goal: null },
    potassium: { item: "potassiumMg", goal: null },
    cholesterol: { item: "cholesterolMg", goal: null },
} as const;

function round1(value: number): number {
    return Number(value.toFixed(1));
}

function dayMacroTotal(day: RangeDayInput, field: string): number {
    return day.meals.reduce(
        (sum, meal) =>
            sum + (Number((meal as Record<string, unknown>)[field]) || 0),
        0,
    );
}

function dayMicroTotal(day: RangeDayInput, field: string): number {
    return day.meals.reduce(
        (sum, meal) =>
            sum +
            (meal.items ?? []).reduce(
                (itemSum, item) =>
                    itemSum +
                    (Number((item as Record<string, unknown>)[field]) || 0),
                0,
            ),
        0,
    );
}

export function aggregateTodayRange(
    days: readonly RangeDayInput[],
    goals: RangeGoalsInput | null | undefined,
): TodayRangeAggregate {
    // A logged meal counts as an actual on any day it was logged for —
    // the actual/planned line, not the past/future line, is what keeps
    // the two apart. Planned projections aggregate separately below.
    const loggedDays = days.filter((day) => day.meals.length > 0);
    const daysWithMeals = loggedDays.length;
    const average = (total: number) =>
        daysWithMeals === 0 ? 0 : round1(total / daysWithMeals);

    const macros = {} as TodayRangeAggregate["macros"];
    for (const [key, config] of Object.entries(MACRO_FIELDS)) {
        const dailyTarget =
            (goals?.[config.goal as keyof RangeGoalsInput] as
                number | null | undefined) ?? null;
        const total = days.reduce(
            (sum, day) => sum + dayMacroTotal(day, config.meal),
            0,
        );
        let daysOnTarget: number | null = null;
        if (dailyTarget != null && dailyTarget > 0) {
            daysOnTarget = loggedDays.filter((day) => {
                const value = dayMacroTotal(day, config.meal);
                return config.floor
                    ? value >= dailyTarget
                    : value <= dailyTarget;
            }).length;
        }
        macros[key as keyof typeof macros] = {
            total: round1(total),
            dailyAverage: average(total),
            periodTarget:
                dailyTarget != null ? dailyTarget * days.length : null,
            dailyTarget,
            daysOnTarget,
            daysJudged: daysWithMeals,
        };
    }

    const micros = {} as TodayRangeAggregate["micros"];
    for (const [key, config] of Object.entries(MICRO_FIELDS)) {
        const dailyTarget = config.goal
            ? ((goals?.[config.goal as keyof RangeGoalsInput] as
                  number | null | undefined) ?? null)
            : null;
        const total = days.reduce(
            (sum, day) => sum + dayMicroTotal(day, config.item),
            0,
        );
        micros[key as keyof typeof micros] = {
            total: round1(total),
            dailyAverage: average(total),
            periodTarget:
                dailyTarget != null ? dailyTarget * days.length : null,
            dailyTarget,
        };
    }

    const plannedDays = days.filter((day) => day.planned).length;
    let plannedTotals: ProjectedTotals | null = null;
    for (const day of days) {
        if (!day.planned) continue;
        if (!plannedTotals) {
            plannedTotals = { ...day.planned.totals };
            continue;
        }
        plannedTotals.calories += day.planned.totals.calories;
        plannedTotals.proteinG += day.planned.totals.proteinG;
        plannedTotals.carbsG += day.planned.totals.carbsG;
        plannedTotals.fatG += day.planned.totals.fatG;
        plannedTotals.fiberG += day.planned.totals.fiberG;
        plannedTotals.sugarG += day.planned.totals.sugarG;
        plannedTotals.sodiumMg += day.planned.totals.sodiumMg;
    }

    return {
        days: days.length,
        daysWithMeals,
        plannedDays,
        macros,
        micros,
        plannedTotals,
    };
}
