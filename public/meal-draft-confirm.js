/**
 * The meal-draft confirm gate, as a pure decision.
 *
 * Photo-flow audit (2026-11-12): tapping "Confirm and accept
 * assumptions" on a draft with open questions used to toast and
 * return without sending any request — and the toast renders
 * outside the modal dialog, so it was never visible. The user saw a
 * button whose label promised acceptance do literally nothing, and
 * no confirm request ever reached the server.
 *
 * The gate is now a two-step, in-place decision:
 *   - "confirm"            — no questions open, or the user already
 *                            accepted (checkbox / explicit accept):
 *                            send the confirm request.
 *   - "needs_acceptance"   — questions are open and nothing has
 *                            accepted them yet: the review swaps its
 *                            actions in place for the explicit
 *                            acceptance step. No request is sent,
 *                            and the user is told why, in place.
 *
 * The server contract already supports both paths
 * (POST /api/app/meal-drafts/:id/confirm with
 * accept_remaining_assumptions); this module only decides which
 * step the client is on.
 */
export function draftConfirmDecision({ openQuestionCount, accepted }) {
    if (openQuestionCount > 0 && !accepted) return "needs_acceptance";
    return "confirm";
}

/** How many questions on a serialized draft are still open. */
export function openDraftQuestionCount(draft) {
    if (!draft || !Array.isArray(draft.questions)) return 0;
    return draft.questions.filter((question) => question.status === "open")
        .length;
}
