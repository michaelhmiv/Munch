import { describe, test, expect } from "bun:test";
import {
    buildDailyBuckets,
    computeTrends,
    computeWeekInWords,
    computeWeeklyDigest,
    computeWeightTrend,
    type DailyBucket,
} from "./insights.js";
import type { Meal, NutritionGoals, WeightEntry } from "./storage.js";

function entry(logged_at: string, weight_g: number): WeightEntry {
    return {
        id: `id-${logged_at}-${weight_g}`,
        user_id: "u1",
        weight_g,
        logged_at,
        notes: null,
        created_at: logged_at,
        idempotency_key: null,
    };
}

test("computeWeightTrend reports latest, change, range, and goal in kg", () => {
    const entries = [
        entry("2026-06-01T08:00:00Z", 80000),
        entry("2026-06-08T08:00:00Z", 79000),
        entry("2026-06-15T08:00:00Z", 78500),
    ];
    const out = computeWeightTrend(
        entries,
        "2026-06-01",
        "2026-06-15",
        "UTC",
        75000, // target 75 kg
        "kg",
    );
    expect(out).toContain(
        "Weight trend — 2026-06-01 to 2026-06-15 (3 logged days)",
    );
    expect(out).toContain("Latest: 78.5 kg (on 2026-06-15)");
    expect(out).toContain(
        "Change over range: -1.5 kg (from 80 kg on 2026-06-01)",
    );
    expect(out).toContain("Min: 78.5 kg (on 2026-06-15)");
    expect(out).toContain("Max: 80 kg (on 2026-06-01)");
    expect(out).toContain("3.5 kg to lose to reach target of 75 kg");
});

test("computeWeightTrend averages multiple weigh-ins on the same day", () => {
    const entries = [
        entry("2026-06-01T07:00:00Z", 80000),
        entry("2026-06-01T20:00:00Z", 82000), // same day -> avg 81 kg
        entry("2026-06-02T07:00:00Z", 81000),
    ];
    const out = computeWeightTrend(
        entries,
        "2026-06-01",
        "2026-06-02",
        "UTC",
        null,
        "kg",
    );
    expect(out).toContain("(2 logged days)");
    expect(out).toContain("Max: 81 kg (on 2026-06-01)"); // averaged, not 82
    expect(out).toContain("(Tip: set a target weight with set_nutrition_goals");
});

test("computeWeightTrend renders in lb and reports gaining toward target", () => {
    const entries = [
        entry("2026-06-01T08:00:00Z", 74843), // 165 lb
        entry("2026-06-10T08:00:00Z", 76203), // 168 lb
    ];
    const out = computeWeightTrend(
        entries,
        "2026-06-01",
        "2026-06-10",
        "UTC",
        79379, // ~175 lb target
        "lb",
    );
    expect(out).toContain("Latest: 168 lb (on 2026-06-10)");
    expect(out).toContain("Change over range: +3 lb");
    expect(out).toContain("to gain to reach target of 175 lb");
});

test("computeWeightTrend handles an empty range", () => {
    expect(
        computeWeightTrend([], "2026-06-01", "2026-06-30", "UTC", null, "kg"),
    ).toBe("No weight logged between 2026-06-01 and 2026-06-30.");
});

// ---------- fiber / sugar / alcohol ----------

function meal(logged_at: string, fields: Partial<Meal> = {}): Meal {
    return {
        id: `m-${logged_at}-${Math.random()}`,
        user_id: "u1",
        logged_at,
        meal_type: "lunch",
        description: "test meal",
        calories: 500,
        protein_g: 30,
        carbs_g: 50,
        fat_g: 20,
        fiber_g: null,
        sugar_g: null,
        alcohol_g: null,
        notes: null,
        idempotency_key: null,
        ...fields,
    };
}

function goals(fields: Partial<NutritionGoals> = {}): NutritionGoals {
    return {
        user_id: "u1",
        daily_calories: null,
        daily_protein_g: null,
        daily_carbs_g: null,
        daily_fat_g: null,
        daily_fiber_g: null,
        daily_sugar_g: null,
        daily_alcohol_g: null,
        daily_water_ml: null,
        target_weight_g: null,
        updated_at: "2026-06-02T00:00:00Z",
        ...fields,
    };
}

