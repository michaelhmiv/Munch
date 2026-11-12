import {
    createMealDraftWithItemsAndQuestions,
    type MealDraft,
} from "../meal-drafts/index.js";
import { PHOTO_DRAFT_PLACEHOLDER_DESCRIPTION } from "../meal-drafts/naming.js";
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
}

export async function createMealPhotoDraft(input: {
    userId: string;
    vision: MealPhotoVisionResult;
    groundingDeps: MealPhotoGroundingDeps;
    mealType?: MealDraft["mealType"];
    description?: string;
    loggedAt?: string;
}): Promise<MealPhotoDraftResult> {
    const grounded = await groundMealPhotoItems(
        input.vision.items,
        input.groundingDeps,
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
    };
}
