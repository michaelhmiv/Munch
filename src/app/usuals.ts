import type { NutrientValues } from "../food-providers/types.js";
import { normalizeSavedFoodLabel } from "../saved-foods/repository.js";

/**
 * "Your usuals": deterministic resurfacing of foods the user has already
 * logged, computed over their own history for one meal slot and one day
 * class (weekday vs weekend). This is resurfacing, never recommending:
 * a food can only appear here if the user logged it at least
 * USUAL_MIN_LOG_COUNT times in the same slot and day class, and the
 * prefilled portion is the median quantity at that food's dominant unit
 * across those logs. No AI, no new foods, no cross-user data.
 */

export const USUAL_MIN_LOG_COUNT = 3;
export const USUAL_MAX_RESULTS = 6;
/** History window scanned for usuals: roughly six months of logs. */
export const USUAL_HISTORY_WINDOW_DAYS = 182;

export type UsualMealType = "breakfast" | "lunch" | "dinner" | "snack";
export type UsualDayClass = "weekday" | "weekend";

export const USUAL_MEAL_TYPES: readonly UsualMealType[] = [
    "breakfast",
    "lunch",
    "dinner",
    "snack",
];

export function isUsualMealType(value: string): value is UsualMealType {
    return (USUAL_MEAL_TYPES as readonly string[]).includes(value);
}

/** Day class of a local calendar date (YYYY-MM-DD): Sat/Sun are weekend. */
export function dayClassForLocalDate(localDate: string): UsualDayClass {
    const day = new Date(`${localDate}T12:00:00Z`).getUTCDay();
    return day === 0 || day === 6 ? "weekend" : "weekday";
}

/**
 * One past log of one food, already filtered to the requested meal slot.
 * `nutrients` are the stored totals for the item as logged (the meal-item
 * row stores scaled totals, not per-quantity values).
 */
export interface UsualObservation {
    /** Local calendar date (user timezone) of the meal that carried it. */
    localDate: string;
    /** Instant the meal was logged; orders recency within a date. */
    loggedAt: string;
    name: string;
    provider: string | null;
    providerFoodId: string | null;
    portionLabel: string | null;
    quantity: number | null;
    nutrients: NutrientValues;
}

export interface UsualFood {
    key: string;
    name: string;
    provider: string | null;
    providerFoodId: string | null;
    /** The dominant unit label across this context's logs. */
    portionLabel: string | null;
    /** Median quantity at the dominant unit. */
    quantity: number;
    /**
     * Per-quantity nutrient values (median across the dominant-unit
     * logs). The meal-create path treats supplied nutrients as
     * per-quantity and scales by `quantity`, so quantity × nutrients
     * reproduces the user's median logged totals.
     */
    nutrients: NutrientValues;
    /** Logs of this food in this slot and day class. */
    logCount: number;
    /** Most recent local date this food was logged in this context. */
    lastLoggedDate: string;
}

const NUTRIENT_KEYS = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "alcohol_g",
    "sodium_mg",
    "saturated_fat_g",
    "cholesterol_mg",
    "potassium_mg",
] as const satisfies readonly (keyof NutrientValues)[];

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle]!;
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Stored totals → per-quantity values. The meal-create path scales
 * supplied nutrients by quantity, so anything prefilled from history
 * (a usual, or a copied "same as yesterday" item) must divide the
 * stored totals back down by the logged quantity.
 */
export function nutrientsPerQuantity(
    totals: NutrientValues,
    quantity: number | null,
): NutrientValues {
    const divisor = typeof quantity === "number" && quantity > 0 ? quantity : 1;
    const result: NutrientValues = {};
    for (const key of NUTRIENT_KEYS) {
        const value = totals[key];
        if (typeof value === "number") result[key] = round2(value / divisor);
    }
    return result;
}

/**
 * Food identity: provider-grounded items key on the provider food id so
 * spelling drift in the display name cannot split one food; free-text
 * items key on the normalized name (same normalization saved foods use).
 */
export function usualFoodKey(observation: UsualObservation): string {
    if (observation.provider && observation.providerFoodId) {
        return `provider:${observation.provider}:${observation.providerFoodId}`;
    }
    return `name:${normalizeSavedFoodLabel(observation.name)}`;
}

