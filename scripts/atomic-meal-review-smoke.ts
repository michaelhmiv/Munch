#!/usr/bin/env bun

import { createSmokeUser } from "./support/smoke-user.js";

const { prepareMealReview, resolveMealReview } =
    await import("../src/meal-drafts/atomic.js");
const { cancelMealDraft, confirmMealDraft, getMealDraft } =
    await import("../src/meal-drafts/repository.js");
const { getStructuredMeal } =
    await import("../src/structured-meals/repository.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is required for atomic meal review smoke tests",
    );
}

const items = [
    {
        name: "Roasted chicken thigh",
        portionLabel: "1 medium thigh",
        nutrients: { calories: 285, protein_g: 28, carbs_g: 0, fat_g: 19 },
        sourceType: "model_estimate" as const,
        confidence: 0.82,
        assumptions: ["Fork used as a scale reference"],
        sourceSnapshot: { source: "photo" },
    },
    {
        name: "Rice",
        portionLabel: "1 cup",
        nutrients: { calories: 205, protein_g: 4, carbs_g: 45, fat_g: 0.4 },
        sourceType: "model_estimate" as const,
        confidence: 0.78,
        assumptions: [],
        sourceSnapshot: { source: "photo" },
    },
    {
        name: "Mixed vegetables",
        portionLabel: "3/4 cup",
        nutrients: { calories: 90, protein_g: 3, carbs_g: 15, fat_g: 2 },
        sourceType: "model_estimate" as const,
        confidence: 0.76,
        assumptions: ["Light oil estimated"],
        sourceSnapshot: { source: "photo" },
    },
];

const userA = await createSmokeUser("atomic-review-a");
const userB = await createSmokeUser("atomic-review-b");
const requestId = `smoke-${crypto.randomUUID()}`;
let draft = await prepareMealReview({
    userId: userA,
    sourceMode: "photo",
    mealType: "dinner",
    description: "Homemade chicken, rice, and vegetables",
    loggedAt: "2026-08-05T22:00:00.000Z",
    requestId,
    items,
});
if (draft.status !== "awaiting_confirmation" || draft.items.length !== 3) {
    throw new Error(
        "Atomic clear review did not reach confirmation in one write",
    );
}

const retry = await prepareMealReview({
    userId: userA,
    sourceMode: "photo",
    mealType: "dinner",
    description: "Retry must deduplicate",
    requestId,
    items,
});
if (retry.id !== draft.id || retry.version !== draft.version) {
    throw new Error("Atomic preparation request id was not idempotent");
}

const staleVersion = draft.version;
draft = await prepareMealReview({
    userId: userA,
    sourceMode: "photo",
    mealType: "dinner",
    description: "Homemade chicken, rice, and vegetables",
    draftId: draft.id,
    expectedVersion: draft.version,
    items,
    questions: [
        {
            questionKey: "sauce_amount",
            prompt: "Was the visible sauce about one tablespoon or more?",
            impactScore: 90,
            itemPosition: 0,
        },
    ],
});
if (
    draft.status !== "awaiting_answers" ||
    draft.questions.filter((question) => question.status === "open").length !==
        1
) {
    throw new Error("Atomic review question was not created correctly");
}

let staleRejected = false;
try {
    await resolveMealReview({
        userId: userA,
        draftId: draft.id,
        expectedVersion: staleVersion,
        notes: "stale",
    });
} catch (error) {
    staleRejected = String(error).includes("expected version");
}
if (!staleRejected) throw new Error("Atomic stale update was not rejected");

const question = draft.questions.find((value) => value.status === "open")!;
draft = await resolveMealReview({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    answers: [
        {
            questionId: question.id,
            answer: "About one tablespoon.",
        },
    ],
    items: [
        {
            ...items[0],
            nutrients: { calories: 340, protein_g: 28, carbs_g: 3, fat_g: 24 },
            assumptions: ["One tablespoon sauce included"],
        },
        items[1],
        items[2],
    ],
    questions: [],
});
if (draft.status !== "awaiting_confirmation") {
    throw new Error("Resolved atomic review did not return to confirmation");
}

const confirmVersion = draft.version;
draft = await confirmMealDraft({
    userId: userA,
    draftId: draft.id,
    expectedVersion: confirmVersion,
    confirmed: true,
});
if (draft.status !== "confirmed" || !draft.confirmedMealId) {
    throw new Error("Atomic review confirmation failed");
}
const meal = await getStructuredMeal(userA, draft.confirmedMealId);
if (!meal || meal.items.length !== 3 || meal.calories !== 635) {
    throw new Error(
        "Atomic review did not persist the expected structured meal",
    );
}
if (await getMealDraft(userB, draft.id)) {
    throw new Error("Atomic draft crossed the RLS boundary");
}
if (await getStructuredMeal(userB, draft.confirmedMealId)) {
    throw new Error("Atomic confirmed meal crossed the RLS boundary");
}

let cancelled = await prepareMealReview({
    userId: userA,
    sourceMode: "text",
    mealType: "snack",
    description: "Cancelled review",
    requestId: `cancel-${crypto.randomUUID()}`,
    items: [items[1]],
});
cancelled = await cancelMealDraft({
    userId: userA,
    draftId: cancelled.id,
    expectedVersion: cancelled.version,
});
if (cancelled.status !== "cancelled") {
    throw new Error("Atomic review cancellation failed");
}

await closePlatformDatabase();
console.log(
    "Munch atomic meal review, idempotency, versioning, confirmation, cancellation, and RLS smoke test passed.",
);

export {};
