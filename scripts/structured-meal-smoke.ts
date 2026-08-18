#!/usr/bin/env bun

import { createSmokeUser } from "./support/smoke-user.js";

const {
    addStructuredMealItem,
    copyMeal,
    deleteStructuredMealItem,
    updateStructuredMealItem,
} = await import("../src/app/meal-mutations.js");
const { getStructuredMeal, insertStructuredMeal } =
    await import("../src/structured-meals/repository.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for structured meal smoke tests");
}

const userA = await createSmokeUser("structured-a");
const userB = await createSmokeUser("structured-b");
const idempotencyKey = `structured-smoke:${crypto.randomUUID()}`;

const first = await insertStructuredMeal(userA, {
    description: "Chicken and rice bowl",
    mealType: "lunch",
    loggedAt: "2026-08-03T17:00:00.000Z",
    notes: "Verified provider snapshot smoke test",
    idempotencyKey,
    items: [
        {
            name: "Roasted chicken breast",
            quantity: 1,
            portionLabel: "1 breast",
            gramWeight: 172,
            nutrients: {
                calories: 283.8,
                protein_g: 53.32,
                fat_g: 6.19,
                sodium_mg: 127,
            },
            sourceType: "usda",
            provider: "usda",
            providerFoodId: "555",
            providerRevision: "2026-08-03",
            sourceUrl:
                "https://fdc.nal.usda.gov/fdc-app.html#/food-details/555/nutrients",
            confidence: 0.97,
            sourceSnapshot: {
                provider: "usda",
                providerFoodId: "555",
                portion: "1 breast",
            },
        },
        {
            name: "Cooked white rice",
            quantity: 1,
            portionLabel: "1 cup",
            gramWeight: 158,
            nutrients: {
                calories: 205.4,
                protein_g: 4.25,
                carbs_g: 44.5,
                fat_g: 0.44,
            },
            sourceType: "model_estimate",
            confidence: 0.75,
            assumptions: ["Portion treated as one level cup"],
            sourceSnapshot: { basis: "confirmed household portion" },
        },
    ],
});

if (first.deduplicated)
    throw new Error("Initial structured meal was deduplicated");
if (first.meal.items.length !== 2)
    throw new Error("Structured items were not inserted");
if (first.meal.calories !== 489)
    throw new Error("Parent calories were not rounded from item totals");
if (first.meal.proteinG !== 57.57)
    throw new Error("Parent protein total is incorrect");
if (first.meal.carbsG !== 44.5)
    throw new Error("Parent carbohydrate total is incorrect");
if (first.meal.items[0]?.sourceSnapshot.provider !== "usda") {
    throw new Error("Provider source snapshot was not preserved");
}
if (
    first.meal.items[1]?.assumptions[0] !== "Portion treated as one level cup"
) {
    throw new Error("Accepted assumptions were not preserved");
}

const retry = await insertStructuredMeal(userA, {
    description: "Ignored retry content",
    mealType: "dinner",
    idempotencyKey,
    items: [
        {
            name: "Ignored",
            nutrients: { calories: 1 },
            sourceType: "model_estimate",
        },
    ],
});
if (!retry.deduplicated || retry.meal.id !== first.meal.id) {
    throw new Error("Structured meal retry did not return the original meal");
}
if (retry.meal.items.length !== 2) {
    throw new Error("Idempotent retry changed structured items");
}

if (await getStructuredMeal(userB, first.meal.id)) {
    throw new Error("Cross-tenant structured meal read was allowed");
}
if (!(await getStructuredMeal(userA, first.meal.id))) {
    throw new Error("Structured meal owner could not reload the meal");
}

