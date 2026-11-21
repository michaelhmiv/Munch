import { describe, expect, test } from "bun:test";
import {
    mealTypeForLocalHour as serverHour,
    defaultMealType as serverDefault,
    localHourInTimeZone as serverLocalHour,
} from "./meal-slot.js";
import {
    mealTypeForLocalHour as webHour,
    defaultMealType as webDefault,
    localHourInTimeZone as webLocalHour,
} from "../public/meal-slot.js";

/**
 * Parity lock: the server-side canonical meal-slot module
 * (src/meal-slot.ts) must agree with the browser module
 * (public/meal-slot.js) on every hour and timezone, so bulk import's
 * time-of-day inference can never drift from the app's meal-slot law
 * again (W2 data-integrity F4). "snack" is never a time default.
 */
describe("src/meal-slot.ts ↔ public/meal-slot.js parity", () => {
    test("mealTypeForLocalHour agrees on every hour and edge inputs", () => {
        for (let h = 0; h < 24; h++) {
            expect(serverHour(h)).toBe(webHour(h));
            expect(serverHour(h)).not.toBe("snack");
        }
        expect(serverHour(Number.NaN)).toBe(webHour(Number.NaN));
        expect(serverHour(-1)).toBe(webHour(-1));
        expect(serverHour(24)).toBe(webHour(24));
        expect(serverHour(9.9)).toBe(webHour(9.9));
    });

    test("localHourInTimeZone agrees across zones", () => {
        const zones = [
            "UTC",
            "America/New_York",
            "America/Los_Angeles",
            "Asia/Tokyo",
            "Europe/Kyiv",
        ];
        // One instant per hour across two days (covers EST/EDT offsets).
        for (const tz of zones) {
            for (let i = 0; i < 48; i++) {
                const instant = new Date(Date.UTC(2026, 0, 15, i % 24, 30));
                instant.setUTCDate(15 + Math.floor(i / 24));
                expect(serverLocalHour(instant, tz)).toBe(
                    webLocalHour(instant, tz),
                );
            }
        }
        expect(serverLocalHour(new Date(), undefined)).toBeNull();
        expect(serverLocalHour(new Date(), "Not/AZone")).toBeNull();
    });

    test("defaultMealType agrees on hourly instants across zones and never returns snack", () => {
        const zones = [
            "UTC",
            "America/New_York", // EST in Jan, EDT in Jul
            "America/Los_Angeles",
            "Asia/Tokyo",
        ];
        for (const tz of zones) {
            for (const month of [0, 6]) {
                for (let h = 0; h < 24; h++) {
                    const instant = new Date(Date.UTC(2026, month, 15, h, 45));
                    const server = serverDefault(instant, tz);
                    expect(server).toBe(webDefault(instant, tz));
                    expect(server).not.toBe("snack");
                }
            }
        }
    });
});
