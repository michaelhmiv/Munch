import {
    reviewDraftNumbers,
    type DraftReviewDependencies,
    type DraftReviewOutcome,
} from "../decisions/draft-review.js";
import { blockingQuestionKey } from "../meal-drafts/blocking.js";
import {
    createMealDraftWithItemsAndQuestions,
    type MealDraft,
} from "../meal-drafts/index.js";
import { PHOTO_DRAFT_PLACEHOLDER_DESCRIPTION } from "../meal-drafts/naming.js";
import type {
    MealPhotoEstimate,
    MealPhotoEstimateRequest,
} from "./estimate.js";
import {
    groundMealPhotoItems,
    type GroundedMealPhotoItem,
    type MealPhotoGroundingDeps,
} from "./grounding.js";
import type { MealPhotoVisionResult } from "./vision.js";

/**
 * Stage 5 of the photo-logging pipeline (brief §3): land the grounded
 * estimate in the EXISTING meal-draft machinery — draft → questions →
 * `accept_remaining_assumptions` → confirm — unchanged. Nothing is
 * logged until the user confirms through the existing confirm path.
 * Low-confidence items become draft QUESTIONS, not silent guesses.
 * Items whose labelled estimate failed become BLOCKING questions:
 * the shared confirm path refuses to confirm until the user supplies
 * the item's nutrition or removes it (meal-drafts/blocking.ts).
 */

export const PHOTO_DRAFT_DESCRIPTION = PHOTO_DRAFT_PLACEHOLDER_DESCRIPTION;
export const PHOTO_DRAFT_NOTES =
    "Photo estimate — check portions. The meal photo was processed transiently to build this estimate and was not retained.";

export interface MealPhotoDraftResult {
    draft: MealDraft;
    grounded: GroundedMealPhotoItem[];
    groundedCount: number;
    /** Items whose values came from the labelled model-estimate step. */
    estimatedCount: number;
    /** Items with NO values and a blocking question (estimate failed). */
    blockingCount: number;
    questionCount: number;
    /** A3 numeric review outcome (unchecked = presented as before). */
    draftReview: {
        status: DraftReviewOutcome["status"];
        flaggedCount: number;
        model: string | null;
        reportedCostUsd: number | null;
    };
}

/**
 * A3 flagged-item handoff (jev-accountability-audit §2 seat A3):
 * a provider-grounded item whose numbers the numeric review flagged
 * drops to the LABELLED estimate path — the same model-estimate
 * shape grounding.ts builds for ungrounded items — or, when no
 * usable estimate comes through, to a BLOCKING draft question with
 * no values at all. Both mechanisms already exist; this function
 * only wires the flag to them. Reviewed-but-plausible items keep
 * their provider values and gain the verdict in their snapshot —
 * the accountability trail is stored with the data it judged.
 * Pure transformation (no I/O) so it is unit-testable without a DB.
 */
