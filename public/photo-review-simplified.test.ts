import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Simplified photo draft review (owner-approved frames, 2026-11-12):
// totals strip at the top, plain item rows below (tap → editor,
// swipe → remove), ONE note box, ONE Confirm, a blocking question
// only as a single line above the note box, and the re-analyzing
// state while a note is applied. Exercised on the real
// renderMealDraftReview lifted out of app.js.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extract(name: string): string {
    const match = source.match(
        new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`app.js function not found: ${name}`);
    return match[0];
}

const optionsConst = source.match(
    /const MEAL_TYPE_OPTIONS = \[[\s\S]*?\];/,
)?.[0];
const blockingPrefixConst = source.match(
    /const DRAFT_BLOCKING_QUESTION_PREFIX = "[^"]+";/,
)?.[0];
if (!optionsConst || !blockingPrefixConst)
    throw new Error("app.js constants not found");

const rootStub = {
    innerHTML: "",
    closest: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
};

const sandboxPrelude = `
const state = { bootstrap: { profile: { timezone: "America/New_York" } } };
var mealDraftReview = {
    draft: null,
    options: new Map(),
    pendingManual: [],
    searchTimer: null,
    addTextMessage: null,
    addTextBusy: null,
    dirtyItems: new Set(),
    detailsDirty: false,
    expandedItems: new Set(),
    savedMessage: null,
    suppressSnapshot: false,
};
const document = {
    getElementById: (id) => (id === "meal-draft-review" ? rootStub : null),
    querySelector: () => null,
};
const draftNutrientFields = [];
const draftNutrientLabel = (key) => key;
const draftPortionField = () => "";
const sourceBadge = () => "B";
const confidenceBadge = () => "";
const draftManualEditor = () => "";
`;

const context: Record<string, unknown> = { rootStub };
runInNewContext(
    [
        sandboxPrelude,
        optionsConst,
        blockingPrefixConst,
        extract("escapeHtml"),
        extract("number"),
        extract("formatTime"),
        extract("mealTypeOptionsHtml"),
        extract("draftItemKey"),
        extract("captureDraftUnsavedEdits"),
        extract("applyDraftUnsavedEdits"),
        extract("draftItemEditor"),
        extract("openBlockingQuestionItemNames"),
        extract("draftSwipeRemoves"),
        extract("draftLoggedLabel"),
        extract("renderMealDraftReview"),
    ].join("\n"),
    context,
);

const renderMealDraftReview = context.renderMealDraftReview as (
    draft: unknown,
) => void;
const openBlockingQuestionItemNames = context.openBlockingQuestionItemNames as (
    draft: unknown,
) => string[];
const draftSwipeRemoves = context.draftSwipeRemoves as (
    a: number,
    b: number,
) => boolean;
const mealDraftReview = context.mealDraftReview as {
    addTextBusy: string | null;
    addTextMessage: string | null;
    expandedItems: Set<string>;
};

function baseDraft(overrides: Record<string, unknown> = {}) {
    return {
        id: "draft-1",
        status: "awaiting_confirmation",
        source_mode: "photo",
        meal_type: "dinner",
        description: "Lasagna and garlic bread",
        logged_at: "2026-11-12T23:42:00.000Z",
        notes: null,
        version: 3,
        expires_at: null,
        items: [
            {
                id: "item-1",
                name: "Lasagna",
                quantity: 1.5,
                portion_label: "1.5 cup",
                gram_weight: null,
                nutrients: { calories: 600 },
                source_type: "model_estimate",
                provider: null,
                confidence: 0.6,
                assumptions: [],
            },
            {
                id: "item-2",
                name: "Garlic bread",
                quantity: 1,
                portion_label: "1 slice",
                gram_weight: null,
                nutrients: { calories: 150 },
                source_type: "model_estimate",
                provider: null,
                confidence: 0.7,
                assumptions: [],
            },
        ],
        totals: { calories: 750, protein_g: 32, carbs_g: 80, fat_g: 30 },
        questions: [],
        ...overrides,
    };
}

function render(draft: unknown): string {
    rootStub.innerHTML = "";
    renderMealDraftReview(draft);
    return rootStub.innerHTML;
}