/** Two consecutive days, one meal each, with the new nutrients set. */
function twoDayBuckets(
    day1: Partial<Meal>,
    day2: Partial<Meal>,
): DailyBucket[] {
    return buildDailyBuckets(
        [
            meal("2026-06-01T12:00:00Z", day1),
            meal("2026-06-02T12:00:00Z", day2),
        ],
        [],
        "2026-06-01",
        "2026-06-02",
        "UTC",
    );
}

test("buildDailyBuckets sums fiber, sugar and alcohol per day", () => {
    const buckets = buildDailyBuckets(
        [
            meal("2026-06-01T08:00:00Z", {
                fiber_g: 5,
                sugar_g: 10,
                alcohol_g: 0,
            }),
            meal("2026-06-01T19:00:00Z", {
                fiber_g: 3,
                sugar_g: 12,
                alcohol_g: 14,
            }),
            meal("2026-06-02T12:00:00Z", { fiber_g: 7 }), // sugar/alcohol null
        ],
        [],
        "2026-06-01",
        "2026-06-02",
        "UTC",
    );
    expect(buckets[0]!.fiber_g).toBe(8);
    expect(buckets[0]!.sugar_g).toBe(22);
    expect(buckets[0]!.alcohol_g).toBe(14);
    // Nulls contribute 0 rather than NaN.
    expect(buckets[1]!.fiber_g).toBe(7);
    expect(buckets[1]!.sugar_g).toBe(0);
    expect(buckets[1]!.alcohol_g).toBe(0);
});

test("computeTrends treats fiber as a floor and sugar as a ceiling", () => {
    const buckets = twoDayBuckets(
        { fiber_g: 25, sugar_g: 50 },
        { fiber_g: 26, sugar_g: 30 },
    );
    const out = computeTrends(
        buckets,
        goals({ daily_fiber_g: 25, daily_sugar_g: 40 }),
    );

    expect(out).toContain("Fiber:");
    expect(out).toContain("  7d avg: 25.5g");
    expect(out).toContain("  Target: 25g");
    expect(out).toContain("  Days within ±10% of target: 2/2");

    expect(out).toContain("Sugar:");
    expect(out).toContain("  7d avg: 40g");
    // A limit is never described as a "target" to land on, and the count is of
    // misses, so it can never read as praise for consuming sugar.
    expect(out).toContain("  Limit: 40g");
    expect(out).toContain("  Days over limit: 1/2");
    expect(out).not.toContain("Days within ±10% of target: 1/2");
});

test("computeTrends suppresses the alcohol line when the window is all zero", () => {
    const buckets = twoDayBuckets(
        { alcohol_g: 0, sugar_g: 10, fiber_g: 8 },
        { alcohol_g: null, sugar_g: 10, fiber_g: 8 },
    );
    // Even with a limit configured, an all-zero series has nothing to trend.
    const out = computeTrends(buckets, goals({ daily_alcohol_g: 20 }));
    expect(out).not.toContain("Alcohol");
    // Fiber and sugar are always on, no toggle.
    expect(out).toContain("Fiber:");
    expect(out).toContain("Sugar:");
});

test("computeTrends shows alcohol once any day is non-zero", () => {
    const buckets = twoDayBuckets({ alcohol_g: 0 }, { alcohol_g: 14 });
    const out = computeTrends(buckets, goals({ daily_alcohol_g: 20 }));
    expect(out).toContain("Alcohol:");
    expect(out).toContain("  7d avg: 7g");
    expect(out).toContain("  Limit: 20g");
    expect(out).toContain("  Days over limit: 0/2");
});