export function applyDraftReviewHandoff(
    grounded: GroundedMealPhotoItem[],
    review: DraftReviewOutcome,
    estimates: Map<string, MealPhotoEstimate>,
): GroundedMealPhotoItem[] {
    if (review.status !== "reviewed") return grounded;
    const verdictByIndex = new Map(review.verdicts.map((v) => [v.index, v]));
    return grounded.map((entry, index) => {
        const verdict = verdictByIndex.get(index);
        if (!verdict) return entry;
        const a3Review = {
            status: verdict.flagged ? "flagged" : "plausible",
            model: review.model,
            p_plausible: verdict.pPlausible,
            threshold: verdict.threshold,
            original_grounding_source: entry.groundingSource,
            original_candidate_id: entry.candidateId,
            original_gram_weight: entry.draftItem.gramWeight ?? null,
            original_kcal: entry.draftItem.nutrients.calories ?? null,
        };
        if (!verdict.flagged) {
            return {
                ...entry,
                draftItem: {
                    ...entry.draftItem,
                    sourceSnapshot: {
                        ...entry.draftItem.sourceSnapshot,
                        a3_review: a3Review,
                    },
                },
            };
        }
        const { vision } = entry;
        const portionLabel = `${vision.quantity} ${vision.unit}`;
        const estimate = estimates.get(`item:${index}`);
        const usableEstimate =
            estimate &&
            Object.values(estimate.nutrients).some(
                (value) => value !== undefined,
            ) &&
            (estimate.nutrients.calories ?? 0) > 0
                ? estimate
                : undefined;
        if (usableEstimate) {
            return {
                ...entry,
                draftItem: {
                    name: vision.name,
                    quantity: vision.quantity,
                    portionLabel,
                    gramWeight: usableEstimate.gramWeight,
                    nutrients: usableEstimate.nutrients,
                    sourceType: "model_estimate" as const,
                    confidence: vision.portion_confidence,
                    assumptions: [...vision.assumptions].slice(0, 20),
                    sourceSnapshot: {
                        resolution_layer: "meal_photo_grounding",
                        vision_name: vision.name,
                        cooking_method: vision.cooking_method,
                        portion_confidence: vision.portion_confidence,
                        candidate_id: null,
                        tie_break_used: entry.tieBreakUsed,
                        estimate_origin: "model_estimate",
                        estimate_step: "meal_photo_estimate",
                        a3_review: a3Review,
                        nutrition_snapshot: usableEstimate.nutrients,
                    },
                },
                groundingSource: "model_estimate" as const,
                grounded: false,
                estimated: true,
                candidateId: null,
            };
        }
        const blocking = {
            questionKey: blockingQuestionKey(index),
            prompt: `Our plausibility review flagged the nutrition for ${vision.name} (${portionLabel}) as implausible for that portion, and the automatic estimate didn't come through. Please supply or confirm its nutrition, or remove the item — this draft can't be confirmed until that's done.`,
            impactScore: 100,
            blocking: true,
        };
        return {
            ...entry,
            draftItem: {
                name: vision.name,
                quantity: vision.quantity,
                portionLabel,
                nutrients: {},
                sourceType: "model_estimate" as const,
                confidence: vision.portion_confidence,
                assumptions: [...vision.assumptions].slice(0, 20),
                sourceSnapshot: {
                    resolution_layer: "meal_photo_grounding",
                    vision_name: vision.name,
                    cooking_method: vision.cooking_method,
                    portion_confidence: vision.portion_confidence,
                    candidate_id: null,
                    tie_break_used: entry.tieBreakUsed,
                    estimate_origin: "model_estimate",
                    estimate_step: "meal_photo_estimate",
                    estimate_status: "unavailable",
                    a3_review: a3Review,
                    blocking_question_key: blocking.questionKey,
                },
            },
            groundingSource: "model_estimate" as const,
            grounded: false,
            estimated: false,
            candidateId: null,
            needsQuestion: true,
            question: blocking,
        };
    });
}