const chickenId = first.meal.items[0]!.id;
const riceId = first.meal.items[1]!.id;
const doubled = await updateStructuredMealItem(
    userA,
    first.meal.id,
    chickenId,
    { quantity: 2 },
);
if (doubled.items[0]?.quantity !== 2) {
    throw new Error("Structured item quantity was not updated");
}
if (Math.abs((doubled.items[0]?.nutrients.calories ?? 0) - 567.6) > 0.001) {
    throw new Error("Quantity edit did not scale item nutrition");
}
if (doubled.calories !== 773) {
    throw new Error("Parent calories were not recomputed after item edit");
}
if (Math.abs((doubled.proteinG ?? 0) - 110.89) > 0.001) {
    throw new Error("Parent protein was not recomputed after item edit");
}

let crossTenantMutationBlocked = false;
try {
    await updateStructuredMealItem(userB, first.meal.id, chickenId, {
        quantity: 3,
    });
} catch {
    crossTenantMutationBlocked = true;
}
if (!crossTenantMutationBlocked) {
    throw new Error("Cross-tenant structured item mutation was allowed");
}

const added = await addStructuredMealItem(userA, first.meal.id, {
    name: "Added salad",
    quantity: 1,
    portionLabel: "1 bowl",
    nutrients: { calories: 80, protein_g: 3, carbs_g: 12, fat_g: 2 },
    sourceType: "user_supplied",
    provider: "user_correction",
    confidence: 1,
    assumptions: ["Added in website editor"],
    sourceSnapshot: { resolution_layer: "website_manual_add" },
});
if (added.items.length !== 3 || added.calories !== 853) {
    throw new Error(
        "Structured item addition did not recalculate parent totals",
    );
}
const addedItem = added.items.find((item) => item.name === "Added salad");
if (!addedItem || addedItem.provider !== "user_correction") {
    throw new Error("Added structured item provenance was not retained");
}
const afterAddedDelete = await deleteStructuredMealItem(
    userA,
    first.meal.id,
    addedItem.id,
);
if (afterAddedDelete.items.length !== 2 || afterAddedDelete.calories !== 773) {
    throw new Error("Added structured item cleanup did not restore totals");
}

const copied = await copyMeal(userA, first.meal.id, {
    loggedAt: "2026-08-04T17:00:00.000Z",
});
if (!copied.structured || copied.mealId === first.meal.id) {
    throw new Error("Structured meal copy did not create a new meal");
}
const copiedMeal = await getStructuredMeal(userA, copied.mealId);
if (!copiedMeal || copiedMeal.items.length !== 2) {
    throw new Error("Structured meal copy lost child items");
}
if (copiedMeal.items[0]?.sourceSnapshot.provider !== "usda") {
    throw new Error("Structured meal copy lost provider provenance");
}
if (copiedMeal.items[0]?.providerFoodId !== "555") {
    throw new Error("Structured meal copy lost provider food identity");
}

const corrected = await updateStructuredMealItem(
    userA,
    copied.mealId,
    copiedMeal.items[0]!.id,
    {
        name: "Corrected chicken breast",
        nutrients: { calories: 550 },
    },
);
const correctedItem = corrected.items[0];
if (
    correctedItem?.sourceType !== "user_supplied" ||
    correctedItem.provider !== "user_correction" ||
    correctedItem.sourceSnapshot.user_correction == null
) {
    throw new Error(
        "Manual correction did not retain an auditable provenance trail",
    );
}
if (corrected.calories !== 755) {
    throw new Error(
        "Manual nutrient correction did not recalculate parent totals",
    );
}

const afterDelete = await deleteStructuredMealItem(
    userA,
    first.meal.id,
    riceId,
);
if (afterDelete.items.length !== 1 || afterDelete.items[0]?.id !== chickenId) {
    throw new Error("Structured item deletion produced the wrong children");
}
if (afterDelete.calories !== 568) {
    throw new Error("Parent totals were not recomputed after item deletion");
}

let lastItemProtected = false;
try {
    await deleteStructuredMealItem(userA, first.meal.id, chickenId);
} catch {
    lastItemProtected = true;
}
if (!lastItemProtected) {
    throw new Error("Structured meal allowed deletion of its final item");
}

await closePlatformDatabase();
console.log(
    "Munch structured meal items, provenance, corrections, additions, copying, totals, and RLS smoke test passed.",
);
