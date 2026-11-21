/**
 * Canonical meal-slot law (owner ruling 2026-11-12, design-authority addendum):
 *   00:00–09:59 breakfast · 10:00–14:59 lunch · 15:00–23:59 dinner
 * "snack" is a manual choice only and is never a time-of-day default.
 *
 * Mirrors public/meal-slot.js for TypeScript server modules (allowJs: false);
 * src/meal-slot.test.ts pins 24-hour + timezone parity between both files.
 */

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealSlot = "breakfast" | "lunch" | "dinner";

/** The slot for a local hour of day (0–23). */
export function mealTypeForLocalHour(hour: number): MealSlot {
    if (!Number.isFinite(hour)) return "lunch";
    const h = ((Math.trunc(hour) % 24) + 24) % 24;
    if (h < 10) return "breakfast";
    if (h < 15) return "lunch";
    return "dinner";
}

/**
 * The wall-clock hour (0–23) of `instant` in `timeZone`, or null when the
 * zone is missing/unusable so the caller can fall back.
 */
export function localHourInTimeZone(
    instant: Date,
    timeZone: string | undefined,
): number | null {
    if (!timeZone) return null;
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour: "numeric",
            hourCycle: "h23",
        }).formatToParts(instant);
        const hour = parts.find((part) => part.type === "hour")?.value;
        const parsed = Number(hour);
        return Number.isFinite(parsed) ? parsed % 24 : null;
    } catch {
        return null;
    }
}

/** Default meal slot for `instant` in `timeZone` (or local clock fallback). */
export function defaultMealType(
    instant: Date = new Date(),
    timeZone?: string,
): MealSlot {
    const zonedHour = localHourInTimeZone(instant, timeZone);
    if (zonedHour != null) return mealTypeForLocalHour(zonedHour);
    return mealTypeForLocalHour(instant.getHours());
}
