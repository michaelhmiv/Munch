#!/usr/bin/env bun

import { createSmokeIdentity } from "./support/smoke-user.js";
import {
    commitGoalChange,
    commitGuidedPlanDraft,
    commitMealSwap,
    confirmGuidedPlanGroceries,
    createGuidedPlanDraft,
    getDailyGuidance,
    getGuidedPlanDraft,
    getWeeklyGuidance,
    listGoalHistory,
    previewGoalChange,
    previewGuidedPlanGroceries,
    previewMealSwaps,
    undoMealSwap,
    updateGuidancePreferences,
    updateGuidedPlanDraft,
} from "../src/guidance-repository.js";
import {
    getGroceryList,
    getMealPlan,
    saveRecipe,
} from "../src/planning/repository.js";
import { closePlatformDatabase } from "../src/platform/database.js";

if (!process.env.DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is required for guided nutrition smoke tests",
    );
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

async function expectFailure(work: () => Promise<unknown>, message: string) {
    let failed = false;
    try {
        await work();
    } catch {
        failed = true;
    }
    assert(failed, message);
}

const user = await createSmokeIdentity("guided-nutrition");
const outsider = await createSmokeIdentity("guided-nutrition-outsider");
const preferences = {
    objective: "maintain" as const,
    suggestions_enabled: false,
    allergies: ["peanut"],
    excluded_ingredients: [],
    disliked_ingredients: [],
    liked_ingredients: [],
    cuisines: [],
    flavors: [],
    equipment: [],
    preferred_methods: [],
    avoided_methods: [],
    difficulty: "any" as const,
    max_prep_minutes: null,
    max_total_minutes: null,
    servings: 2,
    allow_repeats: false,
    repeat_window_days: 21,
};

const savedPreferences = await updateGuidancePreferences(
    user.userId,
    preferences,
    0,
);
assert(
    savedPreferences.version === 1,
    "Guidance preference version was not saved",
);
await expectFailure(
    () => updateGuidancePreferences(user.userId, preferences, 0),
    "A stale preference version was accepted",
);

const targetProposal = await previewGoalChange({
    userId: user.userId,
    targets: {
        daily_calories: 2100.6,
        daily_protein_g: 105.257,
        daily_carbs_g: null,
        daily_fat_g: null,
        daily_fiber_g: null,
        daily_sugar_g: null,
        daily_alcohol_g: null,
        daily_water_ml: 2500.6,
        target_weight_g: null,
    },
    idempotencyKey: `goal-preview:${crypto.randomUUID()}`,
});
assert(
    (targetProposal.proposed_targets as Record<string, unknown>)
        .daily_calories === 2101,
    "Goal preview did not normalize whole-number targets before confirmation",
);
await expectFailure(
    () =>
        commitGoalChange({
            userId: user.userId,
            proposalId: String(targetProposal.id),
            expectedRevision: Number(targetProposal.expected_revision),
            confirm: false,
            idempotencyKey: `goal-commit:${crypto.randomUUID()}`,
            origin: "website",
        }),
    "Goal change was committed without confirmation",
);
await commitGoalChange({
    userId: user.userId,
    proposalId: String(targetProposal.id),
    expectedRevision: Number(targetProposal.expected_revision),
    confirm: true,
    idempotencyKey: `goal-commit:${crypto.randomUUID()}`,
    origin: "website",
});
const goalHistory = await listGoalHistory(user.userId);
assert(
    goalHistory.length === 3,
    "Goal history did not retain confirmed revisions",
);

const scope = { type: "personal" as const };
const salmon = await saveRecipe({
    userId: user.userId,
    scope,
    recipe: {
        name: "Salmon Rice Bowl",
        servings: 4,
        instructions: ["Cook the salmon and serve with rice."],
        sourceType: "user_entered",
        ingredients: [
            {
                name: "salmon",
                quantity: 2,
                unit: "fillets",
                nutrients: {
                    calories: 600,
                    protein_g: 100,
                    carbs_g: 0,
                    fat_g: 25,
                },
                sourceType: "user_supplied",
            },
            {
                name: "rice",
                quantity: 2,
                unit: "cups",
                nutrients: {
                    calories: 200,
                    protein_g: 4,
                    carbs_g: 45,
                    fat_g: 1,
                },
                sourceType: "user_supplied",
            },
        ],
    },
    idempotencyKey: `guided-salmon:${crypto.randomUUID()}`,
});
const chili = await saveRecipe({
    userId: user.userId,
    scope,
    recipe: {
        name: "Beef Bean Chili",
        servings: 2,
        instructions: ["Simmer the beef and beans."],
        sourceType: "user_entered",
        ingredients: [
            {
                name: "ground beef",
                quantity: 300,
                unit: "g",
                nutrients: {
                    calories: 400,
                    protein_g: 32,
                    carbs_g: 0,
                    fat_g: 20,
                },
                sourceType: "user_supplied",
            },
            {
                name: "black beans",
                quantity: 1,
                unit: "cup",
                nutrients: {
                    calories: 200,
                    protein_g: 8,
                    carbs_g: 32,
                    fat_g: 0,
                },
                sourceType: "user_supplied",
            },
        ],
    },
    idempotencyKey: `guided-chili:${crypto.randomUUID()}`,
});