test("computeWeeklyDigest reports fiber and sugar, calling a sugar goal a limit", () => {
    const buckets = twoDayBuckets(
        { fiber_g: 30, sugar_g: 50 },
        { fiber_g: 20, sugar_g: 70 },
    );
    const out = computeWeeklyDigest(
        buckets,
        goals({ daily_fiber_g: 30, daily_sugar_g: 40 }),
    );
    expect(out).toContain("  Fiber: 25g / 30g target (83%)");
    expect(out).toContain("  Sugar: 60g / 40g limit (150%)");
    // No alcohol logged -> no row at all.
    expect(out).not.toContain("Alcohol");
});

test("computeWeeklyDigest shows an alcohol row only when a drink was logged", () => {
    const buckets = twoDayBuckets({ alcohol_g: 0 }, { alcohol_g: 28 });
    const out = computeWeeklyDigest(buckets, goals({ daily_alcohol_g: 10 }));
    expect(out).toContain("  Alcohol: 14g / 10g limit (140%)");
});

// ---------- historical NULLs are not zeros ----------
//
// Every meal logged before fiber/sugar/alcohol shipped carries NULL for all
// three. Averaging those days as 0 reported a third of the truth against a
// target, and scored data-less days as days under a limit.

/** `days` consecutive days, one meal each, with `withData` days of nutrient
 * data at the END of the window (the shape of a mid-window deploy). */
function windowBuckets(
    days: number,
    withData: number,
    fields: Partial<Meal>,
): DailyBucket[] {
    const start = new Date("2026-06-01T00:00:00Z");
    const meals: Meal[] = [];
    for (let i = 0; i < days; i++) {
        const d = new Date(start);
        d.setUTCDate(d.getUTCDate() + i);
        const date = d.toISOString().slice(0, 10);
        meals.push(
            meal(`${date}T12:00:00Z`, i >= days - withData ? fields : {}),
        );
    }
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + days - 1);
    return buildDailyBuckets(
        meals,
        [],
        "2026-06-01",
        end.toISOString().slice(0, 10),
        "UTC",
    );
}

test("computeTrends averages a partial nutrient over its covered days only", () => {
    // 30 logged days, fiber recorded on the last 5 — exactly 30 g each.
    const buckets = windowBuckets(30, 5, { fiber_g: 30 });
    const out = computeTrends(buckets, goals({ daily_fiber_g: 30 }));

    // The reported bug: 150 g / 30 days = 5 g/day against a 30 g target.
    expect(out).not.toContain("30d avg: 5g");
    expect(out).toContain("  30d avg: 30g (5 of 30 days with data)");
    expect(out).toContain("  7d avg: 30g (5 of 7 days with data)");
    // Day counts and the spread use the same denominator.
    expect(out).toContain("  Days within ±10% of target: 5/5 days with data");
    expect(out).toContain("  Std dev: 0g (CV 0%)");
    // Calories keep counting every day, as they always have.
    expect(out).toContain("  30d avg: 500 kcal");
});

test("computeTrends counts limit misses over covered days, not the window", () => {
    // Sugar recorded on the last 4 days only, every one of them over the limit.
    const buckets = windowBuckets(30, 4, { sugar_g: 90 });
    const out = computeTrends(buckets, goals({ daily_sugar_g: 40 }));
    expect(out).toContain("  Days over limit: 4/4 days with data");
    // The old reading — a clean month — came from counting the silent days.
    expect(out).not.toContain("Days over limit: 4/30");
    expect(out).not.toContain("Days over limit: 0/30");
});

test("computeTrends drops a nutrient with no data anywhere in the window", () => {
    // A pre-feature history: meals every day, no fiber/sugar/alcohol on any.
    const buckets = windowBuckets(30, 0, {});
    const out = computeTrends(
        buckets,
        goals({ daily_fiber_g: 30, daily_sugar_g: 40, daily_alcohol_g: 0 }),
    );
    expect(out).not.toContain("Fiber");
    expect(out).not.toContain("Sugar");
    expect(out).not.toContain("Alcohol");
    // Nothing is invented for them, in particular not a zero.
    expect(out).not.toContain("0g (0 of 30");
    expect(out).toContain("Calories:");
    expect(out).toContain("Water:");
});

