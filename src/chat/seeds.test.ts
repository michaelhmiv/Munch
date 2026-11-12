import { describe, expect, test } from "bun:test";
import { assembleEntrySeed, type ChatSeedDependencies } from "./seeds.js";

const totals = {
    calories: 640,
    proteinG: 41,
    carbsG: 70,
    fatG: 18,
    fiberG: 6,
};

function deps(
    partial: Partial<ChatSeedDependencies> = {},
): ChatSeedDependencies {
    return {
        profile: async () => ({ timezone: "UTC" }),
        today: async () =>
            ({
                totals,
                meals: [
                    {
                        description: "Eggs and toast",
                        meal_type: "breakfast",
                        calories: 320,
                    },
                    {
                        description: "Chicken salad",
                        meal_type: "lunch",
                        calories: 320,
                    },
                ],
            }) as never,
        goals: async () =>
            ({
                daily_calories: 2000,
                daily_protein_g: null,
                daily_carbs_g: null,
                daily_fat_g: null,
                daily_fiber_g: null,
            }) as never,
        history: async () =>
            ({
                totals: { ...totals, calories: 9100 },
                meals: [{ description: "Soup" }, { description: "Pasta" }],
                endDate: "2026-11-10",
            }) as never,
        pantry: async () =>
            ({
                items: [
                    {
                        id: "pantry-1",
                        name: "Chicken thighs",
                        normalized_name: "chicken thighs",
                        quantity: 2,
                        unit: "lb",
                        quantity_mode: "exact",
                        stock_state: "available",
                        location: "fridge",
                        food_provider: null,
                        provider_food_id: null,
                    },
                    {
                        id: "pantry-2",
                        name: "Spinach",
                        normalized_name: "spinach",
                        quantity: 1,
                        unit: "bag",
                        quantity_mode: "exact",
                        stock_state: "available",
                        location: "fridge",
                        food_provider: null,
                        provider_food_id: null,
                    },
                ],
            }) as never,
        preferences: async () =>
            ({
                objective: "maintain",
                allergies: [],
                excluded_ingredients: ["anchovies"],
                disliked_ingredients: [],
                liked_ingredients: [],
                cuisines: [],
            }) as never,
        recipes: async () =>
            [
                {
                    recipe_id: "recipe-skillet",
                    revision_id: "rev-skillet",
                    name: "Chicken spinach skillet",
                    servings: 2,
                    nutrition_per_serving: {
                        calories: 480,
                        protein_g: 42,
                        carbs_g: 12,
                        fat_g: 28,
                        fiber_g: 4,
                    },
                    total_minutes: 30,
                    ingredients: [
                        { name: "Chicken thighs" },
                        { name: "Spinach" },
                        { name: "Garlic" },
                    ],
                },
                {
                    recipe_id: "recipe-rice-bowl",
                    revision_id: "rev-rice-bowl",
                    name: "Rice bowl",
                    servings: 2,
                    nutrition_per_serving: {
                        calories: 620,
                        protein_g: 35,
                        carbs_g: 70,
                        fat_g: 20,
                        fiber_g: 3,
                    },
                    total_minutes: 25,
                    ingredients: [{ name: "Rice" }, { name: "Chicken thighs" }],
                },
            ] as never,
        plan: async () => [] as never,
        features: async () => ({
            plan: true,
            recipes: true,
            groceries: true,
            pantry: true,
            cooks: true,
        }),
        ...partial,
    };
}

const FEATURES_OFF = {
    plan: false,
    recipes: false,
    groceries: false,
    pantry: false,
    cooks: false,
};

