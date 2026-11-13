#!/usr/bin/env bun

// Recipe unit logging (owner-approved 2026-11-13) against a real
// database — the brief §4 acceptance checks, end to end:
//  1. Yield 12 cups, 12 servings: logging 1 cup, 8 fl oz, 16 tbsp,
//     and 236.5882365 ml each produce the same meal (share 1/12),
//     and 1 serving is that same meal again.
//  2. A recipe with NO yield logs 1/4 by fraction = totals × 0.25.
//  3. Editing the yield after logging leaves the logged meal's
//     label, share, and macros byte-identical (snapshot immutability),
//     and the yield edit creates no new revision.
//  4. Passing both a portion and servings_consumed is rejected.
//  5. A yield-only correction through setRecipeYield keeps the same
//     revision id/number and recipe version.
//  6. Cross-family: a recipe whose only yield is by volume (and whose
//     ingredients carry no bulk, so there is no estimate either)
//     refuses a gram amount, then accepts it once a weight yield is
//     set; an amount against an estimated yield snapshots the
//     estimate's provenance.
//  7. Log-as-planned with a portion carries the portion record and
//     still dedupes; a cook portion log (logCookPortion) carries it
//     too.

import { createSmokeIdentity } from "./support/smoke-user.js";

const {
    saveRecipe,
    getRecipe,
    logRecipe,
    setRecipeYield,
    scheduleRecipe,
    updateRecipe,
    recipeInputFromStored,
} = await import("../src/planning/repository.js");
const { getStructuredMeal } =
    await import("../src/structured-meals/repository.js");
const { createCook, saveCookAsRecipe, logCookPortion } =
    await import("../src/cooks/repository.js");
const { withUserDatabase, closePlatformDatabase } =
    await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for recipe unit logging smoke");
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, message: string) {
    // Meal-level calories are stored rounded to whole kcal by the
    // structured-meal insert (existing behavior); item-level values
    // are compared exactly through the meal signatures.
    if (Math.abs(actual - expected) > 0.51) {
        throw new Error(`${message}: expected ~${expected}, got ${actual}`);
    }
}

const owner = await createSmokeIdentity("unit-logging-owner");
const scope = { type: "personal" as const };
const key = (label: string) => `unit-logging-${label}-${crypto.randomUUID()}`;

// A mac-and-cheese-shaped recipe: 12 servings, set volume yield of
// 12 cups, per-ingredient gram weights pinned so the meal math is
// exact. Whole-recipe calories: 1619.32 + 446.52 + 409.36 = 2475.20.
function macRecipe(name: string) {
    return {
        name,
        servings: 12,
        yieldVolume: { quantity: 12, unit: "cup" },
        instructions: ["Boil the pasta.", "Make the sauce.", "Smoke it."],
        sourceType: "user_entered" as const,
        ingredients: [
            {
                name: "Elbow macaroni",
                quantity: 1,
                unit: "lb",
                gramWeight: 453.59,
                nutrients: {
                    calories: 1619.32,
                    protein_g: 56.7,
                    carbs_g: 320.5,
                    fat_g: 7.4,
                },
                sourceType: "user_supplied" as const,
                sourceSnapshot: { entered_by_user: true },
            },
            {
                name: "Whole milk",
                quantity: 3,
                unit: "cup",
                gramWeight: 732,
                nutrients: {
                    calories: 446.52,
                    protein_g: 23.6,
                    carbs_g: 35.2,
                    fat_g: 23.9,
                },
                sourceType: "user_supplied" as const,
                sourceSnapshot: { entered_by_user: true },
            },
            {
                name: "Butter",
                quantity: 4,
                unit: "tbsp",
                gramWeight: 56,
                nutrients: {
                    calories: 409.36,
                    protein_g: 0.5,
                    carbs_g: 0,
                    fat_g: 46.3,
                },
                sourceType: "user_supplied" as const,
                sourceSnapshot: { entered_by_user: true },
            },
        ],
    };
}

async function mealItems(mealId: string) {
    const meal = await getStructuredMeal(owner.userId, mealId);
    assert(meal, "logged meal reloads");
    return meal;
}

