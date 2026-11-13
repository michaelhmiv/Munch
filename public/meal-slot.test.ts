import { describe, expect, test } from "bun:test";
import {
    defaultMealType,
    localHourInTimeZone,
    mealTypeForLocalHour,
} from "./meal-slot.js";

/**
 * Photo-flow audit (2026-11-12): the Log-by-photo dialog defaulted
 * to "Lunch" at 6:46 PM because the default was a static HTML
 * `selected` attribute. These tests pin the slot boundaries in the
 * user's timezone (America/New_York) so the default follows the
 * local time of day.
 */
describe("mealTypeForLocalHour boundaries", () => {
    test("05:00–10:59 is breakfast", () => {
        expect(mealTypeForLocalHour(5)).toBe("breakfast");
        expect(mealTypeForLocalHour(10)).toBe("breakfast");
    });
    test("11:00–14:59 is lunch", () => {
        expect(mealTypeForLocalHour(11)).toBe("lunch");
        expect(mealTypeForLocalHour(14)).toBe("lunch");
    });
    test("15:00–16:59 is snack (afternoon)", () => {
        expect(mealTypeForLocalHour(15)).toBe("snack");
        expect(mealTypeForLocalHour(16)).toBe("snack");
    });
    test("17:00–21:59 is dinner", () => {
        expect(mealTypeForLocalHour(17)).toBe("dinner");
        expect(mealTypeForLocalHour(21)).toBe("dinner");
    });
    test("22:00–04:59 is snack (late night / early morning)", () => {
        expect(mealTypeForLocalHour(22)).toBe("snack");
        expect(mealTypeForLocalHour(23)).toBe("snack");
        expect(mealTypeForLocalHour(0)).toBe("snack");
        expect(mealTypeForLocalHour(4)).toBe("snack");
    });
});

describe("defaultMealType in America/New_York", () => {
    const zone = "America/New_York";
    // 2026-11-12 is EST (UTC-5); the instants below are chosen on
    // exact local-hour boundaries.
    test("Michael's case: 18:46 ET (23:46Z) defaults to dinner", () => {
        expect(defaultMealType(new Date("2026-11-12T23:46:00Z"), zone)).toBe(
            "dinner",
        );
    });
    test("04:59 ET is snack, 05:00 ET is breakfast", () => {
        expect(defaultMealType(new Date("2026-11-12T09:59:00Z"), zone)).toBe(
            "snack",
        );
        expect(defaultMealType(new Date("2026-11-12T10:00:00Z"), zone)).toBe(
            "breakfast",
        );
    });
    test("10:59 ET is breakfast, 11:00 ET is lunch", () => {
        expect(defaultMealType(new Date("2026-11-12T15:59:00Z"), zone)).toBe(
            "breakfast",
        );
        expect(defaultMealType(new Date("2026-11-12T16:00:00Z"), zone)).toBe(
            "lunch",
        );
    });
    test("14:59 ET is lunch, 15:00 ET is snack", () => {
        expect(defaultMealType(new Date("2026-11-12T19:59:00Z"), zone)).toBe(
            "lunch",
        );
        expect(defaultMealType(new Date("2026-11-12T20:00:00Z"), zone)).toBe(
            "snack",
        );
    });
    test("16:59 ET is snack, 17:00 ET is dinner", () => {
        expect(defaultMealType(new Date("2026-11-12T21:59:00Z"), zone)).toBe(
            "snack",
        );
        expect(defaultMealType(new Date("2026-11-12T22:00:00Z"), zone)).toBe(
            "dinner",
        );
    });
    test("21:59 ET is dinner, 22:00 ET is snack", () => {
        expect(defaultMealType(new Date("2026-11-13T02:59:00Z"), zone)).toBe(
            "dinner",
        );
        expect(defaultMealType(new Date("2026-11-13T03:00:00Z"), zone)).toBe(
            "snack",
        );
    });
    test("the same instant reads differently in another zone (timezone is honored)", () => {
        // 23:46Z is 15:46 in Los Angeles — snack there, dinner in NY.
        expect(
            defaultMealType(
                new Date("2026-11-12T23:46:00Z"),
                "America/Los_Angeles",
            ),
        ).toBe("snack");
    });
    test("DST: a summer evening (EDT, UTC-4) still lands on dinner", () => {
        // 2026-07-15T23:30Z = 19:30 EDT.
        expect(defaultMealType(new Date("2026-07-15T23:30:00Z"), zone)).toBe(
            "dinner",
        );
    });
    test("midnight in the zone reads hour 0, not 24", () => {
        const instant = new Date("2026-11-12T05:00:00Z"); // 00:00 EST
        expect(localHourInTimeZone(instant, zone)).toBe(0);
        expect(defaultMealType(instant, zone)).toBe("snack");
    });
});

describe("defaultMealType fallbacks", () => {
    test("an unusable timezone falls back to the device-local hour", () => {
        const instant = new Date("2026-11-12T23:46:00Z");
        expect(localHourInTimeZone(instant, "Not/AZone")).toBeNull();
        expect(defaultMealType(instant, "Not/AZone")).toBe(
            mealTypeForLocalHour(instant.getHours()),
        );
        expect(defaultMealType(instant, undefined)).toBe(
            mealTypeForLocalHour(instant.getHours()),
        );
    });
});
