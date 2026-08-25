import type { MealDraft } from "./meal-drafts/types.js";
import type { StructuredMealItemInput } from "./structured-meals/types.js";

export interface ReviewAnswerReference {
    question_id?: string;
    question_key?: string;
    answer: string;
}

function comparableItem(item: StructuredMealItemInput): string {
    return JSON.stringify({
        name: item.name,
        quantity: item.quantity ?? null,
        portionLabel: item.portionLabel ?? null,
        gramWeight: item.gramWeight ?? null,
        nutrients: item.nutrients ?? {},
        sourceType: item.sourceType,
        provider: item.provider ?? null,
        providerFoodId: item.providerFoodId ?? null,
        providerRevision: item.providerRevision ?? null,
        sourceUrl: item.sourceUrl ?? null,
        sourceUpdatedAt: item.sourceUpdatedAt ?? null,
        confidence: item.confidence ?? null,
        assumptions: item.assumptions ?? [],
        sourceSnapshot: item.sourceSnapshot ?? {},
    });
}

function findOpenQuestion(draft: MealDraft, answer: ReviewAnswerReference) {
    return draft.questions.find(
        (question) =>
            question.status === "open" &&
            ((answer.question_id !== undefined &&
                question.id === answer.question_id) ||
                (answer.question_key !== undefined &&
                    question.questionKey === answer.question_key)),
    );
}

/**
 * An item-linked material answer is not reconciled merely because the answer
 * text was stored. Require the same atomic call to carry a changed canonical
 * item payload. If the caller cannot update the item yet, the question must
 * remain open rather than advancing the draft to confirmation with stale facts.
 */
export function assertReviewAnswersReconciled(
    draft: MealDraft,
    answers: ReviewAnswerReference[] | undefined,
    proposedItems: StructuredMealItemInput[] | undefined,
): void {
    for (const answer of answers ?? []) {
        const question = findOpenQuestion(draft, answer);
        if (!question || !question.itemId) continue;

        const currentItem = draft.items.find(
            (record) => record.id === question.itemId,
        );
        if (!currentItem) {
            throw new Error(
                `Review question ${question.questionKey} references a missing meal item`,
            );
        }

        const proposedItem = proposedItems?.[currentItem.position];
        if (!proposedItem) {
            throw new Error(
                `Answering item question "${question.questionKey}" requires a reconciled full items payload in the same call. Update the affected item's facts, assumptions, provenance, and nutrition before closing the question; otherwise leave it open.`,
            );
        }
        if (comparableItem(currentItem.item) === comparableItem(proposedItem)) {
            throw new Error(
                `Answering item question "${question.questionKey}" did not change the affected canonical item. Re-resolve the item from the new fact, or leave the question open until it can be reconciled.`,
            );
        }
    }
}