function mealSignature(meal: Awaited<ReturnType<typeof mealItems>>) {
    // The description is deliberately NOT part of the signature: it
    // keeps the entered amount ("8 fl oz" vs "1 cup") by design.
    // Quantities, gram weights, and calories are the meal's substance
    // and must be identical across spellings of the same share.
    return JSON.stringify({
        calories: meal.calories,
        items: meal.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            gramWeight: item.gramWeight,
            calories: item.nutrients.calories ?? null,
        })),
    });
}

// ---- Save + stored yields round-trip.
const saved = await saveRecipe({
    userId: owner.userId,
    scope,
    recipe: macRecipe("Unit Logging Mac"),
    idempotencyKey: key("save"),
});
const recipe = await getRecipe(owner.userId, saved.recipeId);
assert(recipe, "recipe reloads");
assert(
    recipe.yields.volume?.quantity === 12 &&
        recipe.yields.volume?.unit === "cup",
    "set volume yield round-trips",
);
assert(recipe.yields.weight === null, "weight slot starts empty");
assert(
    recipe.effective_yields.volume?.source === "set",
    "effective volume yield is the set one",
);
assert(
    recipe.effective_yields.weight?.source === "estimated",
    "weight falls back to the labeled estimate",
);

// ---- Acceptance 1: every spelling of 1/12 is the same meal.
const spellings: Array<{
    label: string;
    run: (idempotencyKey: string) => Promise<{ meal: { id: string } }>;
}> = [
    {
        label: "1 cup",
        run: (idempotencyKey) =>
            logRecipe({
                userId: owner.userId,
                recipeId: saved.recipeId,
                portion: { mode: "amount", amount: 1, unit: "cup" },
                mealType: "lunch",
                idempotencyKey,
            }),
    },
    {
        label: "8 fl oz",
        run: (idempotencyKey) =>
            logRecipe({
                userId: owner.userId,
                recipeId: saved.recipeId,
                portion: { mode: "amount", amount: 8, unit: "fl oz" },
                mealType: "lunch",
                idempotencyKey,
            }),
    },
    {
        label: "16 tbsp",
        run: (idempotencyKey) =>
            logRecipe({
                userId: owner.userId,
                recipeId: saved.recipeId,
                portion: { mode: "amount", amount: 16, unit: "tbsp" },
                mealType: "lunch",
                idempotencyKey,
            }),
    },
    {
        label: "236.5882365 ml",
        run: (idempotencyKey) =>
            logRecipe({
                userId: owner.userId,
                recipeId: saved.recipeId,
                portion: { mode: "amount", amount: 236.5882365, unit: "ml" },
                mealType: "lunch",
                idempotencyKey,
            }),
    },
    {
        label: "1 serving",
        run: (idempotencyKey) =>
            logRecipe({
                userId: owner.userId,
                recipeId: saved.recipeId,
                servingsConsumed: 1,
                mealType: "lunch",
                idempotencyKey,
            }),
    },
];

let referenceSignature = "";
let referenceLog: Awaited<ReturnType<typeof logRecipe>> | null = null;
const expectedDescriptions: Record<string, string> = {
    "1 cup": "Unit Logging Mac (1 cup)",
    "8 fl oz": "Unit Logging Mac (8 fl oz)",
    "16 tbsp": "Unit Logging Mac (16 tbsp)",
    "236.5882365 ml": "Unit Logging Mac (236.588 ml)",
    "1 serving": "Unit Logging Mac (1 serving)",
};
for (const spelling of spellings) {
    const result = await spelling.run(key(spelling.label));
    const meal = await mealItems(result.meal.id);
    assert(
        meal.description === expectedDescriptions[spelling.label],
        `${spelling.label} description keeps the entered amount`,
    );
    const signature = mealSignature(meal);
    if (!referenceSignature) {
        referenceSignature = signature;
        referenceLog = result;
    } else {
        assert(
            signature === referenceSignature,
            `${spelling.label} produces the same meal as 1 cup`,
        );
    }
    assertClose(
        meal.calories ?? 0,
        2475.2 / 12,
        `${spelling.label} calories are totals / 12`,
    );
}
assert(referenceLog, "reference log exists");
assert(
    referenceLog.portion.mode === "amount" &&
        referenceLog.portion.entered_unit === "cup" &&
        referenceLog.share === 0.083333 &&
        referenceLog.portion.yield_snapshot?.source === "set",
    "the amount log carries its portion record with the set-yield snapshot",
);
const referenceMeal = await mealItems(referenceLog.meal.id);
assert(
    referenceMeal.description === "Unit Logging Mac (1 cup)",
    "the description keeps the entered amount",
);
const snapshotPortion = referenceMeal.items[0]?.sourceSnapshot
    ?.recipe_portion as { share?: number } | undefined;