describe("chat v2 entry seeds", () => {
    test("today: summary, opener, and data come from the live workspace", async () => {
        const seed = await assembleEntrySeed("user-1", "today", deps());
        expect(seed.surface).toBe("today");
        expect(seed.summary).toContain("640 kcal");
        expect(seed.summary).toContain("2 meals");
        expect(seed.summary).toContain("2,000 kcal");
        expect(seed.opener).toContain("logged 2 meals");
        expect(seed.starters.length).toBeGreaterThan(0);
        const data = seed.data as { meals: unknown[]; totals: unknown };
        expect(data.meals).toHaveLength(2);
        expect(data.totals).toEqual(totals);
    });

    test("meal_plan: an empty week reports every day as a gap", async () => {
        const seed = await assembleEntrySeed("user-1", "meal_plan", deps());
        expect(seed.summary).toContain("0 of 7 days");
        expect(seed.opener.toLowerCase()).toContain("gap");
        const data = seed.data as {
            days: Array<{ entries: unknown[] }>;
        };
        expect(data.days).toHaveLength(7);
        expect(data.days.every((day) => day.entries.length === 0)).toBe(true);
    });

    test("plan brain: the seed assembles pantry, pantry-split candidates, and goals context", async () => {
        const seed = await assembleEntrySeed("user-1", "meal_plan", deps());
        const data = seed.data as {
            job: string;
            pantry: { available: boolean; items: Array<{ name: string }> };
            recipe_candidates: Array<{
                name: string;
                uses_from_pantry: string[] | null;
                to_buy: string[] | null;
            }>;
            goals_context: {
                objective: string;
                never_suggest: string[];
            } | null;
            allergy_filter: { applied: boolean };
        };
        expect(data.job).toBe("pantry_first_dinner_ideas");
        expect(data.pantry.available).toBe(true);
        expect(data.pantry.items.map((item) => item.name)).toEqual([
            "Chicken thighs",
            "Spinach",
        ]);
        const skillet = data.recipe_candidates.find(
            (candidate) => candidate.name === "Chicken spinach skillet",
        );
        expect(skillet?.uses_from_pantry).toContain("Chicken thighs");
        expect(skillet?.uses_from_pantry).toContain("Spinach");
        expect(skillet?.to_buy).toContain("Garlic");
        const riceBowl = data.recipe_candidates.find(
            (candidate) => candidate.name === "Rice bowl",
        );
        expect(riceBowl?.uses_from_pantry).toContain("Chicken thighs");
        expect(riceBowl?.to_buy).toContain("Rice");
        expect(data.goals_context?.objective).toBe("maintain weight");
        expect(data.goals_context?.never_suggest).toEqual(["anchovies"]);
        expect(data.allergy_filter.applied).toBe(true);
        expect(seed.starters).toContain(
            "Three dinners from my pantry this week",
        );
        expect(seed.opener).toContain("Chicken thighs");
    });

    test("plan brain: the allergy filter excludes a planted recipe and allergen pantry stock", async () => {
        const seed = await assembleEntrySeed(
            "user-1",
            "meal_plan",
            deps({
                preferences: async () =>
                    ({
                        objective: "maintain",
                        allergies: ["peanut"],
                        excluded_ingredients: [],
                        disliked_ingredients: [],
                        liked_ingredients: [],
                        cuisines: [],
                    }) as never,
                recipes: async () =>
                    [
                        {
                            recipe_id: "recipe-peanut",
                            revision_id: "rev-peanut",
                            name: "Peanut noodles",
                            servings: 2,
                            nutrition_per_serving: {
                                calories: 700,
                                protein_g: 24,
                                carbs_g: 80,
                                fat_g: 30,
                                fiber_g: 5,
                            },
                            total_minutes: 20,
                            ingredients: [
                                { name: "Peanut butter" },
                                { name: "Noodles" },
                            ],
                        },
                        {
                            recipe_id: "recipe-skillet",
                            revision_id: "rev-skillet",
                            name: "Chicken spinach skillet",
                            servings: 2,
                            nutrition_per_serving: {
                                calories: 480,
                                protein_g: 42,
                                carbs_g: 12,
                                fat_g: 28,
                                fiber_g: 4,
                            },
                            total_minutes: 30,
                            ingredients: [
                                { name: "Chicken thighs" },
                                { name: "Spinach" },
                            ],
                        },
                    ] as never,
                pantry: async () =>
                    ({
                        items: [
                            {
                                id: "pantry-1",
                                name: "Chicken thighs",
                                normalized_name: "chicken thighs",
                                quantity: 2,
                                unit: "lb",
                                quantity_mode: "exact",
                                stock_state: "available",
                                location: "fridge",
                                food_provider: null,
                                provider_food_id: null,
                            },
                            {
                                id: "pantry-3",
                                name: "Peanut butter",
                                normalized_name: "peanut butter",
                                quantity: 1,
                                unit: "jar",
                                quantity_mode: "exact",
                                stock_state: "available",
                                location: "pantry",
                                food_provider: null,
                                provider_food_id: null,
                            },
                        ],
                    }) as never,
            }),
        );
        const data = seed.data as {
            pantry: { items: Array<{ name: string }> };
            recipe_candidates: Array<{ name: string }>;
            allergy_filter: {
                applied: boolean;
                recipes_excluded: number;
                pantry_items_excluded: number;
            };
        };
        expect(
            data.recipe_candidates.map((candidate) => candidate.name),
        ).toEqual(["Chicken spinach skillet"]);
        expect(data.allergy_filter.applied).toBe(true);
        expect(data.allergy_filter.recipes_excluded).toBe(1);
        expect(data.allergy_filter.pantry_items_excluded).toBe(1);
        expect(data.pantry.items.map((item) => item.name)).toEqual([
            "Chicken thighs",
        ]);
        expect(JSON.stringify(seed.data)).not.toContain("Peanut noodles");
        expect(seed.summary).toContain("Allergy filter on (peanut)");
    });

    test("plan brain: a failed preferences read leaves the filter visibly unapplied", async () => {
        const seed = await assembleEntrySeed(
            "user-1",
            "meal_plan",
            deps({
                preferences: async () => {
                    throw new Error("preferences unavailable");
                },
            }),
        );
        const data = seed.data as {
            recipe_candidates: unknown[];
            goals_context: unknown;
            allergy_filter: { applied: boolean };
        };
        // The seed still assembles; the unapplied filter is recorded
        // in the data rather than silently implying safety.
        expect(data.allergy_filter.applied).toBe(false);
        expect(data.goals_context).toBeNull();
        expect(data.recipe_candidates.length).toBeGreaterThan(0);
    });

    test("pantry: names the items on hand", async () => {
        const seed = await assembleEntrySeed("user-1", "pantry", deps());
        expect(seed.summary).toContain("2 items on hand");
        expect(seed.summary).toContain("Chicken thighs");
        expect(seed.opener).toContain("Spinach");
        const data = seed.data as { items: Array<{ name: string }> };
        expect(data.items.map((item) => item.name)).toEqual([
            "Chicken thighs",
            "Spinach",
        ]);
    });

    test("insights: summarizes the last seven days", async () => {
        const seed = await assembleEntrySeed("user-1", "insights", deps());
        expect(seed.summary).toContain("Last 7 days");
        expect(seed.summary).toContain("9,100 kcal");
        expect(seed.summary).toContain("2 meals");
        expect(seed.starters).toContain("Explain my week");
        // Interpretation only (no-prescription law): the seed never
        // offers to suggest a change.
        expect(seed.opener.toLowerCase()).not.toContain("suggest");
        expect(seed.opener.toLowerCase()).not.toContain("change");
        for (const starter of seed.starters) {
            expect(starter.toLowerCase()).not.toContain("change");
        }
        // The seed is a starting point, not a fence (brain-icon
        // addendum refinement): the opener states the starting scope
        // and invites widening to a month or a year, and one starter
        // is itself a widening ask.
        expect(seed.opener).toContain("starts with your last seven days");
        expect(seed.opener).toContain("ask about a month or a year");
        expect(seed.starters).toContain("How about last month?");
    });

    test("feature toggles: a disabled module's surface has no seed (T3)", async () => {
        const pantrySeed = await assembleEntrySeed(
            "user-1",
            "pantry",
            deps({ features: async () => ({ ...FEATURES_OFF, plan: true }) }),
        );
        expect(pantrySeed).toBeNull();
        const planSeed = await assembleEntrySeed(
            "user-1",
            "meal_plan",
            deps({
                features: async () => ({ ...FEATURES_OFF, pantry: true }),
            }),
        );
        expect(planSeed).toBeNull();
        // Core surfaces are never gated.
        const todaySeed = await assembleEntrySeed(
            "user-1",
            "today",
            deps({ features: async () => FEATURES_OFF }),
        );
        expect(todaySeed?.surface).toBe("today");
    });

    test("feature toggles: the meal-plan seed never offers a disabled module (T3)", async () => {
        // Plan brain module-off honesty (plan-brain brief): with
        // Pantry off, no pantry context is gathered and the opener
        // SAYS the conversation cannot plan from the pantry — naming
        // the off module is the honest behavior, silently pitching
        // pantry ideas was the defect. Actions for off modules are
        // still never offered.
        const seed = await assembleEntrySeed(
            "user-1",
            "meal_plan",
            deps({
                features: async () => ({
                    plan: true,
                    recipes: true,
                    groceries: false,
                    pantry: false,
                    cooks: false,
                }),
            }),
        );
        expect(seed?.opener).toContain("Pantry is off");
        expect(seed?.opener).toContain("saved recipes");
        const offData = seed?.data as {
            pantry: { available: boolean; module_off?: boolean };
            recipe_candidates: Array<{
                uses_from_pantry: unknown;
                to_buy: unknown;
            }>;
        };
        expect(offData.pantry).toEqual({
            available: false,
            module_off: true,
        });
        // No pantry read → no coverage split is claimed.
        expect(
            offData.recipe_candidates.every(
                (candidate) =>
                    candidate.uses_from_pantry === null &&
                    candidate.to_buy === null,
            ),
        ).toBe(true);
        expect(seed?.starters).not.toContain(
            "Three dinners from my pantry this week",
        );
        expect(seed?.starters).not.toContain(
            "Build the grocery list from this plan",
        );

        const recipesOff = await assembleEntrySeed(
            "user-1",
            "meal_plan",
            deps({
                features: async () => ({
                    plan: true,
                    recipes: false,
                    groceries: true,
                    pantry: true,
                    cooks: true,
                }),
            }),
        );
        expect(recipesOff?.opener).toContain("pantry");
        expect(recipesOff?.opener).not.toContain("saved recipes");
        const recipesOffData = recipesOff?.data as {
            recipe_candidates: unknown[];
        };
        expect(recipesOffData.recipe_candidates).toEqual([]);
        expect(recipesOff?.starters).toContain(
            "Build the grocery list from this plan",
        );
    });

    test("a failing gatherer degrades the seed instead of throwing", async () => {
        const seed = await assembleEntrySeed(
            "user-1",
            "pantry",
            deps({
                pantry: async () => {
                    throw new Error("pantry unavailable");
                },
            }),
        );
        expect(seed.surface).toBe("pantry");
        expect(seed.summary).toContain("could not be read");
        expect(seed.starters.length).toBeGreaterThan(0);
    });
});
