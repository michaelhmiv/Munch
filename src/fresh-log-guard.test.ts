import { describe, expect, test } from "bun:test";
import {
    assertFreshMealIsStructured,
    STRUCTURED_LOG_REQUIRED_CODE,
} from "./fresh-log-guard.js";

describe("fresh structured meal guard", () => {
    test("accepts canonical itemized log_meal arguments", () => {
        expect(() =>
            assertFreshMealIsStructured({
                description: "Apple",
                meal_type: "snack",
                items: [
                    {
                        name: "Apple",
                        nutrients: { calories: 95 },
                        source_type: "usda",
                    },
                ],
            }),
        ).not.toThrow();
    });

    test("rejects stale aggregate-only calls", () => {
        expect(() =>
            assertFreshMealIsStructured({
                description: "Apple",
                meal_type: "snack",
                calories: 95,
            }),
        ).toThrow(STRUCTURED_LOG_REQUIRED_CODE);
    });

    test("rejects empty items arrays", () => {
        expect(() =>
            assertFreshMealIsStructured({
                description: "Apple",
                meal_type: "snack",
                items: [],
            }),
        ).toThrow(STRUCTURED_LOG_REQUIRED_CODE);
    });
});
