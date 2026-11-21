import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// W1d (audit area2 Finding 6): every editable draft must have an
// in-review add-item path, not just photo drafts. Non-photo editable
// drafts surface the existing structured add path (food search +
// manual food editor → POST /api/app/meal-drafts/:id/items); settled
// and expired drafts must render no add affordance and refuse add
// actions. Exercised on the real functions and action branches lifted
// out of public/app.js.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extract(name: string): string {
    const match = source.match(
        new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`app.js function not found: ${name}`);
    return match[0];
}

function extractConst(name: string, terminator: string): string {
    const start = source.indexOf(`const ${name} =`);
    if (start < 0) throw new Error(`app.js const not found: ${name}`);
    const end = source.indexOf(terminator, start);
    if (end < 0) throw new Error(`app.js const terminator not found: ${name}`);
    return source.slice(start, end + terminator.length);
}

function sliceBetween(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) {
        throw new Error(`markers not found: ${startMarker} / ${endMarker}`);
    }
    return source.slice(start, end);
}

interface ApiCall {
    path: string;
    method: string;
    body: unknown;
}

interface FakePendingRow {
    fields: Record<string, string>;
}

function createHarness() {
    const rootStub = {
        innerHTML: "",
        closest: () => null,
        querySelectorAll: () => [],
        querySelector: () => null,
    };
    const resultsStub = {
        innerHTML: "",
    };
    const pendingRows = new Map<number, FakePendingRow>();
    const apiCalls: ApiCall[] = [];
    const toasts: string[] = [];
    let apiResponder: (call: ApiCall) => unknown = () => {
        throw new Error("unexpected api call");
    };

    const draftActionHandlers = `
async function dispatchDraftAction(action, dataset = {}) {
    const button = { dataset };
    ${sliceBetween('if (action === "add-draft-manual")', 'if (action === "toggle-draft-item")')}
}
`;

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
const draftPortionField = () => "";
const sourceBadge = (type) => String(type || "");
const confidenceBadge = () => "";
const photoCaptureMarkup = () => "";
const searchDraftFoods = () => {};
const toast = (msg) => { __toasts.push(msg); };
const api = async (path, options = {}) => {
    const call = {
        path,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : undefined,
    };
    __apiCalls.push(call);
    return __apiResponder(call);
};
const document = {
    getElementById: (id) => {
        if (id === "meal-draft-review") return __rootStub;
        if (id === "meal-draft-food-results") {
            return __rootStub.innerHTML.includes('id="meal-draft-food-results"')
                ? __resultsStub
                : null;
        }
        return null;
    },
    querySelector: (selector) => {
        const match = selector.match(/^\\[data-draft-pending-index="(\\d+)"\\]$/);
        if (!match) return null;
        const idx = Number(match[1]);
        const row = __pendingRows.get(idx);
        if (!row) return null;
        return {
            querySelector: (fieldSel) => {
                const fm = fieldSel.match(/^\\[data-draft-field="([^"]+)"\\]$/);
                if (!fm) return null;
                const val = row.fields[fm[1]];
                return val === undefined ? null : { value: val };
            },
        };
    },
};
`;

    const context: Record<string, unknown> = {
        __rootStub: rootStub,
        __resultsStub: resultsStub,
        __pendingRows: pendingRows,
        __apiCalls: apiCalls,
        __toasts: toasts,
        __apiResponder: (call: ApiCall) => apiResponder(call),
    };

    runInNewContext(
        [
            sandboxPrelude,
            extractConst("MEAL_TYPE_OPTIONS", "];"),
            extractConst("DRAFT_BLOCKING_QUESTION_PREFIX", ";"),
            extractConst("draftNutrientFields", "];"),
            extract("escapeHtml"),
            extract("number"),
            extract("formatTime"),
            extract("mealTypeOptionsHtml"),
            extract("foodPortion"),
            extract("draftNumber"),
            extract("draftNutrientLabel"),
            extract("draftManualPayloadFromDom"),
            extract("draftItemKey"),
            extract("captureDraftUnsavedEdits"),
            extract("applyDraftUnsavedEdits"),
            extract("draftItemEditor"),
            extract("draftManualEditor"),
            extract("openBlockingQuestionItemNames"),
            extract("draftSwipeRemoves"),
            extract("draftLoggedLabel"),
            extract("renderMealDraftReview"),
            extract("renderDraftFoodResults"),
            extract("selectDraftFoodOption"),
            draftActionHandlers,
        ].join("\n"),
        context,
    );

    return {
        rootStub,
        resultsStub,
        pendingRows,
        apiCalls,
        toasts,
        setApiResponder(fn: (call: ApiCall) => unknown) {
            apiResponder = fn;
        },
        mealDraftReview: context.mealDraftReview as {
            draft: Record<string, unknown> | null;
            options: Map<string, unknown>;
            pendingManual: Array<Record<string, unknown>>;
        },
        render(draft: Record<string, unknown>): string {
            rootStub.innerHTML = "";
            (context.renderMealDraftReview as (d: unknown) => void)(draft);
            return rootStub.innerHTML;
        },
        renderDraftFoodResults: context.renderDraftFoodResults as (
            data: unknown,
        ) => void,
        selectDraftFoodOption: context.selectDraftFoodOption as (
            key: string,
        ) => Promise<void>,
        dispatchDraftAction: context.dispatchDraftAction as (
            action: string,
            dataset?: Record<string, string>,
        ) => Promise<void>,
    };
}

function makeDraft(overrides: Record<string, unknown> = {}) {
    return {
        id: "draft-text-1",
        status: "awaiting_confirmation",
        source_mode: "text",
        meal_type: "lunch",
        description: "Turkey sandwich",
        logged_at: "2026-11-12T17:30:00.000Z",
        notes: null,
        version: 2,
        expires_at: "2099-01-01T00:00:00.000Z",
        items: [
            {
                id: "item-1",
                name: "Turkey sandwich",
                quantity: 1,
                portion_label: "1 sandwich",
                gram_weight: null,
                nutrients: { calories: 420, protein_g: 28 },
                source_type: "usda",
                provider: "usda",
                confidence: 0.9,
                assumptions: [],
            },
        ],
        totals: { calories: 420, protein_g: 28, carbs_g: 40, fat_g: 14 },
        questions: [],
        ...overrides,
    };
}

describe("non-photo meal draft review can add missing items (W1d)", () => {
    test("editable non-photo drafts render the structured add path (manual + search)", () => {
        const harness = createHarness();
        for (const sourceMode of [
            "text",
            "barcode",
            "restaurant",
            "saved_food",
            "history",
            "chat",
        ]) {
            const html = harness.render(
                makeDraft({ source_mode: sourceMode, status: "open" }),
            );
            expect(html).toContain('data-action="add-draft-manual"');
            expect(html).toContain('id="meal-draft-food-search"');
            expect(html).toContain('id="meal-draft-food-results"');
            // Photo-only add-text box stays gated to photo drafts (server enforces photo-only).
            expect(html).not.toContain('id="meal-draft-add-text-input"');
        }
    });

    test("adding a missing manual item in a text draft posts to /items and re-renders the updated draft", async () => {
        const harness = createHarness();
        const initialDraft = makeDraft({ source_mode: "text", version: 2 });
        const initialHtml = harness.render(initialDraft);
        expect(initialHtml).toContain('data-action="add-draft-manual"');

        // Clicking "Add manual food" renders a pending manual editor row.
        await harness.dispatchDraftAction("add-draft-manual");
        expect(harness.mealDraftReview.pendingManual).toHaveLength(1);
        expect(harness.rootStub.innerHTML).toContain(
            'data-draft-pending-index="0"',
        );
        expect(harness.rootStub.innerHTML).toContain(
            'data-action="save-draft-manual"',
        );

        // Fill in the missing item and save it to the draft.
        harness.pendingRows.set(0, {
            fields: {
                name: "Apple",
                portion_label: "1 medium",
                quantity: "1",
                gram_weight: "182",
                calories: "95",
                protein_g: "0.5",
                carbs_g: "25",
                fat_g: "0.3",
            },
        });
        const updatedDraft = makeDraft({
            version: 3,
            items: [
                ...initialDraft.items,
                {
                    id: "item-2",
                    name: "Apple",
                    quantity: 1,
                    portion_label: "1 medium",
                    gram_weight: 182,
                    nutrients: {
                        calories: 95,
                        protein_g: 0.5,
                        carbs_g: 25,
                        fat_g: 0.3,
                    },
                    source_type: "user_supplied",
                    provider: null,
                    confidence: null,
                    assumptions: [],
                },
            ],
            totals: {
                calories: 515,
                protein_g: 28.5,
                carbs_g: 65,
                fat_g: 14.3,
            },
        });
        harness.setApiResponder(() => ({ draft: updatedDraft }));

        await harness.dispatchDraftAction("save-draft-manual", { index: "0" });

        expect(harness.apiCalls).toEqual([
            {
                path: "/api/app/meal-drafts/draft-text-1/items",
                method: "POST",
                body: {
                    expected_version: 2,
                    item: {
                        name: "Apple",
                        quantity: 1,
                        portion_label: "1 medium",
                        gram_weight: 182,
                        nutrients: {
                            calories: 95,
                            protein_g: 0.5,
                            carbs_g: 25,
                            fat_g: 0.3,
                        },
                        source_type: "user_supplied",
                        assumptions: [],
                        source_snapshot: { resolution_layer: "web_manual" },
                    },
                },
            },
        ]);
        expect(harness.mealDraftReview.pendingManual).toHaveLength(0);
        expect(harness.rootStub.innerHTML).toContain("Apple");
        expect(harness.rootStub.innerHTML).toContain("515");
    });

    test("selecting a search result in a text draft posts to /items and updates the draft", async () => {
        const harness = createHarness();
        const initialDraft = makeDraft({ source_mode: "text", version: 2 });
        harness.render(initialDraft);

        harness.renderDraftFoodResults({
            candidates: [
                {
                    candidate_id: "usda:171688",
                    name: "Apples, raw",
                    provider: "usda",
                    default_portion: { label: "1 medium", calories: 95 },
                },
            ],
            savedFoods: [],
            recentMealItems: [],
        });
        expect(harness.resultsStub.innerHTML).toContain(
            'data-action="select-draft-food-option"',
        );

        const updatedDraft = makeDraft({
            version: 3,
            items: [
                ...initialDraft.items,
                {
                    id: "item-2",
                    name: "Apples, raw",
                    quantity: 1,
                    portion_label: "1 medium",
                    gram_weight: 182,
                    nutrients: { calories: 95 },
                    source_type: "usda",
                    provider: "usda",
                    confidence: 0.95,
                    assumptions: [],
                },
            ],
            totals: { calories: 515, protein_g: 28, carbs_g: 65, fat_g: 14 },
        });
        harness.setApiResponder(() => ({ draft: updatedDraft }));

        await harness.selectDraftFoodOption("candidate:0");

        expect(harness.apiCalls).toEqual([
            {
                path: "/api/app/meal-drafts/draft-text-1/items",
                method: "POST",
                body: {
                    expected_version: 2,
                    item: {
                        candidate_id: "usda:171688",
                        quantity: 1,
                    },
                },
            },
        ]);
        expect(harness.rootStub.innerHTML).toContain("Apples, raw");
    });

    test("non-editable and expired drafts render no add affordance and refuse add actions", async () => {
        for (const scenario of [
            { label: "confirmed", overrides: { status: "confirmed" } },
            { label: "cancelled", overrides: { status: "cancelled" } },
            { label: "expired status", overrides: { status: "expired" } },
            {
                label: "past expires_at",
                overrides: {
                    status: "open",
                    expires_at: "2020-01-01T00:00:00.000Z",
                },
            },
        ]) {
            const harness = createHarness();
            harness.mealDraftReview.pendingManual.push({
                name: "Leftover",
                quantity: 1,
                portion_label: "",
                nutrients: {},
            });
            const html = harness.render(
                makeDraft({ source_mode: "text", ...scenario.overrides }),
            );
            expect(html).not.toContain('data-action="add-draft-manual"');
            expect(html).not.toContain('id="meal-draft-food-search"');
            expect(html).not.toContain('id="meal-draft-add-text-input"');
            expect(html).not.toContain('data-action="save-draft-manual"');
            expect(html).not.toContain('data-action="confirm-meal-draft"');
            if (
                scenario.label === "expired status" ||
                scenario.label === "past expires_at"
            ) {
                expect(html).toContain("This draft is expired.");
            }

            // Direct handler invocations must also be no-ops with zero API calls.
            harness.mealDraftReview.pendingManual = [];
            harness.mealDraftReview.options.set("candidate:0", {
                kind: "candidate",
                candidateId: "usda:171688",
            });
            harness.pendingRows.set(0, {
                fields: { name: "Apple", quantity: "1", calories: "95" },
            });

            await harness.dispatchDraftAction("add-draft-manual");
            expect(harness.mealDraftReview.pendingManual).toHaveLength(0);

            await harness.dispatchDraftAction("save-draft-manual", {
                index: "0",
            });
            await harness.selectDraftFoodOption("candidate:0");
            expect(harness.apiCalls).toHaveLength(0);
        }
    });

    test("photo drafts keep the simplified photo review without food search", () => {
        const harness = createHarness();
        const html = harness.render(makeDraft({ source_mode: "photo" }));
        expect(html).toContain('id="meal-draft-add-text-input"');
        expect(html).toContain('data-action="add-draft-text"');
        expect(html).not.toContain("meal-draft-food-search");
    });
});
