import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Multi-photo meal logging (2026-11-12): up to 3 photos, ONE
// identify pass server-side; the client sends every prepared photo
// under the repeated `file` field, and the review carries the
// session's photos so one can be removed (re-estimate) or another
// added before confirming. The render half runs the real
// renderMealDraftReview lifted out of app.js.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extract(name: string): string {
    const match = source.match(
        new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`app.js function not found: ${name}`);
    return match[0];
}

function sliceBetween(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0)
        throw new Error(`markers not found: ${startMarker} / ${endMarker}`);
    return source.slice(start, end);
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
    photoBusy: false,
    dirtyItems: new Set(),
    detailsDirty: false,
    expandedItems: new Set(),
    savedMessage: null,
    suppressSnapshot: false,
};
var mealPhotoCapture = { session: null };
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
const photoCaptureMarkup = (opts) => "CAPTURE:" + (opts.inputId ?? "");
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
const mealPhotoCapture = context.mealPhotoCapture as {
    session: { draftId: string; files: unknown[] } | null;
};

function photoDraft() {
    return {
        id: "draft-multi",
        status: "awaiting_confirmation",
        source_mode: "photo",
        meal_type: "dinner",
        description: "Lasagna",
        logged_at: "2026-11-12T23:42:00.000Z",
        notes: null,
        version: 1,
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
        ],
        totals: { calories: 600, protein_g: 25, carbs_g: 60, fat_g: 28 },
        questions: [],
    };
}

function render(draft: unknown): string {
    rootStub.innerHTML = "";
    renderMealDraftReview(draft);
    return rootStub.innerHTML;
}

describe("multi-photo review strip", () => {
    test("the session's photos render with Remove, plus the add control under the cap", () => {
        mealPhotoCapture.session = {
            draftId: "draft-multi",
            files: [{ name: "a.jpg" }, { name: "b.jpg" }],
        };
        try {
            const html = render(photoDraft());
            expect(html).toContain("meal-draft-photos");
            expect(html).toContain("Photo 1");
            expect(html).toContain("Photo 2");
            expect(
                html.match(/data-action="remove-draft-photo"/g),
            ).toHaveLength(2);
            expect(html).toContain("CAPTURE:meal-draft-photo-file");
        } finally {
            mealPhotoCapture.session = null;
        }
    });

    test("at the cap of 3 the add control disappears", () => {
        mealPhotoCapture.session = {
            draftId: "draft-multi",
            files: [{}, {}, {}],
        };
        try {
            const html = render(photoDraft());
            expect(html).not.toContain("CAPTURE:meal-draft-photo-file");
            expect(
                html.match(/data-action="remove-draft-photo"/g),
            ).toHaveLength(3);
        } finally {
            mealPhotoCapture.session = null;
        }
    });

    test("no strip for a draft this session did not produce", () => {
        mealPhotoCapture.session = { draftId: "someone-else", files: [{}] };
        try {
            const html = render(photoDraft());
            expect(html).not.toContain("meal-draft-photos");
        } finally {
            mealPhotoCapture.session = null;
        }
    });
});

describe("multi-photo capture and submit wiring", () => {
    test("the Log by photo control accepts multiple photos", () => {
        const dialog = sliceBetween(
            "async function openMealPhotoDialog",
            "async function submitMealPhoto",
        );
        expect(dialog).toContain("multiple: true");
        expect(dialog).toContain("Up to 3 photos of the same meal");
    });

    test("submit prepares each photo and appends every one as `file`", () => {
        const submit = sliceBetween(
            "async function submitMealPhoto",
            "async function reestimateDraftPhotos",
        );
        expect(submit).toContain("selected.length > 3");
        expect(submit).toContain(
            'for (const prepared of preparedFiles) form.append("file", prepared);',
        );
        expect(submit).toContain("mealPhotoCapture.session = {");
    });

    test("removing the last photo cancels the draft and returns to the capture sheet", () => {
        const remove = sliceBetween(
            'if (action === "remove-draft-photo")',
            'if (action === "add-draft-manual")',
        );
        expect(remove).toContain("reestimateDraftPhotos(remaining)");
        expect(remove).toContain("/cancel`");
        expect(remove).toContain("openMealPhotoDialog()");
    });

    test("the review listens for its own capture control's change event", () => {
        expect(source).toContain('"photo-capture:change"');
        expect(source).toContain('querySelector?.("#meal-draft-photo-file")');
        expect(source).toContain("addDraftPhotos(files)");
    });
});
