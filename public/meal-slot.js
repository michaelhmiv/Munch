/**
 * Smart meal-type default: the slot a meal most likely belongs to,
 * from the local time of day in the user's timezone.
 *
 * The photo dialog used to hard-code "Lunch" (a static `selected`
 * attribute in the markup, plus a `"lunch"` fallback in the submit
 * path), so a 6:46 PM dinner photo opened as Lunch. The slot now
 * follows the clock: the packaged app and the browser both know the
 * user's timezone (profile timezone from bootstrap, device local
 * time as the fallback), and the choice stays editable on the draft
 * review — this module only picks the starting value.
 *
 * Boundaries (local wall-clock), per the owner's ruling of
 * 2026-11-12 (design-authority addendum):
 *   00:00–09:59 breakfast · 10:00–14:59 lunch · 15:00–23:59 dinner
 * "Snack" stays a manual choice in the type list; it is never a
 * time-of-day default.
 */

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];

/** The slot for a local hour of day (0–23). */
export function mealTypeForLocalHour(hour) {
    if (!Number.isFinite(hour)) return "lunch";
    const h = ((Math.trunc(hour) % 24) + 24) % 24;
    if (h < 10) return "breakfast";
    if (h < 15) return "lunch";
    return "dinner";
}

/**
 * The wall-clock hour (0–23) of `instant` in `timeZone`, or null
 * when the zone is missing/unusable (Intl throws) so the caller can
 * fall back to device-local time.
 */
export function localHourInTimeZone(instant, timeZone) {
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

/**
 * The default meal type for a meal logged at `instant`: the slot of
 * the local hour in `timeZone` (the user's profile timezone), or of
 * the device's own local hour when no usable zone is supplied.
 */
export function defaultMealType(instant = new Date(), timeZone) {
    const zonedHour = localHourInTimeZone(instant, timeZone);
    if (zonedHour != null) return mealTypeForLocalHour(zonedHour);
    return mealTypeForLocalHour(instant.getHours());
}