test("computeTrends says so when a trailing window has no data at all", () => {
    // Fiber only in the first days of the month: nothing in the last 7 or 14.
    const buckets = buildDailyBuckets(
        [
            meal("2026-06-01T12:00:00Z", { fiber_g: 20 }),
            meal("2026-06-02T12:00:00Z", { fiber_g: 20 }),
            ...Array.from({ length: 10 }, (_, i) =>
                meal(`2026-06-${String(i + 3).padStart(2, "0")}T12:00:00Z`),
            ),
        ],
        [],
        "2026-06-01",
        "2026-06-12",
        "UTC",
    );
    const out = computeTrends(buckets, goals());
    expect(out).toContain("  7d avg: no data");
    expect(out).toContain("  14d avg: 20g (2 of 12 days with data)");
});

test("computeTrends honours a limit of zero on a ceiling", () => {
    const buckets = twoDayBuckets({ alcohol_g: 14 }, { alcohol_g: 0 });
    const out = computeTrends(buckets, goals({ daily_alcohol_g: 0 }));
    // Zero is the most likely alcohol limit there is; it must not read as unset.
    expect(out).toContain("  Limit: 0g");
    expect(out).toContain("  Days over limit: 1/2 days with data");
});

test("computeTrends still treats a floor target of zero as unset", () => {
    const buckets = twoDayBuckets({ fiber_g: 20 }, { fiber_g: 30 });
    const out = computeTrends(buckets, goals({ daily_fiber_g: 0 }));
    expect(out).toContain("Fiber:");
    expect(out).not.toContain("Target: 0g");
    expect(out).not.toContain("Days within ±10%");
});

test("computeWeeklyDigest averages a partial nutrient over its covered days", () => {
    // A week logged, fiber on the last 2 days at 30 g.
    const buckets = windowBuckets(7, 2, { fiber_g: 30 });
    const out = computeWeeklyDigest(buckets, goals({ daily_fiber_g: 30 }));
    expect(out).toContain(
        "  Fiber: 30g / 30g target (100%) — over 2 of 7 days with data",
    );
    expect(out).not.toContain("Fiber: 8.6g");
});

test("computeWeeklyDigest drops rows for nutrients with no data at all", () => {
    const buckets = windowBuckets(7, 0, {});
    const out = computeWeeklyDigest(
        buckets,
        goals({ daily_fiber_g: 30, daily_sugar_g: 40 }),
    );
    expect(out).not.toContain("Fiber");
    expect(out).not.toContain("Sugar");
    expect(out).toContain("  Calories:");
});

test("computeWeeklyDigest honours a limit of zero without a percentage", () => {
    const buckets = twoDayBuckets({ alcohol_g: 14 }, { alcohol_g: 14 });
    const out = computeWeeklyDigest(buckets, goals({ daily_alcohol_g: 0 }));
    expect(out).toContain("  Alcohol: 14g / 0g limit (14g over)");
    // No Infinity/NaN percentage, and nothing that reads as budget left.
    expect(out).not.toContain("Infinity");
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("left");
});

test("computeWeeklyDigest reports a zero-limit nutrient held at zero as clear", () => {
    const buckets = twoDayBuckets({ sugar_g: 0 }, { sugar_g: 0 });
    const out = computeWeeklyDigest(buckets, goals({ daily_sugar_g: 0 }));
    expect(out).toContain("  Sugar: 0g / 0g limit (clear)");
});

// ------------------------------------------------------- week in words

function wordsBucket(
    date: string,
    values: Partial<{
        calories: number;
        protein_g: number;
        waterMl: number;
        meals: Meal[];
    }> = {},
): DailyBucket {
    const meals = values.meals ?? [
        meal({ logged_at: `${date}T12:00:00Z`, meal_type: "lunch" }),
    ];
    return {
        date,
        meals,
        waterMl: values.waterMl ?? 0,
        calories: values.calories ?? 2000,
        protein_g: values.protein_g ?? 0,
        carbs_g: 0,
        fat_g: 0,
        fiber_g: 0,
        sugar_g: 0,
        alcohol_g: 0,
        mealTypes: new Set(meals.map((m) => m.meal_type ?? "")),
    };
}

