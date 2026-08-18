import { describe, expect, test } from "bun:test";
import { calculateDateRangeDays } from "./analytics.js";

describe("analytics date range metadata", () => {
    test("records one day for a single-date request", () => {
        expect(calculateDateRangeDays("2026-08-18")).toBe(1);
        expect(
            calculateDateRangeDays("2026-08-18", "2026-08-18"),
        ).toBe(1);
    });

    test("records inclusive days for a multi-day range", () => {
        expect(
            calculateDateRangeDays("2026-08-18", "2026-08-20"),
        ).toBe(3);
    });

    test("ignores missing or malformed start dates", () => {
        expect(calculateDateRangeDays()).toBeUndefined();
        expect(calculateDateRangeDays("not-a-date", "2026-08-20")).toBeUndefined();
    });
});
