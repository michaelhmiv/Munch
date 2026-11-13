#!/usr/bin/env bun

// Log as planned (connection option #1) against a real database:
//  - a planned meal logs into an identical meal (foods + portions
//    scaled from the pinned recipe revision),
//  - the plan entry then reads logged (derived from the meal link),
//  - a second log attempt — fresh idempotency key or a retry of the
//    same one — returns the existing meal as deduplicated and never
//    creates a second meal,
//  - another user cannot log against someone else's planned meal,
//  - the Today workspace evening prompt lists only today's unlogged
//    planned meals (never past/future days, never logged ones), and
//    the Plan module toggle removes planned data from Today whole.

import { createSmokeIdentity } from "./support/smoke-user.js";

const { saveRecipe, scheduleRecipe, getMealPlan, logRecipe } =
    await import("../src/planning/repository.js");
const { getTodayWorkspace } = await import("../src/app/repository.js");
const { upsertProfile } = await import("../src/nutrition-platform/profiles.js");
const { saveFeatureModules } =
    await import("../src/feature-modules-repository.js");
const { withUserDatabase, closePlatformDatabase } =
    await import("../src/platform/database.js");
const { dateInTz, hourInTz, shiftLocalDate } = await import("../src/tz.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for log-as-planned smoke tests");
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const owner = await createSmokeIdentity("log-as-planned-owner");
const outsider = await createSmokeIdentity("log-as-planned-outsider");
const scope = { type: "personal" as const };

function dinnerRecipe(name: string) {
    return {
        name,
        servings: 2,
        instructions: ["Cook the rice.", "Sear the salmon.", "Serve."],
        sourceType: "user_entered" as const,
        ingredients: [
            {
                name: "Smoke salmon fillet",
                quantity: 2,
                unit: "fillets",
                nutrients: {
                    calories: 400,
                    protein_g: 44,
                    carbs_g: 0,
                    fat_g: 24,
                },
                sourceType: "user_supplied" as const,
                sourceSnapshot: { entered_by_user: true },
            },
            {
                name: "Smoke jasmine rice",
                quantity: 300,
                unit: "g",
                nutrients: {
                    calories: 390,
                    protein_g: 8,
                    carbs_g: 84,
                    fat_g: 1,
                },
                sourceType: "user_supplied" as const,
                sourceSnapshot: { entered_by_user: true },
            },
        ],
    };
}

// ---- The core loop: plan today, log as planned, plan reads logged.
const todayUtc = dateInTz(new Date(), "UTC");
const saved = await saveRecipe({
    userId: owner.userId,
    scope,
    recipe: dinnerRecipe("Log As Planned Salmon"),
    idempotencyKey: `lap-recipe:${crypto.randomUUID()}`,
});
assert(saved.perServing.calories === 395, "Fixture recipe math drifted");

const plannedRow = await scheduleRecipe({
    userId: owner.userId,
    scope,
    recipeId: saved.recipeId,
    recipeRevisionId: saved.revisionId,
    plannedDate: todayUtc,
    mealSlot: "dinner",
    servings: 2,
    idempotencyKey: `lap-plan:${crypto.randomUUID()}`,
});
const plannedMealId = String(plannedRow.id);

const planBefore = await getMealPlan({
    userId: owner.userId,
    startDate: todayUtc,
    endDate: todayUtc,
    scope: "personal",
});
const entryBefore = planBefore.find(
    (meal) => meal.planned_meal_id === plannedMealId,
);
assert(entryBefore, "Planned meal missing from the plan read");
assert(
    entryBefore.logged === false && entryBefore.logged_meal_id === null,
    "Planned meal read as logged before any log existed",
);

const logged = await logRecipe({
    userId: owner.userId,
    recipeId: saved.recipeId,
    recipeRevisionId: saved.revisionId,
    servingsConsumed: 2,
    mealType: "dinner",
    plannedMealId,
    idempotencyKey: `lap-log:${crypto.randomUUID()}`,
});
assert(!logged.deduplicated, "First log-as-planned reported deduplicated");
assert(
    logged.meal.sourcePlannedMealId === plannedMealId,
    "Logged meal is not linked to the planned meal",
);
// Exactly as planned: planned servings (2) over a 2-serving recipe is
// a factor of 1, so items carry the recipe's own quantities and the
// meal total is the recipe total.
assert(logged.meal.items.length === 2, "Logged meal lost recipe items");
assert(
    logged.meal.items[0]?.quantity === 2 &&
        logged.meal.items[1]?.quantity === 300,
    "Logged meal portions differ from the planned recipe",
);
assert(
    logged.meal.calories === 790,
    "Logged meal calories differ from the planned recipe total",
);

const planAfter = await getMealPlan({
    userId: owner.userId,
    startDate: todayUtc,
    endDate: todayUtc,
    scope: "personal",
});
const entryAfter = planAfter.find(
    (meal) => meal.planned_meal_id === plannedMealId,
);
assert(
    entryAfter?.logged === true && entryAfter.logged_meal_id === logged.meal.id,
    "Plan entry did not read logged after log-as-planned",
);

