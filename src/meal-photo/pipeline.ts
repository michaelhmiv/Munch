import {
    impliedKcalPer100g,
    reviewDraftNumbers,
    type DraftReviewDependencies,
    type DraftReviewOutcome,
} from "../decisions/draft-review.js";
import type { MealPhotoGateVerdict } from "../decisions/gate.js";
import { portionUnitKind } from "../food-providers/portions.js";
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
    finalizeGroundedMealPhotoItems,
    resolveMealPhotoPicks,
    type GroundedMealPhotoItem,
    type MealPhotoGroundingDeps,
    type MealPhotoGroundingTimings,
} from "./grounding.js";
import { MealPhotoNoFoodError, type MealPhotoVisionResult } from "./vision.js";

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

export interface MealPhotoPipelineTimings extends MealPhotoGroundingTimings {
    estimateMs: number;
    draftReviewMs: number;
    flagEstimateMs: number;
    dbMs: number;
}

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
    timings?: MealPhotoPipelineTimings;
}

/**
 * Run the S1 front-door gate in parallel with vision identification so
 * the gate adds zero latency on real food photos while still aborting
 * vision immediately when the gate returns a confident `no_food` verdict.
 */
export async function identifyWithMealPhotoGate(input: {
    runGate?: () => Promise<MealPhotoGateVerdict>;
    runIdentify: (signal: AbortSignal) => Promise<MealPhotoVisionResult>;
}): Promise<MealPhotoVisionResult> {
    const controller = new AbortController();
    if (!input.runGate) {
        return input.runIdentify(controller.signal);
    }
    const gatePromise = input.runGate().catch((): MealPhotoGateVerdict => ({
        action: "proceed",
        reason: "gate_error",
    }));
    const identifyPromise = input.runIdentify(controller.signal);
    // Attach early-abort handler so a fast `no_food` verdict cancels the
    // in-flight vision call immediately instead of waiting for it to finish.
    const gateRejectPromise = gatePromise.then((verdict) => {
        if (verdict.action === "no_food") {
            const noFood = new MealPhotoNoFoodError();
            controller.abort(noFood);
            throw noFood;
        }
        return verdict;
    });
    // Prevent unhandled rejection if identify rejects first while gate is pending.
    gateRejectPromise.catch(() => {});
    // Race identify against an early gate `no_food` throw.
    const vision = await Promise.race([
        identifyPromise,
        gateRejectPromise.then(() => identifyPromise),
    ]);
    // Ensure a late gate `no_food` verdict is still honoured before returning.
    const verdict = await gatePromise;
    if (verdict.action === "no_food") {
        throw new MealPhotoNoFoodError();
    }
    return vision;
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
                candidate: null,
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
            candidate: null,
            needsQuestion: true,
            question: blocking,
        };
    });
}

export const A3_SKIP_MAX_GRAMS = 1_000;
export const A3_SKIP_MAX_KCAL = 1_200;
export const A3_SKIP_MAX_KCAL_PER_100G = 900;

/**
 * Conservative deterministic pre-filter for A3 photo-draft numeric
 * review (analogous to `selectBulkOutlierCandidates` for bulk imports).
 * A3 catches wrong-for-this-food portion conversions ("1 cup" of olive
 * oil at salad grams, beverage at solid grams, condiment at entrée
 * portions). An item weighed directly in a weight unit (g, oz, kg, lb)
 * against a USDA generic's `100g` panel undergoes ZERO portion-unit
 * conversion, so when its grams, total calories, and implied kcal/100g
 * sit within ordinary physical bounds it does not need an extra
 * Decisions round-trip. Every non-weight unit conversion, branded/OFF
 * item, high-calorie item (>1,200 kcal or >1,000 g), or density outlier
 * (>900 kcal/100 g) is still reviewed by A3.
 */