export async function createMealPhotoDraft(input: {
    userId: string;
    vision: MealPhotoVisionResult;
    groundingDeps: MealPhotoGroundingDeps;
    mealType?: MealDraft["mealType"];
    description?: string;
    loggedAt?: string;
    /** A3 seat seam (tests/drills); production reads the env config. */
    draftReviewDeps?: DraftReviewDependencies;
}): Promise<MealPhotoDraftResult> {
    const groundedRaw = await groundMealPhotoItems(
        input.vision.items,
        input.groundingDeps,
    );
    // A3 — photo-draft NUMERIC plausibility review (audit §2): after
    // grounding completes, before the draft is presented. Numbers
    // only — the seat's payload is built from the grounded items'
    // text/numeric state; the photo is never sent (the seat exists
    // because Jev image verification is dead and stays dead).
    // Fail-open: an unchecked outcome presents the draft exactly as
    // grounding produced it.
    const reviewableIndices = groundedRaw
        .map((entry, index) => (entry.grounded ? index : -1))
        .filter((index) => index >= 0);
    const review = await reviewDraftNumbers(
        reviewableIndices.map((index) => {
            const entry = groundedRaw[index]!;
            return {
                foodName: entry.draftItem.name,
                portionLabel:
                    entry.draftItem.portionLabel ??
                    `${entry.vision.quantity} ${entry.vision.unit}`,
                grams: entry.draftItem.gramWeight ?? null,
                kcal: entry.draftItem.nutrients.calories ?? null,
                groundingSource: entry.groundingSource,
            };
        }),
        input.draftReviewDeps ?? {},
    );
    // The seat's verdict indices are positions in the reviewable
    // list; remap them to draft positions before the handoff.
    const remappedReview: DraftReviewOutcome =
        review.status === "reviewed"
            ? {
                  ...review,
                  verdicts: review.verdicts.map((verdict) => ({
                      ...verdict,
                      index: reviewableIndices[verdict.index]!,
                  })),
              }
            : review;
    const flaggedIndices =
        remappedReview.status === "reviewed"
            ? remappedReview.verdicts
                  .filter((verdict) => verdict.flagged)
                  .map((verdict) => verdict.index)
            : [];
    // Flagged items drop to the labelled estimate path: ONE batched
    // estimate call for every flagged item (grounding's stage-4c
    // pattern). A failed/absent estimate yields blocking questions
    // in the handoff instead — never the flagged provider values.
    let flagEstimates = new Map<string, MealPhotoEstimate>();
    if (flaggedIndices.length > 0 && input.groundingDeps.estimateNutrients) {
        const requests: MealPhotoEstimateRequest[] = flaggedIndices.map(
            (index) => {
                const vision = groundedRaw[index]!.vision;
                return {
                    key: `item:${index}`,
                    name: vision.name,
                    cookingMethod: vision.cooking_method,
                    quantity: vision.quantity,
                    unit: vision.unit,
                    assumptions: [...vision.assumptions],
                };
            },
        );
        try {
            flagEstimates =
                await input.groundingDeps.estimateNutrients(requests);
        } catch {
            flagEstimates = new Map();
        }
    }
    const grounded = applyDraftReviewHandoff(
        groundedRaw,
        remappedReview,
        flagEstimates,
    );
    // Persistence is ONE transaction (photo-latency fix, 2026-11-12):
    // the previous shape ran create + one upsert per item + one
    // question insert per question, each a separate transaction that
    // re-loaded the whole draft — a quadratic tax inside draft_build.
    // Questions link to items by position; the bulk create resolves
    // them to the persisted item records.
    const draft = await createMealDraftWithItemsAndQuestions({
        userId: input.userId,
        sourceMode: "photo",
        mealType: input.mealType,
        description: input.description?.trim() || PHOTO_DRAFT_DESCRIPTION,
        // Photo-flow P6: a photo draft is a meal being logged NOW —
        // its logged_at defaults to the moment of capture, never to a
        // fixed meal-slot time. The field stays editable in review.
        loggedAt: input.loggedAt ?? new Date().toISOString(),
        notes: PHOTO_DRAFT_NOTES,
        items: grounded.map((entry) => entry.draftItem),
        questions: grounded.flatMap((entry, index) =>
            entry.question
                ? [
                      {
                          questionKey: entry.question.questionKey,
                          prompt: entry.question.prompt,
                          impactScore: entry.question.impactScore,
                          itemPosition: index,
                      },
                  ]
                : [],
        ),
    });
    return {
        draft,
        grounded,
        groundedCount: grounded.filter((entry) => entry.grounded).length,
        estimatedCount: grounded.filter((entry) => entry.estimated).length,
        blockingCount: grounded.filter((entry) => entry.question?.blocking)
            .length,
        questionCount: grounded.filter((entry) => entry.question).length,
        draftReview: {
            status: review.status,
            flaggedCount: flaggedIndices.length,
            model: review.status === "reviewed" ? review.model : null,
            reportedCostUsd:
                review.status === "reviewed" ? review.reportedCostUsd : null,
        },
    };
}
