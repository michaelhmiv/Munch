import { describe, expect, test } from "bun:test";
import type { DraftReviewOutcome } from "../decisions/draft-review.js";
import { isBlockingDraftQuestion } from "../meal-drafts/blocking.js";
import type { MealPhotoEstimate } from "./estimate.js";
import type { GroundedMealPhotoItem } from "./grounding.js";
import { mealPhotoItemIsComplete as groundingComplete } from "./grounding.js";
import { applyDraftReviewHandoff } from "./pipeline.js";

function groundedItem(
    overrides: Partial<GroundedMealPhotoItem> = {},
): GroundedMealPhotoItem {
    const base: GroundedMealPhotoItem = {
        vision: {
            name: "Olive oil",
            cooking_method: null,
            quantity: 1,
            unit: "cup",
            portion_confidence: 0.9,
            assumptions: [],
        },
        draftItem: {
            name: "Olive oil",
            quantity: 1,
            portionLabel: "1 cup",
            gramWeight: 32,
            nutrients: { calories: 283, fat_g: 32 },
            sourceType: "usda",
            provider: "usda",
            providerFoodId: "123",
            confidence: 0.9,
            assumptions: [],
            sourceSnapshot: { resolution_layer: "meal_photo_grounding" },
        },
        groundingSource: "USDA",
        grounded: true,
        estimated: false,
        candidateId: "usda:123",
        tieBreakUsed: false,
        needsQuestion: false,
        question: null,
    };
    return { ...base, ...overrides };
}

function reviewedOutcome(
    verdicts: Array<{ index: number; pPlausible: number; flagged: boolean }>,
): DraftReviewOutcome {
    return {
        status: "reviewed",
        reason: "reviewed",
        model: "typesafe/jev-1.14",
        reportedCostUsd: 0.00007,
        durationMs: 210,
        verdicts: verdicts.map((v) => ({ ...v, threshold: 0.5 })),
    };
}

describe("A3 flagged-item handoff (pipeline)", () => {
    test("flagged + usable estimate -> labelled model_estimate path, provider attribution gone", () => {
        const estimates = new Map<string, MealPhotoEstimate>([
            [
                "item:0",
                {
                    nutrients: { calories: 1909, fat_g: 216 },
                    gramWeight: 216,
                },
            ],
        ]);
        const [entry] = applyDraftReviewHandoff(
            [groundedItem()],
            reviewedOutcome([{ index: 0, pPlausible: 0.05, flagged: true }]),
            estimates,
        );
        expect(entry!.grounded).toBe(false);
        expect(entry!.estimated).toBe(true);
        expect(entry!.groundingSource).toBe("model_estimate");
        expect(entry!.draftItem.sourceType).toBe("model_estimate");
        expect(entry!.draftItem.provider).toBeUndefined();
        expect(entry!.draftItem.providerFoodId).toBeUndefined();
        expect(entry!.draftItem.nutrients.calories).toBe(1909);
        const snapshot = entry!.draftItem.sourceSnapshot as any;
        expect(snapshot.estimate_origin).toBe("model_estimate");
        expect(snapshot.a3_review.status).toBe("flagged");
        expect(snapshot.a3_review.original_candidate_id).toBe("usda:123");
        expect(groundingComplete(entry!)).toBe(true);
    });

    test("flagged + no estimate -> blocking draft question, no values", () => {
        const [entry] = applyDraftReviewHandoff(
            [groundedItem()],
            reviewedOutcome([{ index: 0, pPlausible: 0.02, flagged: true }]),
            new Map(),
        );
        expect(entry!.grounded).toBe(false);
        expect(entry!.estimated).toBe(false);
        expect(entry!.draftItem.nutrients).toEqual({});
        expect(entry!.question?.blocking).toBe(true);
        expect(
            isBlockingDraftQuestion({
                questionKey: entry!.question!.questionKey,
            }),
        ).toBe(true);
        expect(entry!.question!.prompt).toContain(
            "plausibility review flagged",
        );
        expect(groundingComplete(entry!)).toBe(true);
    });

    test("plausible verdict -> provider values stand, verdict stored in snapshot", () => {
        const [entry] = applyDraftReviewHandoff(
            [groundedItem()],
            reviewedOutcome([{ index: 0, pPlausible: 0.97, flagged: false }]),
            new Map(),
        );
        expect(entry!.grounded).toBe(true);
        expect(entry!.draftItem.nutrients.calories).toBe(283);
        expect(entry!.draftItem.provider).toBe("usda");
        const snapshot = entry!.draftItem.sourceSnapshot as any;
        expect(snapshot.a3_review.status).toBe("plausible");
        expect(snapshot.a3_review.model).toBe("typesafe/jev-1.14");
    });

    test("unchecked outcome -> grounded array returned untouched (fail-open presentation)", () => {
        const items = [groundedItem()];
        const outcome: DraftReviewOutcome = {
            status: "unchecked",
            reason: "decisions_unavailable",
            verdicts: [],
            model: null,
            reportedCostUsd: null,
        };
        const result = applyDraftReviewHandoff(items, outcome, new Map());
        expect(result).toBe(items);
        expect(result[0]!.draftItem.nutrients.calories).toBe(283);
    });
});
