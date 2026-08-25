#!/usr/bin/env bun

import { createSmokeUser } from "./support/smoke-user.js";

const {
    addMealDraftQuestion,
    answerMealDraftQuestion,
    cancelMealDraft,
    confirmMealDraft,
    createMealDraft,
    deleteMealDraftItem,
    getMealDraft,
    prepareMealDraftConfirmation,
    updateMealDraftMetadata,
    upsertMealDraftItem,
} = await import("../src/meal-drafts/repository.js");
const { getStructuredMeal } =
    await import("../src/structured-meals/repository.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for meal-draft smoke tests");
}

const userA = await createSmokeUser("draft-a");
const userB = await createSmokeUser("draft-b");
let draft = await createMealDraft({
    userId: userA,
    sourceMode: "photo",
    description: "Chicken and rice plate",
    mealType: "lunch",
    loggedAt: "2026-08-03T18:00:00.000Z",
});
if (draft.status !== "open" || draft.version !== 1) {
    throw new Error("New draft did not start in the expected state");
}

const staleVersion = draft.version;
draft = await upsertMealDraftItem({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    position: 0,
    item: {
        name: "Chicken and rice",
        portionLabel: "1 plate",
        nutrients: {
            calories: 620,
            protein_g: 42,
            carbs_g: 70,
            fat_g: 18,
        },
        sourceType: "model_estimate",
        confidence: 0.7,
        assumptions: ["Initial plate-size estimate"],
        sourceSnapshot: { source: "photo", model: "host vision" },
    },
});
if (draft.status !== "awaiting_confirmation" || draft.version !== 2) {
    throw new Error("Adding a draft item did not update state/version");
}

let staleRejected = false;
try {
    await updateMealDraftMetadata({
        userId: userA,
        draftId: draft.id,
        expectedVersion: staleVersion,
        notes: "stale write",
    });
} catch (error) {
    staleRejected = String(error).includes("expected version");
}
if (!staleRejected) throw new Error("Stale draft update was not rejected");

const itemId = draft.items[0]!.id;
draft = await addMealDraftQuestion({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    itemId,
    questionKey: "portion_eaten",
    prompt: "How much of the plate did you eat?",
    impactScore: 95,
});
draft = await addMealDraftQuestion({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    itemId,
    questionKey: "hidden_oil",
    prompt: "Was oil or butter added?",
    impactScore: 80,
});
if (
    draft.status !== "awaiting_answers" ||
    draft.questions.find((question) => question.status === "open")
        ?.questionKey !== "portion_eaten"
) {
    throw new Error("Draft questions were not ordered by impact");
}

let prematureRejected = false;
try {
    await prepareMealDraftConfirmation({
        userId: userA,
        draftId: draft.id,
        expectedVersion: draft.version,
    });
} catch (error) {
    prematureRejected = String(error).includes("unresolved question");
}
if (!prematureRejected) {
    throw new Error("Draft prepared despite unresolved questions");
}

const portionQuestion = draft.questions.find(
    (question) => question.questionKey === "portion_eaten",
)!;
const currentItem = draft.items[0]!.item;
draft = await upsertMealDraftItem({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    position: 0,
    item: {
        ...currentItem,
        assumptions: [
            ...(currentItem.assumptions ?? []).filter(
                (assumption) => assumption !== "Initial plate-size estimate",
            ),
            "User confirmed the entire estimated plate was consumed.",
        ],
        sourceSnapshot: {
            ...(currentItem.sourceSnapshot ?? {}),
            established_facts: {
                consumed_fraction: 1,
                consumed_amount: "entire plate",
            },
        },
    },
});
draft = await answerMealDraftQuestion({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    questionId: portionQuestion.id,
    answer: "I ate the entire plate.",
});
if (
    draft.questions.find((question) => question.status === "open")
        ?.questionKey !== "hidden_oil"
) {
    throw new Error("Next draft question was not advanced correctly");
}

draft = await prepareMealDraftConfirmation({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    acceptRemainingAssumptions: true,
});
if (
    draft.status !== "awaiting_confirmation" ||
    draft.questions.some((question) => question.status === "open")
) {
    throw new Error("Draft assumptions were not accepted for confirmation");
}

const confirmVersion = draft.version;
draft = await confirmMealDraft({
    userId: userA,
    draftId: draft.id,
    expectedVersion: confirmVersion,
    confirmed: true,
});
if (draft.status !== "confirmed" || !draft.confirmedMealId) {
    throw new Error("Prepared draft was not confirmed");
}
const meal = await getStructuredMeal(userA, draft.confirmedMealId);
if (!meal || meal.items.length !== 1 || meal.calories !== 620) {
    throw new Error("Confirmed draft did not create the structured meal");
}
if (
    !meal.items[0]?.assumptions.some((value) =>
        value.includes("User accepted unresolved assumption"),
    )
) {
    throw new Error(
        "Accepted unresolved assumption was not preserved on the meal",
    );
}
if (
    !meal.items[0]?.assumptions.some((value) =>
        value.includes("entire estimated plate was consumed"),
    )
) {
    throw new Error("Reconciled portion answer was not preserved on the meal");
}

const retry = await confirmMealDraft({
    userId: userA,
    draftId: draft.id,
    expectedVersion: confirmVersion,
    confirmed: true,
});
if (retry.confirmedMealId !== draft.confirmedMealId) {
    throw new Error("Confirmation retry created or returned a different meal");
}
if (await getMealDraft(userB, draft.id)) {
    throw new Error("Cross-tenant draft read was allowed");
}
if (await getStructuredMeal(userB, draft.confirmedMealId)) {
    throw new Error("Cross-tenant confirmed meal read was allowed");
}

let cancelled = await createMealDraft({
    userId: userA,
    sourceMode: "text",
    description: "Cancelled snack",
    mealType: "snack",
});
cancelled = await cancelMealDraft({
    userId: userA,
    draftId: cancelled.id,
    expectedVersion: cancelled.version,
});
if (cancelled.status !== "cancelled" || cancelled.confirmedMealId) {
    throw new Error("Draft cancellation created an unexpected meal");
}

let removable = await createMealDraft({
    userId: userA,
    sourceMode: "text",
    description: "Draft with removable items",
    mealType: "dinner",
});
for (const [position, name] of (
    ["First item", "Second item"] as const
).entries()) {
    removable = await upsertMealDraftItem({
        userId: userA,
        draftId: removable.id,
        expectedVersion: removable.version,
        position,
        item: {
            name,
            nutrients: { calories: 100 + position },
            sourceType: "user_supplied",
        },
    });
}
removable = await deleteMealDraftItem({
    userId: userA,
    draftId: removable.id,
    itemId: removable.items[0]!.id,
    expectedVersion: removable.version,
});
if (
    removable.items.length !== 1 ||
    removable.items[0]?.position !== 0 ||
    removable.items[0]?.item.name !== "Second item"
) {
    throw new Error("Draft item deletion did not compact positions safely");
}

await closePlatformDatabase();
console.log(
    "Munch meal draft state, confirmation, idempotency, and RLS smoke test passed.",
);