const planDate = "2026-10-09";
const draftResult = await createGuidedPlanDraft(
    {
        start_date: planDate,
        end_date: planDate,
        timezone: "UTC",
        scope: "personal",
        mode: "mixed",
        replace_existing: false,
        idempotency_key: `guided-draft:${crypto.randomUUID()}`,
        items: [
            {
                date: planDate,
                meal_slot: "dinner",
                servings: 2,
                generated_recipe: {
                    name: "Peanut Noodles",
                    ingredients: [
                        {
                            name: "peanut butter",
                            quantity: null,
                            unit: null,
                        },
                    ],
                    instructions: ["Mix the ingredients."],
                    servings: 2,
                    preparation_minutes: 5,
                    cooking_minutes: 10,
                    difficulty: "easy",
                    required_equipment: [],
                    cuisine_tags: [],
                    primary_protein: null,
                    cooking_methods: [],
                },
            },
        ],
    },
    user.userId,
);
assert(
    draftResult.draft.items[0]?.blockers.some((item) =>
        String(item).includes("Possible allergy match"),
    ),
    "A proposed allergen was not blocked in the plan draft",
);
await expectFailure(
    () =>
        commitGuidedPlanDraft({
            userId: user.userId,
            draftId: draftResult.draft.id,
            expectedVersion: draftResult.draft.version,
            confirm: true,
        }),
    "A plan with an unresolved allergen blocker was committed",
);
assert(
    (await getGuidedPlanDraft(outsider.userId, draftResult.draft.id)) === null,
    "Another user could read a personal plan draft",
);

const editedDraft = await updateGuidedPlanDraft({
    userId: user.userId,
    draftId: draftResult.draft.id,
    expectedVersion: draftResult.draft.version,
    items: [
        {
            date: planDate,
            meal_slot: "dinner",
            servings: 2,
            recipe_id: salmon.recipeId,
            recipe_revision_id: salmon.revisionId,
        },
    ],
});
assert(
    editedDraft?.items[0]?.blockers.length === 0,
    "Safe saved recipe remained blocked",
);
await commitGuidedPlanDraft({
    userId: user.userId,
    draftId: draftResult.draft.id,
    expectedVersion: editedDraft!.version,
    confirm: true,
});

const daily = await getDailyGuidance({ userId: user.userId, date: planDate });
assert(daily.meal_count === 0, "Planning was treated as logged food");
assert(
    daily.planned_meals.length === 1,
    "Daily guidance did not show the planned meal separately",
);
const weekly = await getWeeklyGuidance({
    userId: user.userId,
    startDate: planDate,
    endDate: planDate,
    timezone: "UTC",
});
assert(
    weekly.coverage_percent === 0,
    "An unlogged plan counted as nutrition coverage",
);
assert(
    weekly.averages_on_recorded_days.water_ml.average === null,
    "Missing hydration was reported as zero",
);

const groceryPreview = await previewGuidedPlanGroceries(
    user.userId,
    draftResult.draft.id,
);
assert(groceryPreview.suggestions.length > 0, "Plan grocery preview was empty");
await expectFailure(
    () =>
        confirmGuidedPlanGroceries({
            userId: user.userId,
            draftId: draftResult.draft.id,
            selectedIndices: [0],
            confirm: false,
            idempotencyKey: `grocery:${crypto.randomUUID()}`,
        }),
    "Plan groceries were added without a separate confirmation",
);
await confirmGuidedPlanGroceries({
    userId: user.userId,
    draftId: draftResult.draft.id,
    selectedIndices: groceryPreview.suggestions.map((item) => item.index),
    confirm: true,
    idempotencyKey: `grocery:${crypto.randomUUID()}`,
});
const groceryList = await getGroceryList({ userId: user.userId, scope });
assert(
    groceryList.items.length > 0,
    "Confirmed plan groceries did not persist",
);

const plan = await getMealPlan({
    userId: user.userId,
    startDate: planDate,
    endDate: planDate,
    scope: "personal",
});
const plannedMeal = plan.find((item) => item.meal_slot === "dinner");
assert(plannedMeal, "Committed plan was not scheduled in the calendar");
const swapPreview = await previewMealSwaps({
    userId: user.userId,
    plannedMealId: plannedMeal.planned_meal_id,
});
const candidate = swapPreview.candidates.find(
    (item) => item.recipe_id === chili.recipeId,
);
assert(
    candidate,
    "Saved recipe swap preview did not include the alternate recipe",
);
assert(
    candidate.day_totals_after.calories === 600,
    "Swap day totals did not scale the new per-serving calories by planned servings",
);
await expectFailure(
    () =>
        commitMealSwap({
            userId: user.userId,
            plannedMealId: plannedMeal.planned_meal_id,
            recipeId: chili.recipeId,
            recipeRevisionId: chili.revisionId,
            expectedVersion: swapPreview.expected_version,
            confirm: false,
            idempotencyKey: `swap:${crypto.randomUUID()}`,
        }),
    "A planned meal swap was applied without confirmation",
);
const swapped = await commitMealSwap({
    userId: user.userId,
    plannedMealId: plannedMeal.planned_meal_id,
    recipeId: chili.recipeId,
    recipeRevisionId: chili.revisionId,
    expectedVersion: swapPreview.expected_version,
    confirm: true,
    idempotencyKey: `swap:${crypto.randomUUID()}`,
});
assert(
    swapped.planned_meal,
    "Confirmed meal swap returned no updated calendar row",
);
await undoMealSwap({
    userId: user.userId,
    changeId: String(swapped.change.id),
    expectedVersion: Number(swapped.planned_meal.version),
    confirm: true,
    idempotencyKey: `swap-undo:${crypto.randomUUID()}`,
});
const restoredPlan = await getMealPlan({
    userId: user.userId,
    startDate: planDate,
    endDate: planDate,
    scope: "personal",
});
assert(
    restoredPlan.find(
        (item) => item.planned_meal_id === plannedMeal.planned_meal_id,
    )?.recipe_id === salmon.recipeId,
    "Swap undo did not restore the original recipe",
);

await closePlatformDatabase();
console.log(
    "Guided nutrition goals, planning, allergy blockers, groceries, swaps, and RLS smoke test passed.",
);