function wordsGoals(partial: Partial<NutritionGoals>): NutritionGoals {
    return {
        user_id: "u1",
        daily_calories: null,
        daily_protein_g: null,
        daily_carbs_g: null,
        daily_fat_g: null,
        daily_fiber_g: null,
        daily_sugar_g: null,
        daily_alcohol_g: null,
        daily_water_ml: null,
        target_weight_g: null,
        updated_at: "2026-11-01T00:00:00Z",
        ...partial,
    };
}

// 2026-11-02 is a Monday; the week runs Mon Nov 2 – Sun Nov 8, 2026.
const WEEK_DATES = [
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
    "2026-11-07",
    "2026-11-08",
];

describe("computeWeekInWords", () => {
    test("protein misses concentrated on weekend days are named as such", () => {
        const buckets = WEEK_DATES.map((date, i) =>
            wordsBucket(date, {
                // Sat (idx 5) and Sun (idx 6) fall short of 100g.
                protein_g: i >= 5 ? 70 : 120,
            }),
        );
        const words = computeWeekInWords(
            buckets,
            wordsGoals({ daily_protein_g: 100 }),
        );
        expect(words).toContain(
            "Protein hit your target on five of the seven days you logged; both misses were weekend days.",
        );
    });

    test("a fully-hit target says every day, with no advice anywhere", () => {
        const buckets = WEEK_DATES.map((date) =>
            wordsBucket(date, { protein_g: 130 }),
        );
        const words = computeWeekInWords(
            buckets,
            wordsGoals({ daily_protein_g: 100 }),
        );
        expect(words).toContain(
            "Protein hit your target on all seven days you logged this week.",
        );
        for (const banned of [
            "try ",
            "consider",
            "should",
            "aim for",
            "next week,",
        ]) {
            expect(words.toLowerCase()).not.toContain(banned);
        }
    });

    test("a single miss names its weekday", () => {
        const buckets = WEEK_DATES.map((date, i) =>
            wordsBucket(date, { protein_g: i === 2 ? 60 : 120 }),
        );
        const words = computeWeekInWords(
            buckets,
            wordsGoals({ daily_protein_g: 100 }),
        );
        expect(words).toContain(
            "six of the seven days you logged; the miss was on Wednesday.",
        );
    });

    test("weekend days running materially higher become a structural sentence", () => {
        const buckets = WEEK_DATES.map((date, i) =>
            wordsBucket(date, {
                calories: i >= 5 ? 2600 : 1900,
                protein_g: 120,
            }),
        );
        const words = computeWeekInWords(
            buckets,
            wordsGoals({ daily_protein_g: 100 }),
        );
        expect(words).toContain(
            "Weekend days ran higher — 2,600 kcal a day against 1,900 kcal on weekdays.",
        );
    });

    test("an empty week and a two-day week say so plainly", () => {
        const empty = WEEK_DATES.map((date) =>
            wordsBucket(date, { meals: [], calories: 0 }),
        );
        expect(computeWeekInWords(empty, null)).toContain(
            "Nothing logged in the last seven days",
        );
        const two = WEEK_DATES.map((date, i) =>
            i < 2
                ? wordsBucket(date)
                : wordsBucket(date, { meals: [], calories: 0 }),
        );
        expect(computeWeekInWords(two, null)).toContain(
            "Only two days logged in the last seven days",
        );
    });

    test("no goals and no material split yields the honest fallback, never a restated average", () => {
        const buckets = WEEK_DATES.map((date, i) =>
            wordsBucket(date, {
                calories: 2000 + (i % 2) * 40,
                protein_g: 90,
                meals: [
                    meal({
                        logged_at: `${date}T12:00:00Z`,
                        meal_type: "lunch",
                        calories: 900,
                    }),
                ],
            }),
        );
        const words = computeWeekInWords(buckets, null);
        expect(words).toContain("logged seven of the last seven days");
        expect(words).not.toContain("averaged");
        expect(words).not.toContain("Daily average");
    });
});