export function needsDraftNumericReview(entry: GroundedMealPhotoItem): boolean {
    if (!entry.grounded) return false;
    if (entry.groundingSource !== "USDA") return true;
    if (entry.candidate?.dataKind !== "generic") return true;
    if (portionUnitKind(entry.vision.unit) !== "weight") return true;
    const snapshot = entry.draftItem.sourceSnapshot as
        { selected_portion_id?: unknown } | undefined;
    if (snapshot?.selected_portion_id !== "100g") return true;
    const grams = entry.draftItem.gramWeight ?? null;
    const kcal = entry.draftItem.nutrients.calories ?? null;
    if (
        grams === null ||
        kcal === null ||
        !Number.isFinite(grams) ||
        !Number.isFinite(kcal) ||
        grams <= 0 ||
        grams > A3_SKIP_MAX_GRAMS ||
        kcal < 0 ||
        kcal > A3_SKIP_MAX_KCAL
    ) {
        return true;
    }
    const density = impliedKcalPer100g({
        foodName: entry.draftItem.name,
        portionLabel:
            entry.draftItem.portionLabel ??
            `${entry.vision.quantity} ${entry.vision.unit}`,
        grams,
        kcal,
        groundingSource: entry.groundingSource,
    });
    if (density === null || density > A3_SKIP_MAX_KCAL_PER_100G) return true;
    return false;
}

/**
 * Run Stage 4c (model estimate for ungrounded items) and Stage 5 A3
 * (numeric plausibility review for grounded items) in parallel — they
 * inspect disjoint item subsets and share no data dependency.
 */
export async function groundAndReviewMealPhotoItems(input: {
    items: MealPhotoVisionResult["items"];
    groundingDeps: MealPhotoGroundingDeps;
    draftReviewDeps?: DraftReviewDependencies;
}): Promise<{
    grounded: GroundedMealPhotoItem[];
    review: DraftReviewOutcome;
    flaggedCount: number;
    timings: Omit<MealPhotoPipelineTimings, "dbMs">;
}> {
    const {
        picks,
        estimateRequests,
        timings: groundingTimings,
    } = await resolveMealPhotoPicks(input.items, input.groundingDeps);

    // Pre-build grounded items (without estimates yet) to derive the exact
    // reviewable subset for A3 numeric review while Stage 4c runs in parallel.
    const preliminary = finalizeGroundedMealPhotoItems(picks, new Map());
    const reviewableIndices = preliminary
        .map((entry, index) => (needsDraftNumericReview(entry) ? index : -1))
        .filter((index) => index >= 0);

    let estimateMs = 0;
    let draftReviewMs = 0;

    const estimatePromise = (async (): Promise<
        Map<string, MealPhotoEstimate>
    > => {
        if (
            estimateRequests.length === 0 ||
            !input.groundingDeps.estimateNutrients
        ) {
            return new Map();
        }
        const startedAt = Date.now();
        try {
            return await input.groundingDeps.estimateNutrients(
                estimateRequests,
            );
        } catch {
            return new Map();
        } finally {
            estimateMs = Math.max(0, Date.now() - startedAt);
        }
    })();

    const reviewPromise = (async (): Promise<DraftReviewOutcome> => {
        const startedAt = Date.now();
        try {
            return await reviewDraftNumbers(
                reviewableIndices.map((index) => {
                    const entry = preliminary[index]!;
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
        } finally {
            draftReviewMs = Math.max(0, Date.now() - startedAt);
        }
    })();

    const [estimates, review] = await Promise.all([
        estimatePromise,
        reviewPromise,
    ]);

    const groundedRaw =
        estimates.size > 0
            ? finalizeGroundedMealPhotoItems(picks, estimates)
            : preliminary;

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
    let flagEstimateMs = 0;
    if (flaggedIndices.length > 0 && input.groundingDeps.estimateNutrients) {
        const flagStartedAt = Date.now();
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
        flagEstimateMs = Math.max(0, Date.now() - flagStartedAt);
    }
    const grounded = applyDraftReviewHandoff(
        groundedRaw,
        remappedReview,
        flagEstimates,
    );
    return {
        grounded,
        review,
        flaggedCount: flaggedIndices.length,
        timings: {
            ...groundingTimings,
            estimateMs,
            draftReviewMs,
            flagEstimateMs,
        },
    };
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
    const { grounded, review, flaggedCount, timings } =
        await groundAndReviewMealPhotoItems({
            items: input.vision.items,
            groundingDeps: input.groundingDeps,
            draftReviewDeps: input.draftReviewDeps,
        });
    // Persistence is ONE transaction with bulk item/question inserts.
    const dbStartedAt = Date.now();
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
    const dbMs = Math.max(0, Date.now() - dbStartedAt);
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
            flaggedCount,
            model: review.status === "reviewed" ? review.model : null,
            reportedCostUsd:
                review.status === "reviewed" ? review.reportedCostUsd : null,
        },
        timings: { ...timings, dbMs },
    };
}
