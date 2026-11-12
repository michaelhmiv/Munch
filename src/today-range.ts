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
    alcohol_g?: number | null;
    items?: readonly RangeMealItemInput[];
}

export interface RangeDayInput {
    date: string;
    relation: "past" | "today" | "future";
    meals: readonly RangeMealInput[];
    planned: PlannedDayProjection | null;
    /** Water logged that day (ml), when the caller tracks it. */
    waterMl?: number;
}

/**
 * Target direction (spec ruling, Nov 11): "reach" targets are floors
 * the user aims to hit (protein, fiber, water); "limit" targets are
 * ceilings (calories, carbs, fat, sugar, alcohol, sodium). The
 * signed average delta is always average − target; the direction
 * tells the UI how to word it.
 */
export type TargetDirection = "reach" | "limit";

export interface MacroAggregate {
    total: number;
    /** Total ÷ logged days (0 when nothing was logged). */
    dailyAverage: number;
    /** Daily target × calendar days, or null when no target is set. */
    periodTarget: number | null;
    dailyTarget: number | null;
    direction: TargetDirection;
    /**
     * dailyAverage − dailyTarget, signed (e.g. +23 = averaging 23
     * over a 2,000 limit; −5 = averaging 5 short of a 100 reach
     * target). Null when no target is set.
     */
    averageDelta: number | null;
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
    direction: TargetDirection;
    /** Same signed-delta rule as macros; null without a target. */
    averageDelta: number | null;
}

export interface WaterAggregate {
    totalMl: number;
    daysWithWater: number;
    /** Total ÷ days with water entries (0 when none). */
    dailyAverageMl: number;
    periodTargetMl: number | null;
    dailyTargetMl: number | null;
    averageDeltaMl: number | null;
    direction: "reach";
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
        alcohol: MicroAggregate;
    };
    water: WaterAggregate;
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
    daily_alcohol_g?: number | null;
    daily_water_ml?: number | null;
    // Future opt-in micro goals (a follow-on slice) arrive as more
    // daily_* fields; MICRO_FIELDS below reads its goal key from
    // this same shape, so a new target lights up with no code change
    // beyond naming the field here.
    daily_sodium_mg?: number | null;
}

const MACRO_FIELDS = {
    calories: {
        meal: "calories",
        goal: "daily_calories",
        direction: "limit",
    },
    protein: {
        meal: "protein_g",
        goal: "daily_protein_g",
        direction: "reach",
    },
    carbs: { meal: "carbs_g", goal: "daily_carbs_g", direction: "limit" },
    fat: { meal: "fat_g", goal: "daily_fat_g", direction: "limit" },
} as const;

// `source` distinguishes item-summed micros (the single-day micros
// grammar) from alcohol, which meals carry at meal level. Targets
// are read generically from the goals shape: a micro whose goal key
// is absent or null simply gets no delta and no period target.
const MICRO_FIELDS = {
    fiber: { item: "fiberG", goal: "daily_fiber_g", direction: "reach" },
    sugar: { item: "sugarG", goal: "daily_sugar_g", direction: "limit" },
    sodium: {
        item: "sodiumMg",
        goal: "daily_sodium_mg",
        direction: "limit",
    },
    saturatedFat: { item: "saturatedFatG", goal: null, direction: "limit" },
    potassium: { item: "potassiumMg", goal: null, direction: "reach" },
    cholesterol: { item: "cholesterolMg", goal: null, direction: "limit" },
    alcohol: { meal: "alcohol_g", goal: "daily_alcohol_g", direction: "limit" },
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
                return config.direction === "reach"
                    ? value >= dailyTarget
                    : value <= dailyTarget;
            }).length;
        }
        const dailyAverage = average(total);
        macros[key as keyof typeof macros] = {
            total: round1(total),
            dailyAverage,
            periodTarget:
                dailyTarget != null ? dailyTarget * days.length : null,
            dailyTarget,
            direction: config.direction as TargetDirection,
            averageDelta:
                dailyTarget != null ? round1(dailyAverage - dailyTarget) : null,
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
        const dayTotal = (day: RangeDayInput) =>
            "meal" in config && config.meal
                ? dayMacroTotal(day, config.meal)
                : dayMicroTotal(day, (config as { item: string }).item);
        const total = days.reduce((sum, day) => sum + dayTotal(day), 0);
        const dailyAverage = average(total);
        micros[key as keyof typeof micros] = {
            total: round1(total),
            dailyAverage,
            periodTarget:
                dailyTarget != null ? dailyTarget * days.length : null,
            dailyTarget,
            direction: config.direction as TargetDirection,
            averageDelta:
                dailyTarget != null ? round1(dailyAverage - dailyTarget) : null,
        };
    }

    const waterDays = days.filter((day) => (day.waterMl ?? 0) > 0);
    const waterTotalMl = days.reduce((sum, day) => sum + (day.waterMl ?? 0), 0);
    const waterDailyTarget = goals?.daily_water_ml ?? null;
    const waterAverage =
        waterDays.length === 0 ? 0 : round1(waterTotalMl / waterDays.length);
    const water: WaterAggregate = {
        totalMl: waterTotalMl,
        daysWithWater: waterDays.length,
        dailyAverageMl: waterAverage,
        periodTargetMl:
            waterDailyTarget != null ? waterDailyTarget * days.length : null,
        dailyTargetMl: waterDailyTarget,
        averageDeltaMl:
            waterDailyTarget != null
                ? round1(waterAverage - waterDailyTarget)
                : null,
        direction: "reach",
    };

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
        water,
        plannedTotals,
    };
}

/**
 * Hierarchy for long ranges (spec ruling, Nov 11): ranges over 7
 * days nest Month → Week → Day. Weeks are Sunday-start (the app
 * calendar's own grid); a week crossing a month boundary appears as
 * a partial week inside each month, so the reconciliation is exact
 * at every level: month totals = Σ its weeks = Σ its days. Every
 * level carries total calories + meal count for its header row.
 */
export interface RangeHierarchyDay {
    date: string;
    calories: number;
    mealCount: number;
}

export interface RangeHierarchyWeek {
    /** Sunday that starts the week (may precede the range). */
    weekStart: string;
    calories: number;
    mealCount: number;
    days: RangeHierarchyDay[];
}

export interface RangeHierarchyMonth {
    month: string;
    calories: number;
    mealCount: number;
    weeks: RangeHierarchyWeek[];
}

function sundayOf(date: string): string {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() - value.getUTCDay());
    return value.toISOString().slice(0, 10);
}

export function buildRangeHierarchy(
    days: readonly RangeDayInput[],
): RangeHierarchyMonth[] {
    const months = new Map<string, RangeHierarchyMonth>();
    for (const day of days) {
        const entry: RangeHierarchyDay = {
            date: day.date,
            calories: round1(dayMacroTotal(day, "calories")),
            mealCount: day.meals.length,
        };
        const monthKey = day.date.slice(0, 7);
        let month = months.get(monthKey);
        if (!month) {
            month = { month: monthKey, calories: 0, mealCount: 0, weeks: [] };
            months.set(monthKey, month);
        }
        const weekStart = sundayOf(day.date);
        let week = month.weeks.find((w) => w.weekStart === weekStart);
        if (!week) {
            week = { weekStart, calories: 0, mealCount: 0, days: [] };
            month.weeks.push(week);
        }
        week.days.push(entry);
        week.calories = round1(week.calories + entry.calories);
        week.mealCount += entry.mealCount;
        month.calories = round1(month.calories + entry.calories);
        month.mealCount += entry.mealCount;
    }
    return [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}