assert(
    snapshotPortion?.share === 0.083333,
    "every item snapshot carries the portion record",
);

// ---- Acceptance 4 (repo level): both portion forms are rejected.
let bothRejected = false;
try {
    await logRecipe({
        userId: owner.userId,
        recipeId: saved.recipeId,
        servingsConsumed: 1,
        portion: { mode: "amount", amount: 1, unit: "cup" },
        mealType: "lunch",
        idempotencyKey: key("both"),
    });
} catch (error) {
    bothRejected = /not both/.test(String(error));
}
assert(bothRejected, "servings + portion together are rejected");

// ---- Acceptance 3 + 5: yield edit after logging rewrites nothing.
const beforeYieldEdit = mealSignature(referenceMeal);
const versionBefore = recipe.version;
const yieldResult = await setRecipeYield({
    userId: owner.userId,
    scope,
    recipeId: saved.recipeId,
    family: "volume",
    yield: { quantity: 10, unit: "cup" },
});
assert(
    yieldResult.revisionId === recipe.revision_id &&
        yieldResult.revisionNumber === recipe.revision_number,
    "yield edit stays on the same revision (no new revision)",
);
const afterYieldRecipe = await getRecipe(owner.userId, saved.recipeId);
assert(afterYieldRecipe, "recipe reloads after yield edit");
assert(
    afterYieldRecipe.version === versionBefore,
    "yield edit does not bump the recipe version",
);
assert(
    afterYieldRecipe.yields.volume?.quantity === 10,
    "the corrected yield is now the set yield",
);
const mealAfterYieldEdit = await mealItems(referenceLog.meal.id);
assert(
    mealSignature(mealAfterYieldEdit) === beforeYieldEdit,
    "the logged meal is byte-identical after the yield edit",
);
// New logs figure from the corrected yield: 1 cup is now 1/10.
const corrected = await logRecipe({
    userId: owner.userId,
    recipeId: saved.recipeId,
    portion: { mode: "amount", amount: 1, unit: "cup" },
    mealType: "lunch",
    idempotencyKey: key("corrected"),
});
assert(corrected.share === 0.1, "new logs use the corrected yield");
assert(
    corrected.portion.yield_snapshot?.quantity === 10,
    "the new log snapshots the corrected yield",
);

// ---- Acceptance 2: fraction with no yield at all.
const plainSaved = await saveRecipe({
    userId: owner.userId,
    scope,
    recipe: {
        name: "Unit Logging Plain Pot",
        servings: 8,
        instructions: ["Simmer."],
        sourceType: "user_entered" as const,
        ingredients: [
            {
                name: "Broth",
                quantity: 8,
                unit: "cup",
                gramWeight: 1920,
                nutrients: {
                    calories: 800,
                    protein_g: 16,
                    carbs_g: 24,
                    fat_g: 8,
                },
                sourceType: "user_supplied" as const,
                sourceSnapshot: { entered_by_user: true },
            },
        ],
    },
    idempotencyKey: key("plain-save"),
});
const quarter = await logRecipe({
    userId: owner.userId,
    recipeId: plainSaved.recipeId,
    portion: { mode: "fraction", value: 0.25, numerator: 1, denominator: 4 },
    mealType: "dinner",
    idempotencyKey: key("quarter"),
});
const quarterMeal = await mealItems(quarter.meal.id);
assertClose(quarterMeal.calories ?? 0, 200, "1/4 of 800 kcal is 200");
assert(
    quarterMeal.description === "Unit Logging Plain Pot (1/4 of the recipe)",
    "fraction description keeps the entered share",
);
assert(
    quarter.portion.fraction_numerator === 1 &&
        quarter.portion.fraction_denominator === 4 &&
        quarter.portion.yield_snapshot === null,
    "fraction record keeps the exact n/d and no yield snapshot",
);

