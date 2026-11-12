import { describe, expect, test } from "bun:test";

import {
    computeUsuals,
    dayClassForLocalDate,
    nutrientsPerQuantity,
    usualFoodKey,
    type UsualObservation,
} from "./usuals.js";

function observation(
    overrides: Partial<UsualObservation> & Pick<UsualObservation, "name">,
): UsualObservation {
    return {
        localDate: "2026-11-02",
        loggedAt: "2026-11-02T12:00:00.000Z",
        provider: null,
        providerFoodId: null,
        portionLabel: "1 serving",
        quantity: 1,
        nutrients: { calories: 100 },
        ...overrides,
    };
}

function on(
    name: string,
    localDate: string,
    overrides: Partial<UsualObservation> = {},
): UsualObservation {
    return observation({
        name,
        localDate,
        loggedAt: `${localDate}T12:00:00.000Z`,
        ...overrides,
    });
}

describe("dayClassForLocalDate", () => {
    test("classifies Monday–Friday as weekday and Saturday/Sunday as weekend", () => {
        expect(dayClassForLocalDate("2026-11-09")).toBe("weekday"); // Monday
        expect(dayClassForLocalDate("2026-11-06")).toBe("weekday"); // Friday
        expect(dayClassForLocalDate("2026-11-07")).toBe("weekend"); // Saturday
        expect(dayClassForLocalDate("2026-11-08")).toBe("weekend"); // Sunday
    });
});

describe("usualFoodKey", () => {
    test("provider-grounded items key on the provider food id, not the name spelling", () => {
        const a = observation({
            name: "Greek Yogurt",
            provider: "usda",
            providerFoodId: "123",
        });
        const b = observation({
            name: "greek yogurt!",
            provider: "usda",
            providerFoodId: "123",
        });
        expect(usualFoodKey(a)).toBe(usualFoodKey(b));
    });

    test("free-text items key on the normalized name", () => {
        const a = observation({ name: "Greek  Yogurt" });
        const b = observation({ name: "greek yogurt" });
        expect(usualFoodKey(a)).toBe(usualFoodKey(b));
    });
});

describe("nutrientsPerQuantity", () => {
    test("divides stored totals by the logged quantity and omits absent nutrients", () => {
        expect(
            nutrientsPerQuantity(
                { calories: 300, protein_g: 34, sodium_mg: 120 },
                2,
            ),
        ).toEqual({ calories: 150, protein_g: 17, sodium_mg: 60 });
    });

    test("treats a missing or non-positive quantity as one", () => {
        expect(nutrientsPerQuantity({ calories: 300 }, null)).toEqual({
            calories: 300,
        });
        expect(nutrientsPerQuantity({ calories: 300 }, 0)).toEqual({
            calories: 300,
        });
    });
});