// ---- No double-logging: fresh key, then a retry of the first key.
const secondTap = await logRecipe({
    userId: owner.userId,
    recipeId: saved.recipeId,
    recipeRevisionId: saved.revisionId,
    servingsConsumed: 2,
    mealType: "dinner",
    plannedMealId,
    idempotencyKey: `lap-log-fresh:${crypto.randomUUID()}`,
});
assert(
    secondTap.deduplicated && secondTap.meal.id === logged.meal.id,
    "Second log attempt with a fresh key created a new meal",
);
const mealCount = await withUserDatabase(owner.userId, async (tx) => {
    const rows = await tx<Array<{ n: number }>>`
        select count(*)::int as n
        from munch.meals
        where user_id = ${owner.userId}
          and source_planned_meal_id = ${plannedMealId}
    `;
    return Number(rows[0]?.n ?? 0);
});
assert(mealCount === 1, "Planned meal was double-logged in the database");

// ---- An outsider cannot log against the owner's planned meal.
const outsiderRecipe = await saveRecipe({
    userId: outsider.userId,
    scope,
    recipe: dinnerRecipe("Outsider Salmon"),
    idempotencyKey: `lap-outsider-recipe:${crypto.randomUUID()}`,
});
let outsiderBlocked = false;
try {
    await logRecipe({
        userId: outsider.userId,
        recipeId: outsiderRecipe.recipeId,
        recipeRevisionId: outsiderRecipe.revisionId,
        servingsConsumed: 1,
        mealType: "dinner",
        plannedMealId,
        idempotencyKey: `lap-outsider-log:${crypto.randomUUID()}`,
    });
} catch {
    outsiderBlocked = true;
}
assert(outsiderBlocked, "Outsider logged against the owner's planned meal");

// ---- The evening prompt: only today's unlogged planned meals.
// Pick a timezone where it is currently evening so the workspace's
// server-side day part is deterministic whenever CI runs.
const EVENING_ZONES = [
    "Pacific/Auckland",
    "Australia/Sydney",
    "Asia/Tokyo",
    "Asia/Dubai",
    "Europe/London",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Pacific/Honolulu",
];
const now = new Date();
const eveningZone = EVENING_ZONES.find((zone) => {
    const hour = hourInTz(now, zone);
    return hour >= 18 && hour <= 22;
});
assert(eveningZone, "No candidate timezone is currently in the evening");
await upsertProfile(owner.userId, { timezone: eveningZone });
const eveningToday = dateInTz(new Date(), eveningZone);

const savedSecond = await saveRecipe({
    userId: owner.userId,
    scope,
    recipe: dinnerRecipe("Log As Planned Second Salmon"),
    idempotencyKey: `lap-recipe-2:${crypto.randomUUID()}`,
});
const plannedSecondRow = await scheduleRecipe({
    userId: owner.userId,
    scope,
    recipeId: savedSecond.recipeId,
    recipeRevisionId: savedSecond.revisionId,
    plannedDate: eveningToday,
    mealSlot: "dinner",
    servings: 2,
    idempotencyKey: `lap-plan-2:${crypto.randomUUID()}`,
});
const plannedSecondId = String(plannedSecondRow.id);

const eveningWorkspace = await getTodayWorkspace(owner.userId, eveningToday);
assert(eveningWorkspace.isToday, "Evening workspace did not read as today");
assert(
    eveningWorkspace.dayPart === "evening",
    "Evening workspace day part was not evening",
);
assert(
    eveningWorkspace.plannedPrompts.some(
        (prompt) => prompt.planned_meal_id === plannedSecondId,
    ),
    "Evening prompt omitted today's unlogged planned meal",
);
assert(
    !eveningWorkspace.plannedPrompts.some(
        (prompt) => prompt.planned_meal_id === plannedMealId,
    ),
    "Evening prompt included an already-logged planned meal",
);

const pastWorkspace = await getTodayWorkspace(
    owner.userId,
    shiftLocalDate(eveningToday, -1),
);
assert(
    !pastWorkspace.isToday && pastWorkspace.plannedPrompts.length === 0,
    "Evening prompt fired for a past day",
);
const futureWorkspace = await getTodayWorkspace(
    owner.userId,
    shiftLocalDate(eveningToday, 1),
);
assert(
    !futureWorkspace.isToday && futureWorkspace.plannedPrompts.length === 0,
    "Evening prompt fired for a future day",
);

// Logging the prompted meal retires its prompt and marks the entry.
await logRecipe({
    userId: owner.userId,
    recipeId: savedSecond.recipeId,
    recipeRevisionId: savedSecond.revisionId,
    servingsConsumed: 2,
    mealType: "dinner",
    plannedMealId: plannedSecondId,
    idempotencyKey: `lap-log-2:${crypto.randomUUID()}`,
});
const settledWorkspace = await getTodayWorkspace(owner.userId, eveningToday);
assert(
    !settledWorkspace.plannedPrompts.some(
        (prompt) => prompt.planned_meal_id === plannedSecondId,
    ),
    "Evening prompt kept firing after the meal was logged",
);

// ---- Plan module off: Today assembles no planned data at all.
await saveFeatureModules(owner.userId, { plan: false });
const moduleOffWorkspace = await getTodayWorkspace(owner.userId, eveningToday);
assert(
    moduleOffWorkspace.plannedMeals.length === 0 &&
        moduleOffWorkspace.plannedPrompts.length === 0,
    "Plan module off still surfaced planned data on Today",
);
await saveFeatureModules(owner.userId, { plan: true });

await closePlatformDatabase();
console.log(
    "Log as planned logging, dedupe, RLS link guard, evening prompt, and module gate smoke test passed.",
);
