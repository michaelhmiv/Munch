import { describe, expect, test } from "bun:test";
import {
    draftConfirmDecision,
    openDraftQuestionCount,
} from "./meal-draft-confirm.js";

/**
 * Photo-flow audit (2026-11-12) regression: the silent save.
 * Michael's draft had open questions (his answers had failed
 * server-side), he tapped the button labelled "Confirm and accept
 * assumptions", and the client toasted + returned without sending
 * anything — the toast being invisible under the modal dialog, the
 * tap simply died. The decision below is what now drives the
 * in-place acceptance step instead.
 */
describe("draftConfirmDecision", () => {
    test("no open questions confirms immediately", () => {
        expect(
            draftConfirmDecision({ openQuestionCount: 0, accepted: false }),
        ).toBe("confirm");
    });
    test("open questions without acceptance stop for the in-place step (the silent-save case)", () => {
        expect(
            draftConfirmDecision({ openQuestionCount: 2, accepted: false }),
        ).toBe("needs_acceptance");
    });
    test("open questions with the assumptions accepted confirm", () => {
        expect(
            draftConfirmDecision({ openQuestionCount: 2, accepted: true }),
        ).toBe("confirm");
    });
    test("no open questions and accepted still confirm", () => {
        expect(
            draftConfirmDecision({ openQuestionCount: 0, accepted: true }),
        ).toBe("confirm");
    });
});

describe("openDraftQuestionCount", () => {
    test("counts only status=open questions", () => {
        const draft = {
            questions: [
                { status: "open" },
                { status: "answered" },
                { status: "open" },
                { status: "assumed" },
            ],
        };
        expect(openDraftQuestionCount(draft)).toBe(2);
    });
    test("tolerates missing drafts and question lists", () => {
        expect(openDraftQuestionCount(null)).toBe(0);
        expect(openDraftQuestionCount({})).toBe(0);
        expect(openDraftQuestionCount({ questions: [] })).toBe(0);
    });
});
