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
 * local time of day. The boundaries are the owner's ruling of
 * 2026-11-12: 00:00–10:00 Breakfast, 10:00–15:00 Lunch,
 * 15:00–24:00 Dinner — snack is never a time default.
 */
describe("mealTypeForLocalHour boundaries (owner ruling)", () => {
    test("00:00–09:59 is breakfast", () => {
        expect(mealTypeForLocalHour(0)).toBe("breakfast");
        expect(mealTypeForLocalHour(5)).toBe("breakfast");
        expect(mealTypeForLocalHour(9)).toBe("breakfast");
    });
    test("10:00–14:59 is lunch", () => {
        expect(mealTypeForLocalHour(10)).toBe("lunch");
        expect(mealTypeForLocalHour(11)).toBe("lunch");
        expect(mealTypeForLocalHour(14)).toBe("lunch");
    });
    test("15:00–23:59 is dinner", () => {
        expect(mealTypeForLocalHour(15)).toBe("dinner");
        expect(mealTypeForLocalHour(16)).toBe("dinner");
        expect(mealTypeForLocalHour(17)).toBe("dinner");
        expect(mealTypeForLocalHour(21)).toBe("dinner");
        expect(mealTypeForLocalHour(22)).toBe("dinner");
        expect(mealTypeForLocalHour(23)).toBe("dinner");
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
    test("04:59 ET and 05:00 ET are both breakfast", () => {
        expect(defaultMealType(new Date("2026-11-12T09:59:00Z"), zone)).toBe(
            "breakfast",
        );
        expect(defaultMealType(new Date("2026-11-12T10:00:00Z"), zone)).toBe(
            "breakfast",
        );
    });
    test("09:59 ET is breakfast, 10:00 ET is lunch", () => {
        expect(defaultMealType(new Date("2026-11-12T14:59:00Z"), zone)).toBe(
            "breakfast",
        );
        expect(defaultMealType(new Date("2026-11-12T15:00:00Z"), zone)).toBe(
            "lunch",
        );
    });
    test("14:59 ET is lunch, 15:00 ET is dinner", () => {
        expect(defaultMealType(new Date("2026-11-12T19:59:00Z"), zone)).toBe(
            "lunch",
        );
        expect(defaultMealType(new Date("2026-11-12T20:00:00Z"), zone)).toBe(
            "dinner",
        );
    });
    test("16:59 ET and 17:00 ET are both dinner", () => {
        expect(defaultMealType(new Date("2026-11-12T21:59:00Z"), zone)).toBe(
            "dinner",
        );
        expect(defaultMealType(new Date("2026-11-12T22:00:00Z"), zone)).toBe(
            "dinner",
        );
    });
    test("21:59 ET and 22:00 ET are both dinner", () => {
        expect(defaultMealType(new Date("2026-11-13T02:59:00Z"), zone)).toBe(
            "dinner",
        );
        expect(defaultMealType(new Date("2026-11-13T03:00:00Z"), zone)).toBe(
            "dinner",
        );
    });
    test("the same instant reads differently in another zone (timezone is honored)", () => {
        // 16:00Z is 11:00 in New York (lunch) and 08:00 in Los
        // Angeles (breakfast).
        const instant = new Date("2026-11-12T16:00:00Z");
        expect(defaultMealType(instant, zone)).toBe("lunch");
        expect(defaultMealType(instant, "America/Los_Angeles")).toBe(
            "breakfast",
        );
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
        expect(defaultMealType(instant, zone)).toBe("breakfast");
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