describe("simplified review — the approved frame inventory", () => {
    test("totals strip first, plain rows, one note box, one primary", () => {
        const html = render(
            baseDraft({
                questions: [
                    {
                        id: "q1",
                        item_id: "item-1",
                        question_key: "photo_portion_0",
                        prompt: "About how much lasagna?",
                        status: "open",
                        answer: null,
                    },
                ],
            }),
        );
        // Totals strip at the top, calories leading.
        expect(html).toContain("meal-draft-totals");
        expect(html.indexOf("meal-draft-totals")).toBeLessThan(
            html.indexOf("meal-draft-item-toggle"),
        );
        expect(html).toContain("750");
        // Plain rows: name, portion, kcal — no badges on the row.
        expect(html).toContain("meal-draft-item-toggle");
        expect(html).toContain("1.5 cup");
        expect(html).toContain("600 kcal");
        expect(html).not.toContain("meal-draft-item-badges");
        // One note box, one Confirm, quiet Abandon.
        expect(html).toContain('id="meal-draft-add-text-input"');
        expect(html.match(/data-action="confirm-meal-draft"/g)).toHaveLength(1);
        expect(html).toContain("Confirm and log meal");
        expect(html).toContain("Abandon draft");
        // The clutter the owner struck is gone.
        expect(html).not.toContain("Questions");
        expect(html).not.toContain("Save changes");
        expect(html).not.toContain("data-draft-savebar");
        expect(html).not.toContain("Meal details");
        expect(html).not.toContain("Foods and provenance");
        expect(html).not.toContain("meal-draft-food-search");
        expect(html).not.toContain("data-draft-accept-assumptions");
        expect(html).not.toContain("Version 3");
        // A non-blocking open question does NOT interrupt.
        expect(html).not.toContain("no nutrition values yet");
    });

    test("meta line shows the logged date and time and a meal-type select", () => {
        const html = render(baseDraft());
        expect(html).toContain("Thu, Nov 12");
        expect(html).toContain("6:42 PM");
        expect(html).toContain('data-draft-field="meal_type"');
        expect(html).toContain(
            '<option value="dinner" selected>Dinner</option>',
        );
    });

    test("a blocking question interrupts as ONE line above the note box", () => {
        const draft = baseDraft({
            items: [
                {
                    id: "item-9",
                    name: "Mystery stew",
                    quantity: 1,
                    portion_label: "1 bowl",
                    gram_weight: null,
                    nutrients: {},
                    source_type: "model_estimate",
                    provider: null,
                    confidence: null,
                    assumptions: [],
                },
            ],
            questions: [
                {
                    id: "q9",
                    item_id: "item-9",
                    question_key: "photo_estimate_missing_0",
                    prompt: "What is this?",
                    status: "open",
                    answer: null,
                },
            ],
        });
        expect(openBlockingQuestionItemNames(draft)).toEqual(["Mystery stew"]);
        const html = render(draft);
        expect(html).toContain("meal-draft-blocker");
        expect(html).toContain("Mystery stew has no nutrition values yet.");
        expect(html.indexOf("meal-draft-blocker")).toBeLessThan(
            html.indexOf('id="meal-draft-add-text-input"'),
        );
        // Still no Questions section — the line is the whole surface.
        expect(html).not.toContain("data-draft-question-id");
    });

    test("the re-analyzing state dims totals and items and locks controls", () => {
        mealDraftReview.addTextBusy = "I added a good bit of butter";
        try {
            const html = render(baseDraft());
            expect(html).toContain("Re-analyzing your meal");
            expect(html).toContain("Your note: “I added a good bit of butter”");
            expect(html.match(/meal-draft-dim/g)).toHaveLength(2);
            expect(html).toContain('value="I added a good bit of butter"');
            expect(html).toContain("disabled");
        } finally {
            mealDraftReview.addTextBusy = null;
        }
    });

    test("a settled draft renders no actions, only its status", () => {
        const html = render(baseDraft({ status: "confirmed" }));
        expect(html).not.toContain('data-action="confirm-meal-draft"');
        expect(html).toContain("This draft is confirmed.");
    });
});

describe("swipe to remove", () => {
    test("a firm leftward swipe removes; small or rightward movement does not", () => {
        expect(draftSwipeRemoves(300, 200)).toBe(true);
        expect(draftSwipeRemoves(300, 250)).toBe(false);
        expect(draftSwipeRemoves(200, 300)).toBe(false);
    });
    test("the gesture and the Remove button land on the same request", () => {
        expect(source).toContain("requestRemoveDraftItem(");
        const swipe = source.slice(
            source.indexOf("draftSwipeArm = null;"),
            source.indexOf("async function handleAction"),
        );
        expect(swipe).toContain("requestRemoveDraftItem(");
        const removeHandler = source.slice(
            source.indexOf('if (action === "remove-draft-item")'),
            source.indexOf('if (action === "confirm-remove-draft-item")'),
        );
        expect(removeHandler).toContain("requestRemoveDraftItem(");
    });
});