// ---- Acceptance 6: cross-family refusal, then the estimate path.
const drySaved = await saveRecipe({
    userId: owner.userId,
    scope,
    recipe: {
        name: "Unit Logging Dry Mix",
        servings: 4,
        yieldVolume: { quantity: 6, unit: "cup" },
        instructions: ["Stir."],
        sourceType: "user_entered" as const,
        ingredients: [
            {
                // No quantity, no gram weight: the estimator has
                // nothing to sum, so the weight family has NO yield
                // (set or estimated) until one is set.
                name: "House spice blend",
                nutrients: { calories: 40, protein_g: 1, carbs_g: 6, fat_g: 1 },
                sourceType: "user_supplied" as const,
                sourceSnapshot: { entered_by_user: true },
            },
        ],
    },
    idempotencyKey: key("dry-save"),
});
const dryRecipe = await getRecipe(owner.userId, drySaved.recipeId);
assert(dryRecipe, "dry recipe reloads");
assert(
    dryRecipe.effective_yields.weight === null,
    "no weight yield and no estimate for the dry mix",
);
let refused = false;
try {
    await logRecipe({
        userId: owner.userId,
        recipeId: drySaved.recipeId,
        portion: { mode: "amount", amount: 200, unit: "g" },
        mealType: "snack",
        idempotencyKey: key("dry-grams"),
    });
} catch (error) {
    refused = /no weight yield/.test(String(error));
}
assert(refused, "a gram amount is refused without a weight yield");
await setRecipeYield({
    userId: owner.userId,
    scope,
    recipeId: drySaved.recipeId,
    family: "weight",
    yield: { quantity: 400, unit: "g" },
});
const grams = await logRecipe({
    userId: owner.userId,
    recipeId: drySaved.recipeId,
    portion: { mode: "amount", amount: 200, unit: "g" },
    mealType: "snack",
    idempotencyKey: key("dry-grams-2"),
});
assert(grams.share === 0.5, "200 g of a 400 g yield is half the recipe");

// Estimated-yield provenance: the mac recipe's weight slot is an
// estimate; logging by grams snapshots source "estimated".
const byGrams = await logRecipe({
    userId: owner.userId,
    recipeId: saved.recipeId,
    portion: { mode: "amount", amount: 100, unit: "g" },
    mealType: "snack",
    idempotencyKey: key("estimated-grams"),
});
assert(
    byGrams.portion.yield_snapshot?.source === "estimated" &&
        byGrams.portion.yield_snapshot?.family === "weight",
    "an estimate-based log snapshots the estimate provenance",
);

// ---- Log-as-planned carries the portion record and still dedupes.
const today = new Date().toISOString().slice(0, 10);
const planned = await scheduleRecipe({
    userId: owner.userId,
    scope,
    recipeId: saved.recipeId,
    recipeRevisionId: saved.revisionId,
    plannedDate: today,
    mealSlot: "dinner",
    servings: 12,
    idempotencyKey: key("plan"),
});
const plannedLog = await logRecipe({
    userId: owner.userId,
    recipeId: saved.recipeId,
    recipeRevisionId: saved.revisionId,
    portion: { mode: "fraction", value: 0.5, numerator: 1, denominator: 2 },
    mealType: "dinner",
    plannedMealId: String(planned.id),
    idempotencyKey: key("planned-log"),
});
assert(
    plannedLog.portion.mode === "fraction" && plannedLog.share === 0.5,
    "log-as-planned carries the fraction portion",
);
const plannedMealRow = await mealItems(plannedLog.meal.id);
assert(
    plannedMealRow.description === "Unit Logging Mac (1/2 of the recipe)",
    "planned log description keeps the entered fraction",
);
const plannedAgain = await logRecipe({
    userId: owner.userId,
    recipeId: saved.recipeId,
    recipeRevisionId: saved.revisionId,
    portion: { mode: "fraction", value: 0.25, numerator: 1, denominator: 4 },
    mealType: "dinner",
    plannedMealId: String(planned.id),
    idempotencyKey: key("planned-log-again"),
});
assert(
    plannedAgain.deduplicated && plannedAgain.meal.id === plannedLog.meal.id,
    "a second planned log returns the existing meal (dedupe unchanged)",
);

