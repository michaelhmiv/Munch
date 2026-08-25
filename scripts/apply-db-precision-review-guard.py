#!/usr/bin/env python3
from pathlib import Path

path = Path("src/meal-drafts/repository.ts")
text = path.read_text()

old_import = 'import { assertDraftQuestionPreviouslyReconciled } from "../meal-review-reconciliation.js";\n'
if text.count(old_import) != 1:
    raise SystemExit("expected exactly one legacy reconciliation import")
text = text.replace(old_import, "", 1)

anchor = '''export async function answerMealDraftQuestion(input: {
'''
helper = '''async function assertDraftQuestionPreviouslyReconciledAtDatabasePrecision(
    tx: DatabaseTransaction,
    draftId: string,
    question: MealDraftQuestion,
): Promise<void> {
    if (!question.itemId) return;
    const rows = await tx<Array<{ reconciled: boolean }>>`
        select exists (
            select 1
            from munch.meal_draft_questions q
            join munch.meal_draft_items i
              on i.id = q.item_id
             and i.draft_id = q.draft_id
            where q.id = ${question.id}
              and q.draft_id = ${draftId}
              and i.updated_at > q.created_at
        ) as reconciled
    `;
    if (!rows[0]?.reconciled) {
        throw new Error(
            `Answering item question "${question.questionKey}" requires reconciling the affected canonical item first. Update its facts, assumptions, provenance, and nutrition as needed, then answer the question.`,
        );
    }
}

export async function answerMealDraftQuestion(input: {
'''
if text.count(anchor) != 1:
    raise SystemExit("expected exactly one answerMealDraftQuestion anchor")
text = text.replace(anchor, helper, 1)

old_call = '''        assertDraftQuestionPreviouslyReconciled(draft, question);
'''
new_call = '''        await assertDraftQuestionPreviouslyReconciledAtDatabasePrecision(
            tx,
            input.draftId,
            question,
        );
'''
if text.count(old_call) != 1:
    raise SystemExit("expected exactly one legacy reconciliation call")
text = text.replace(old_call, new_call, 1)

path.write_text(text)
print("Applied database-precision legacy reconciliation guard.")
