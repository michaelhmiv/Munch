import { describe, expect, test } from "bun:test";
import type { MealDraft } from "./meal-drafts/types.js";
import { assertReviewAnswersReconciled } from "./meal-review-reconciliation.js";

const beefDraft: MealDraft = {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    status: "awaiting_answers",
    sourceMode: "photo",
    mealType: "dinner",
    description: "Ground beef bowl",
    loggedAt: null,
    notes: null,
    version: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    confirmedMealId: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    items: [
        {
            id: "33333333-3333-4333-8333-333333333333",
            position: 0,
            createdAt: "2026-08-24T00:00:00.000Z",
            updatedAt: "2026-08-24T00:00:00.000Z",
            item: {
                name: "Cooked ground beef",
                quantity: 1,
                portionLabel: "about 6 oz cooked",
                gramWeight: 170,
                nutrients: {
                    calories: 390,
                    protein_g: 44,
                    carbs_g: 0,
                    fat_g: 23,
                },
                sourceType: "model_estimate",
                provider: "visual estimate",
                confidence: 0.72,
                assumptions: [
                    "Estimated approximately 6 oz cooked ground beef from photo; lean percentage and cooking fat are unknown.",
                ],
            },
        },
    ],
    questions: [
        {
            id: "44444444-4444-4444-8444-444444444444",
            itemId: "33333333-3333-4333-8333-333333333333",
            questionKey: "ground_beef_lean_percent",
            prompt: "What lean percentage was the ground beef?",
            impactScore: 85,
            status: "open",
            answer: null,
            createdAt: "2026-08-24T00:00:00.000Z",
            answeredAt: null,
        },
    ],
};

const answer = {
    question_key: "ground_beef_lean_percent",
    answer: "90% lean",
};

describe("meal review reconciliation", () => {
    test("rejects closing an item question with answer text only", () => {
        expect(() =>
            assertReviewAnswersReconciled(beefDraft, [answer], undefined),
        ).toThrow("requires a reconciled full items payload");
    });

    test("rejects an unchanged item payload", () => {
        expect(() =>
            assertReviewAnswersReconciled(
                beefDraft,
                [answer],
                [beefDraft.items[0]!.item],
            ),
        ).toThrow("did not change the affected canonical item");
    });

    test("accepts an answer when the canonical item is reconciled", () => {
        expect(() =>
            assertReviewAnswersReconciled(
                beefDraft,
                [answer],
                [
                    {
                        ...beefDraft.items[0]!.item,
                        nutrients: {
                            calories: 360,
                            protein_g: 45,
                            carbs_g: 0,
                            fat_g: 19,
                        },
                        assumptions: [
                            "Estimated approximately 6 oz cooked 90% lean ground beef from photo; cooking fat remains unknown.",
                        ],
                        sourceSnapshot: {
                            established_facts: { lean_percentage: 90 },
                        },
                    },
                ],
            ),
        ).not.toThrow();
    });

    test("does not require item changes for a draft-level question", () => {
        const draft: MealDraft = {
            ...beefDraft,
            questions: [
                {
                    ...beefDraft.questions[0]!,
                    itemId: null,
                    questionKey: "meal_note",
                },
            ],
        };
        expect(() =>
            assertReviewAnswersReconciled(
                draft,
                [{ question_key: "meal_note", answer: "No note" }],
                undefined,
            ),
        ).not.toThrow();
    });
});