// ---- Cook portion log carries the portion record too.
const cookStart = await createCook(owner.userId, {
    title: "Unit Logging Cook",
    cookDate: today,
    timezone: "UTC",
    originalMessage: "Smoking the mac.",
    message: "Smoking the mac.",
    events: [],
    dishes: [
        {
            name: "Mac dish",
            ingredientOrCut: "macaroni",
            method: "smoked",
            flavor: "gouda",
            equipment: "smoker",
            actualIngredients: [
                { name: "Elbow macaroni", quantity: 1, unit: "lb" },
            ],
        },
    ],
    photos: [],
    source: "website",
    idempotencyKey: key("cook-create"),
});
await saveCookAsRecipe({
    userId: owner.userId,
    cookId: cookStart.cookId,
    scope,
    recipe: {
        name: "Unit Logging Cook Mac",
        servings: 10,
        yieldVolume: { quantity: 10, unit: "cup" },
        instructions: ["Smoke it."],
        sourceType: "user_entered" as const,
        ingredients: [
            {
                name: "Elbow macaroni",
                quantity: 1,
                unit: "lb",
                gramWeight: 453.59,
                nutrients: {
                    calories: 1600,
                    protein_g: 56,
                    carbs_g: 320,
                    fat_g: 7,
                },
                sourceType: "user_supplied" as const,
                sourceSnapshot: { entered_by_user: true },
            },
        ],
    },
    idempotencyKey: key("cook-save"),
});
const cookLog = await logCookPortion({
    userId: owner.userId,
    cookId: cookStart.cookId,
    portion: { mode: "amount", amount: 2, unit: "cup" },
    mealType: "dinner",
    idempotencyKey: key("cook-log"),
});
assert(
    cookLog.result.portion.mode === "amount" &&
        cookLog.result.portion.entered_amount === 2 &&
        cookLog.result.share === 0.2,
    "cook portion log resolves through the same share computation (2 cups of a 10-cup yield)",
);

// ---- Yield carry-forward: an edit that omits the yield slots
// keeps them (the edit-in-place form has no yield fields); an
// explicit null clears the slot.
const carriedBefore = await getRecipe(owner.userId, saved.recipeId);
assert(carriedBefore, "yield recipe reads back before the carry test");
const omitInput = recipeInputFromStored(carriedBefore);
delete omitInput.yieldVolume;
delete omitInput.yieldWeight;
const carriedEdit = await updateRecipe({
    userId: owner.userId,
    scope,
    recipeId: saved.recipeId,
    recipe: omitInput,
    expectedVersion: carriedBefore.version,
    idempotencyKey: key("edit-carry"),
});
const carriedAfter = await getRecipe(owner.userId, saved.recipeId);
assert(carriedAfter, "yield recipe reads back after the carry edit");
assert(
    // 10 cups: the snapshot section above corrected the yield
    // from 12 to 10 before this edit ran.
    carriedAfter.yields.volume?.quantity === 10 &&
        carriedAfter.yields.volume?.unit === "cup" &&
        carriedAfter.revision_number === 2,
    "an edit omitting the yield slots carries them forward to the new revision",
);
const clearInput = recipeInputFromStored(carriedAfter);
clearInput.yieldVolume = null;
await updateRecipe({
    userId: owner.userId,
    scope,
    recipeId: saved.recipeId,
    recipe: clearInput,
    expectedVersion: carriedEdit.version,
    idempotencyKey: key("edit-clear"),
});
const clearedAfter = await getRecipe(owner.userId, saved.recipeId);
assert(clearedAfter, "yield recipe reads back after the clear edit");
assert(
    clearedAfter.yields.volume === null,
    "an explicit null yield clears the slot on edit",
);

// ---- Yield permission: another user cannot set a yield.
const outsider = await createSmokeIdentity("unit-logging-outsider");
let outsiderRefused = false;
try {
    await setRecipeYield({
        userId: outsider.userId,
        scope,
        recipeId: saved.recipeId,
        family: "volume",
        yield: { quantity: 1, unit: "cup" },
    });
} catch {
    outsiderRefused = true;
}
assert(outsiderRefused, "a non-owner cannot set the recipe's yield");

await withUserDatabase(owner.userId, async () => {});
await closePlatformDatabase();
console.log("recipe-unit-logging smoke passed");