function normalizedUnit(portionLabel: string | null): string {
    return (portionLabel ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

interface UsualGroup {
    key: string;
    observations: UsualObservation[];
}

/**
 * Compute the usuals for one target local date from slot-filtered
 * observations. Only observations whose own local date shares the
 * target's day class count toward the ranking, the threshold, and the
 * portion medians — weekday repeats surface on weekdays, weekend
 * repeats on weekends.
 *
 * Unit rule: a food's usual portion is only well-defined at one unit.
 * The dominant unit (most frequent portion label in this context) owns
 * the medians; when two units tie for most frequent there is no
 * dominant unit and the food is excluded rather than prefilled with a
 * guessed unit.
 */
export function computeUsuals(
    observations: UsualObservation[],
    targetLocalDate: string,
): UsualFood[] {
    const targetClass = dayClassForLocalDate(targetLocalDate);
    const groups = new Map<string, UsualGroup>();
    for (const observation of observations) {
        if (dayClassForLocalDate(observation.localDate) !== targetClass) {
            continue;
        }
        const key = usualFoodKey(observation);
        const group = groups.get(key) ?? { key, observations: [] };
        group.observations.push(observation);
        groups.set(key, group);
    }

    const usuals: UsualFood[] = [];
    for (const group of groups.values()) {
        if (group.observations.length < USUAL_MIN_LOG_COUNT) continue;

        const byUnit = new Map<string, UsualObservation[]>();
        for (const observation of group.observations) {
            const unit = normalizedUnit(observation.portionLabel);
            const bucket = byUnit.get(unit) ?? [];
            bucket.push(observation);
            byUnit.set(unit, bucket);
        }
        let dominantUnit: string | null = null;
        let dominantCount = 0;
        let tied = false;
        for (const [unit, bucket] of byUnit) {
            if (bucket.length > dominantCount) {
                dominantUnit = unit;
                dominantCount = bucket.length;
                tied = false;
            } else if (bucket.length === dominantCount) {
                tied = true;
            }
        }
        if (dominantUnit === null || tied) continue;

        const dominant = byUnit.get(dominantUnit)!;
        const quantities = dominant.map((observation) =>
            typeof observation.quantity === "number" && observation.quantity > 0
                ? observation.quantity
                : 1,
        );
        const nutrients: NutrientValues = {};
        for (const key of NUTRIENT_KEYS) {
            const perQuantity: number[] = [];
            for (const observation of dominant) {
                const total = observation.nutrients[key];
                if (typeof total !== "number") continue;
                const quantity =
                    typeof observation.quantity === "number" &&
                    observation.quantity > 0
                        ? observation.quantity
                        : 1;
                perQuantity.push(total / quantity);
            }
            if (perQuantity.length > 0) {
                nutrients[key] = round2(median(perQuantity));
            }
        }

        const mostRecent = [...group.observations].sort((a, b) =>
            b.loggedAt.localeCompare(a.loggedAt),
        )[0]!;
        // The label shown with the median quantity comes from the most
        // recent log at the dominant unit, so the pair always matches.
        const mostRecentDominant = [...dominant].sort((a, b) =>
            b.loggedAt.localeCompare(a.loggedAt),
        )[0]!;
        usuals.push({
            key: group.key,
            name: mostRecent.name,
            provider: mostRecent.provider,
            providerFoodId: mostRecent.providerFoodId,
            portionLabel: mostRecentDominant.portionLabel,
            quantity: round2(median(quantities)),
            nutrients,
            logCount: group.observations.length,
            lastLoggedDate: group.observations.reduce(
                (latest, observation) =>
                    observation.localDate > latest
                        ? observation.localDate
                        : latest,
                group.observations[0]!.localDate,
            ),
        });
    }

    usuals.sort(
        (a, b) =>
            b.logCount - a.logCount ||
            b.lastLoggedDate.localeCompare(a.lastLoggedDate) ||
            a.name.localeCompare(b.name),
    );
    return usuals.slice(0, USUAL_MAX_RESULTS);
}
