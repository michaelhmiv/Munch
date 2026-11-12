/**
 * Forward view (cohesion program, Nov 11): the projected macros of a
 * future day, computed deterministically from that day's planned meals.
 * Pure arithmetic over planned-meal nutrition — no AI anywhere in this
 * path (the owner's AI-benefit test: a screen can do this math, so a
 * screen does).
 *
 * Honesty rules, from the spec:
 * - A planned meal counts only when its recipe carries nutrition
 *   (per-serving calories present — the same signal the "Planned
 *   today" list already uses). A meal without nutrition is reported
 *   in `notCounted`, never silently folded in as zero.
 * - `partial` is true when at least one planned meal is not counted:
 *   the totals then describe only part of the plan and the UI must
 *   say so.
 * - Within a counted meal, a missing sub-nutrient contributes 0 — the
 *   same convention as sumNutrition over logged meals.
 */

export interface PlannedMealNutritionInput {
    planned_date?: string;
    meal_slot?: string | null;
    recipe_id?: string;
    recipe_name: string;
    servings: number;
    nutrition_per_serving?: {
        calories?: number;
        protein_g?: number;
        carbs_g?: number;
        fat_g?: number;
        fiber_g?: number;
        sugar_g?: number;
        sodium_mg?: number;
    } | null;
}

export interface ProjectedTotals {
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    fiberG: number;
    sugarG: number;
    sodiumMg: number;
}

export interface NotCountedPlannedMeal {
    recipe_name: string;
    meal_slot: string | null;
    servings: number;
}

export interface PlannedDayProjection {
    /** Summed over counted meals only. */
    totals: ProjectedTotals;
    /** Per-meal scaled nutrition for counted meals, input order kept. */
    meals: Array<{
        recipe_name: string;
        meal_slot: string | null;
        servings: number;
        calories: number;
        proteinG: number;
        carbsG: number;
        fatG: number;
        fiberG: number;
        sugarG: number;
        sodiumMg: number;
    }>;
    countedMeals: number;
    /** Planned meals whose recipe nutrition is unavailable. */
    notCounted: NotCountedPlannedMeal[];
    /** True when some planned meals could not be counted. */
    partial: boolean;
}

function zeroTotals(): ProjectedTotals {
    return {
        calories: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        fiberG: 0,
        sugarG: 0,
        sodiumMg: 0,
    };
}

function scaled(meal: PlannedMealNutritionInput): ProjectedTotals | null {
    const perServing = meal.nutrition_per_serving;
    if (
        !perServing ||
        typeof perServing.calories !== "number" ||
        !Number.isFinite(perServing.calories)
    ) {
        return null;
    }
    const servings =
        typeof meal.servings === "number" && meal.servings > 0
            ? meal.servings
            : 0;
    const times = (value: number | undefined) =>
        typeof value === "number" && Number.isFinite(value)
            ? value * servings
            : 0;
    return {
        calories: times(perServing.calories),
        proteinG: times(perServing.protein_g),
        carbsG: times(perServing.carbs_g),
        fatG: times(perServing.fat_g),
        fiberG: times(perServing.fiber_g),
        sugarG: times(perServing.sugar_g),
        sodiumMg: times(perServing.sodium_mg),
    };
}

export function projectPlannedDay(
    plannedMeals: readonly PlannedMealNutritionInput[],
): PlannedDayProjection {
    const totals = zeroTotals();
    const meals: PlannedDayProjection["meals"] = [];
    const notCounted: NotCountedPlannedMeal[] = [];
    for (const meal of plannedMeals) {
        const contribution = scaled(meal);
        if (!contribution) {
            notCounted.push({
                recipe_name: meal.recipe_name,
                meal_slot: meal.meal_slot ?? null,
                servings: meal.servings,
            });
            continue;
        }
        totals.calories += contribution.calories;
        totals.proteinG += contribution.proteinG;
        totals.carbsG += contribution.carbsG;
        totals.fatG += contribution.fatG;
        totals.fiberG += contribution.fiberG;
        totals.sugarG += contribution.sugarG;
        totals.sodiumMg += contribution.sodiumMg;
        meals.push({
            recipe_name: meal.recipe_name,
            meal_slot: meal.meal_slot ?? null,
            servings: meal.servings,
            ...contribution,
        });
    }
    return {
        totals,
        meals,
        countedMeals: meals.length,
        notCounted,
        partial: notCounted.length > 0,
    };
}

/** Group planned meals by their planned_date, projecting each day. */
export function projectPlannedRange(
    plannedMeals: readonly PlannedMealNutritionInput[],
): Map<string, PlannedDayProjection> {
    const byDate = new Map<string, PlannedMealNutritionInput[]>();
    for (const meal of plannedMeals) {
        if (!meal.planned_date) continue;
        const list = byDate.get(meal.planned_date) ?? [];
        list.push(meal);
        byDate.set(meal.planned_date, list);
    }
    const result = new Map<string, PlannedDayProjection>();
    for (const [date, meals] of byDate) {
        result.set(date, projectPlannedDay(meals));
    }
    return result;
}