describe("computeUsuals", () => {
    test("ranks by repeat count, then recency, using only the target's day class", () => {
        const observations = [
            // Oatmeal: 4 weekday logs, most recent Friday Nov 6.
            on("Steel-cut oatmeal", "2026-10-26"),
            on("Steel-cut oatmeal", "2026-10-28"),
            on("Steel-cut oatmeal", "2026-11-04"),
            on("Steel-cut oatmeal", "2026-11-06"),
            // Yogurt: 3 weekday logs, most recent Monday Nov 2.
            on("Greek yogurt", "2026-10-26"),
            on("Greek yogurt", "2026-10-30"),
            on("Greek yogurt", "2026-11-02"),
            // Eggs: 3 weekday logs, most recent Friday Nov 6 — same
            // count as yogurt, more recent, so eggs rank above yogurt.
            on("Scrambled eggs", "2026-10-28"),
            on("Scrambled eggs", "2026-11-02"),
            on("Scrambled eggs", "2026-11-06"),
            // Pancakes: 5 logs but all on weekend days — they must not
            // leak into a Monday's usuals.
            on("Pancakes", "2026-10-31"),
            on("Pancakes", "2026-11-01"),
            on("Pancakes", "2026-11-07"),
            on("Pancakes", "2026-11-08"),
            on("Pancakes", "2026-11-08", {
                loggedAt: "2026-11-08T15:00:00.000Z",
            }),
        ];
        const usuals = computeUsuals(observations, "2026-11-09");
        expect(usuals.map((usual) => usual.name)).toEqual([
            "Steel-cut oatmeal",
            "Scrambled eggs",
            "Greek yogurt",
        ]);
        expect(usuals[0]!.logCount).toBe(4);
    });

    test("weekend targets surface weekend repeats, not weekday ones", () => {
        const observations = [
            on("Pancakes", "2026-10-31"),
            on("Pancakes", "2026-11-01"),
            on("Pancakes", "2026-11-07"),
            on("Greek yogurt", "2026-11-02"),
            on("Greek yogurt", "2026-11-04"),
            on("Greek yogurt", "2026-11-06"),
            on("Greek yogurt", "2026-11-09"),
        ];
        const usuals = computeUsuals(observations, "2026-11-14");
        expect(usuals.map((usual) => usual.name)).toEqual(["Pancakes"]);
    });

    test("requires at least three logs in the context before a food surfaces", () => {
        const observations = [
            on("Greek yogurt", "2026-11-02"),
            on("Greek yogurt", "2026-11-04"),
            // A third log on a weekend day does not count toward a
            // weekday target: weekday count stays at two.
            on("Greek yogurt", "2026-11-07"),
        ];
        expect(computeUsuals(observations, "2026-11-09")).toEqual([]);
    });

    test("cold start: no history, no usuals", () => {
        expect(computeUsuals([], "2026-11-09")).toEqual([]);
    });

    test("prefills the median quantity and median per-quantity nutrients", () => {
        const observations = [
            on("Greek yogurt", "2026-11-02", {
                portionLabel: "1 container",
                quantity: 1,
                nutrients: { calories: 150, protein_g: 17 },
            }),
            on("Greek yogurt", "2026-11-04", {
                portionLabel: "1 container",
                quantity: 2,
                nutrients: { calories: 300, protein_g: 34 },
            }),
            on("Greek yogurt", "2026-11-06", {
                portionLabel: "1 container",
                quantity: 3,
                // One richer log: per-quantity calories 170, protein 20.
                nutrients: { calories: 510, protein_g: 60 },
            }),
        ];
        const [usual] = computeUsuals(observations, "2026-11-09");
        expect(usual).toMatchObject({
            name: "Greek yogurt",
            portionLabel: "1 container",
            quantity: 2,
            logCount: 3,
            lastLoggedDate: "2026-11-06",
        });
        // Per-quantity medians: calories median(150, 150, 170) = 150,
        // protein median(17, 17, 20) = 17 — so quantity × nutrients
        // reproduces the median logged totals (300 kcal, 34 g).
        expect(usual!.nutrients).toEqual({ calories: 150, protein_g: 17 });
    });

    test("mixed units resolve to the dominant unit and only its logs set the portion", () => {
        const observations = [
            on("Oatmeal", "2026-10-26", {
                portionLabel: "1 cup",
                quantity: 1,
                nutrients: { calories: 160 },
            }),
            on("Oatmeal", "2026-10-28", {
                portionLabel: "1 cup",
                quantity: 1,
                nutrients: { calories: 160 },
            }),
            on("Oatmeal", "2026-11-02", {
                portionLabel: "1 cup",
                quantity: 2,
                nutrients: { calories: 320 },
            }),
            // One log at a different unit: counted toward the repeat
            // threshold but excluded from the portion medians.
            on("Oatmeal", "2026-11-04", {
                portionLabel: "1 bowl",
                quantity: 5,
                nutrients: { calories: 900 },
            }),
        ];
        const [usual] = computeUsuals(observations, "2026-11-09");
        expect(usual).toMatchObject({
            portionLabel: "1 cup",
            quantity: 1,
            logCount: 4,
        });
        expect(usual!.nutrients).toEqual({ calories: 160 });
    });

    test("a tie for the dominant unit excludes the food instead of guessing a unit", () => {
        const observations = [
            on("Oatmeal", "2026-10-26", { portionLabel: "1 cup" }),
            on("Oatmeal", "2026-10-28", { portionLabel: "1 cup" }),
            on("Oatmeal", "2026-11-02", { portionLabel: "1 bowl" }),
            on("Oatmeal", "2026-11-04", { portionLabel: "1 bowl" }),
        ];
        expect(computeUsuals(observations, "2026-11-09")).toEqual([]);
    });

    test("caps the row at six usuals", () => {
        const observations: UsualObservation[] = [];
        for (let food = 0; food < 8; food += 1) {
            for (const date of ["2026-11-02", "2026-11-04", "2026-11-06"]) {
                observations.push(on(`Food ${food}`, date));
            }
        }
        expect(computeUsuals(observations, "2026-11-09")).toHaveLength(6);
    });
});
