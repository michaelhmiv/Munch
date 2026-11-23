import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as cheerio from "cheerio";
import * as appApi from "./app-api.js";

/**
 * W1c — Composer survival (Findings 4 & 5 of audit/area6-sync-auth.md):
 *
 * 1. The manual meal composer (items, quantities, notes, meal type, pantry
 *    toggle) persists across app kill, browser/tab close, full-page
 *    navigation, and dialog close/reopen, clearing only when the meal is
 *    successfully logged, explicitly cleared, or the user signs out.
 * 2. A 401 session expiry mid-task must not destroy in-progress work:
 *    the transport runs the app's pre-auth hook BEFORE redirecting (web)
 *    or wiping the bearer token + jumping to login (mobile), persisting
 *    the composed meal (or dirty draft-review edits) with reopenAfterAuth,
 *    deferring the immediate redirect so the dialog stays on screen with
 *    an in-place sign-in prompt, and automatically restoring the work
 *    after re-authentication.
 * 3. Honest offline (Decision 6) stays intact: offline writes fail
 *    honestly without queueing, while keeping the composed state safe.
 */

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const runtimeSource = readFileSync(
    new URL("../mobile/runtime.js", import.meta.url),
    "utf8",
);

const originalFetch = globalThis.fetch;
const originalNavigator = globalThis.navigator;

function setOnLine(value: boolean) {
    Object.defineProperty(globalThis, "navigator", {
        value: { onLine: value },
        configurable: true,
    });
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
    });
    appApi.resetMunchPlatformAdapter();
});

function createFakeStorage() {
    const store = new Map<string, string>();
    return {
        store,
        getItem(key: string) {
            return store.has(key) ? store.get(key)! : null;
        },
        setItem(key: string, value: string) {
            store.set(key, String(value));
        },
        removeItem(key: string) {
            store.delete(key);
        },
        clear() {
            store.clear();
        },
    };
}

/** Extract a top-level function declaration from public/app.js if present. */
function maybeFn(name: string): string {
    const match = appSource.match(
        new RegExp(`(?:async\\s+)?function ${name}\\([^]*?\\n\\}`),
    );
    return match ? `${match[0]}\n` : "";
}

/** Extract a top-level const declaration from public/app.js if present. */
function maybeConst(name: string): string {
    const match = appSource.match(new RegExp(`const ${name}\\s*=[^;]+;`, "m"));
    return match ? `${match[0]}\n` : "";
}

interface FakeEl {
    id?: string;
    value: string;
    checked: boolean;
    hidden: boolean;
    textContent: string;
    className: string;
    dataset: Record<string, string>;
    attributes: Record<string, string>;
    children: FakeEl[];
    _innerHTML: string;
    innerHTML: string;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    prepend(child: FakeEl): void;
    querySelector(selector: string): FakeEl | null;
    querySelectorAll(selector: string): FakeEl[];
}

function makeFakeEl(tagOrProps: Partial<FakeEl> = {}): FakeEl {
    const el: FakeEl = {
        value: "",
        checked: false,
        hidden: false,
        textContent: "",
        className: "",
        dataset: {},
        attributes: {},
        children: [],
        _innerHTML: "",
        get innerHTML() {
            return this._innerHTML;
        },
        set innerHTML(html: string) {
            this._innerHTML = html;
        },
        setAttribute(name: string, value: string) {
            this.attributes[name] = value;
        },
        getAttribute(name: string) {
            return this.attributes[name] ?? null;
        },
        prepend(child: FakeEl) {
            this.children.unshift(child);
        },
        querySelector(selector: string): FakeEl | null {
            if (selector === '[data-testid="auth-expired-notice"]') {
                return (
                    this.children.find(
                        (child) =>
                            child.dataset.testid === "auth-expired-notice",
                    ) ?? null
                );
            }
            return null;
        },
        querySelectorAll(): FakeEl[] {
            return [];
        },
        ...tagOrProps,
    };
    return el;
}

/**
 * Lightweight simulated browser instance that executes the real composer
 * functions extracted from public/app.js against a shared localStorage.
 * Creating a second instance with the same storage simulates a full page
 * reload, browser/tab close + reopen, or mobile OS app kill.
 */
function createComposerInstance(
    storage: ReturnType<typeof createFakeStorage>,
    opts: { pantryEnabled?: boolean; defaultSlot?: string } = {},
) {
    let dialogOpen = false;
    let dialogTitle = "";
    let dialogHtml = "";

    const mealTypeEl = makeFakeEl({ value: opts.defaultSlot ?? "breakfast" });
    const notesEl = makeFakeEl({ value: "" });
    const pantryEl = makeFakeEl({ checked: false });
    const clearBtnEl = makeFakeEl({ id: "meal-composer-clear", hidden: true });
    const totalsEl = makeFakeEl({ id: "meal-composer-totals" });
    const deltaEl = makeFakeEl({ id: "meal-composer-delta" });
    const breakdownEl = makeFakeEl({
        id: "meal-composer-breakdown",
        hidden: true,
    });
    const selectedItemsEl = makeFakeEl({ id: "meal-selected-items" });

    // Item rows built from #meal-selected-items innerHTML via cheerio so
    // syncMealComposerFromDom reads the real DOM markup produced by
    // renderMealComposerItems().
    let itemRowElements: FakeEl[] = [];

    function rebuildItemRows(html: string) {
        const $ = cheerio.load(`<div id="root">${html}</div>`);
        itemRowElements = [];
        $("#root [data-composer-index]").each((_, node) => {
            const $row = $(node);
            const fields = new Map<string, FakeEl>();
            $row.find("[data-composer-field]").each((__, fieldNode) => {
                const $field = $(fieldNode);
                const fieldName = $field.attr("data-composer-field") || "";
                let val = "";
                if (fieldNode.tagName === "select") {
                    const selected = $field.find("option[selected]");
                    val =
                        selected.attr("value") ??
                        $field.find("option").first().attr("value") ??
                        "";
                } else {
                    val = $field.attr("value") ?? "";
                }
                fields.set(fieldName, makeFakeEl({ value: val }));
            });
            const rowEl = makeFakeEl({
                dataset: {
                    composerIndex: $row.attr("data-composer-index") || "0",
                },
            });
            rowEl.querySelector = (selector: string) => {
                const m = selector.match(/\[data-composer-field="([^"]+)"\]/);
                return m ? (fields.get(m[1]) ?? null) : null;
            };
            itemRowElements.push(rowEl);
        });
    }

    Object.defineProperty(selectedItemsEl, "innerHTML", {
        get() {
            return selectedItemsEl._innerHTML;
        },
        set(html: string) {
            selectedItemsEl._innerHTML = html;
            rebuildItemRows(html);
        },
    });
    selectedItemsEl.querySelectorAll = (selector: string) =>
        selector === "[data-composer-index]" ? itemRowElements : [];

    const formEl = makeFakeEl({ id: "meal-form" });
    formEl.querySelector = (selector: string) => {
        if (selector === 'select[name="meal_type"]') return mealTypeEl;
        if (selector === 'textarea[name="notes"]') return notesEl;
        if (selector === 'input[name="from_pantry"]')
            return opts.pantryEnabled === false ? null : pantryEl;
        if (selector === '[data-testid="auth-expired-notice"]') {
            return (
                formEl.children.find(
                    (child) => child.dataset.testid === "auth-expired-notice",
                ) ?? null
            );
        }
        return null;
    };

    // Draft review fake root for Finding 5 draft-review tests.
    let draftReviewActive = false;
    const draftItemFields = new Map<string, FakeEl>();
    const draftDetailsMealType = makeFakeEl({ value: "dinner" });
    const draftAddTextEl = makeFakeEl({
        id: "meal-draft-add-text-input",
        value: "",
    });
    const draftReviewEl = makeFakeEl({ id: "meal-draft-review" });
    const draftItemRowEl = makeFakeEl({
        dataset: { draftItemIndex: "0" },
    });
    draftItemRowEl.querySelectorAll = (selector: string) =>
        selector === "[data-draft-field]" ? [...draftItemFields.values()] : [];
    draftReviewEl.querySelectorAll = (selector: string) => {
        if (selector === "[data-draft-item-index]") return [draftItemRowEl];
        if (selector === "[data-draft-pending-index]") return [];
        if (selector === "[data-draft-details] [data-draft-field]")
            return [draftDetailsMealType];
        return [];
    };
    draftReviewEl.querySelector = (selector: string) => {
        if (selector === '[data-testid="auth-expired-notice"]') {
            return (
                draftReviewEl.children.find(
                    (child) => child.dataset.testid === "auth-expired-notice",
                ) ?? null
            );
        }
        return null;
    };

    const fakeDocument = {
        createElement() {
            return makeFakeEl();
        },
        getElementById(id: string) {
            if (!dialogOpen) return null;
            if (id === "meal-form") return draftReviewActive ? null : formEl;
            if (id === "meal-selected-items")
                return draftReviewActive ? null : selectedItemsEl;
            if (id === "meal-composer-totals")
                return draftReviewActive ? null : totalsEl;
            if (id === "meal-composer-delta")
                return draftReviewActive ? null : deltaEl;
            if (id === "meal-composer-breakdown")
                return draftReviewActive ? null : breakdownEl;
            if (id === "meal-composer-clear")
                return draftReviewActive ? null : clearBtnEl;
            if (id === "meal-draft-review")
                return draftReviewActive ? draftReviewEl : null;
            if (id === "meal-draft-add-text-input")
                return draftReviewActive ? draftAddTextEl : null;
            return null;
        },
        querySelector(selector: string) {
            if (selector === ".meal-composer-strip") return makeFakeEl();
            return null;
        },
    };

    const dialog = {
        get open() {
            return dialogOpen;
        },
        close() {
            dialogOpen = false;
            draftReviewActive = false;
        },
    };

    function openDialog(title: string, body: string) {
        dialogOpen = true;
        draftReviewActive = body.includes('id="meal-draft-review"');
        dialogTitle = title;
        dialogHtml = body;
        formEl.children = [];
        draftReviewEl.children = [];
        if (!draftReviewActive) {
            const $ = cheerio.load(body);
            const selectedOption = $(
                '#meal-form select[name="meal_type"] option[selected]',
            );
            mealTypeEl.value =
                selectedOption.attr("value") ??
                $('#meal-form select[name="meal_type"] option')
                    .first()
                    .attr("value") ??
                "breakfast";
            notesEl.value = $('#meal-form textarea[name="notes"]').text();
            pantryEl.checked =
                $('#meal-form input[name="from_pantry"]').attr("checked") !==
                undefined;
            clearBtnEl.hidden =
                $("#meal-composer-clear").attr("hidden") !== undefined;
        }
    }

    const code = [
        maybeConst("MEAL_TYPE_OPTIONS"),
        maybeConst("MEAL_COMPOSER_DRAFT_KEY"),
        maybeConst("MEAL_COMPOSER_DRAFT_TTL_MS"),
        maybeConst("MEAL_DRAFT_REVIEW_EDITS_KEY"),
        maybeConst("VALID_MEAL_TYPES"),
        maybeFn("escapeHtml"),
        maybeFn("createIdempotencyKey"),
        maybeFn("mealTypeOptionsHtml"),
        maybeFn("number"),
        maybeFn("sourceBadge"),
        maybeFn("confidenceLabel"),
        maybeFn("confidenceBadge"),
        maybeFn("foodTitle"),
        maybeFn("foodPortion"),
        maybeFn("composerCustomPortionNutrients"),
        maybeFn("portionOptionLabelJs"),
        maybeFn("foodMacroLine"),
        maybeFn("draftItemKey"),
        maybeFn("captureDraftUnsavedEdits"),
        maybeFn("applyDraftUnsavedEdits"),
        maybeFn("draftHasUnsavedChanges"),
        maybeFn("normalizeComposerDraftItem"),
        maybeFn("hasMealComposerDraftContent"),
        maybeFn("readMealComposerDraft"),
        maybeFn("writeMealComposerDraft"),
        maybeFn("clearMealComposerDraft"),
        maybeFn("syncMealComposerClearButton"),
        maybeFn("persistMealComposerState"),
        maybeFn("readMealDraftReviewEdits"),
        maybeFn("writeMealDraftReviewEdits"),
        maybeFn("clearMealDraftReviewEdits"),
        maybeFn("persistMealDraftReviewEdits"),
        maybeFn("showDialogAuthExpiredNotice"),
        maybeFn("handleBeforeAuthenticationRequired"),
        maybeFn("maybeRestoreAfterAuth"),
        maybeFn("syncMealComposerFromDom"),
        maybeFn("normalizedComposerText"),
        maybeFn("composerNutrientsEqual"),
        maybeFn("findComposerDuplicate"),
        maybeFn("mergeMealComposerItem"),
        maybeFn("renderMealComposerItems"),
        maybeFn("mealComposerItemMacros"),
        maybeFn("mealComposerTotals"),
        maybeFn("mealComposerDayTotals"),
        maybeFn("updateMealComposerStrip"),
        maybeFn("composerBreakdownHtml"),
        maybeFn("composerMealDescription"),
        maybeFn("mealComposerPayload"),
        maybeFn("openMealComposer"),
        `({
            state,
            mealComposer,
            mealDraftReview,
            openMealComposer,
            syncMealComposerFromDom,
            renderMealComposerItems,
            mealComposerPayload,
            readMealComposerDraft: typeof readMealComposerDraft === "function" ? readMealComposerDraft : null,
            writeMealComposerDraft: typeof writeMealComposerDraft === "function" ? writeMealComposerDraft : null,
            clearMealComposerDraft: typeof clearMealComposerDraft === "function" ? clearMealComposerDraft : null,
            persistMealComposerState: typeof persistMealComposerState === "function" ? persistMealComposerState : null,
            readMealDraftReviewEdits: typeof readMealDraftReviewEdits === "function" ? readMealDraftReviewEdits : null,
            clearMealDraftReviewEdits: typeof clearMealDraftReviewEdits === "function" ? clearMealDraftReviewEdits : null,
            persistMealDraftReviewEdits: typeof persistMealDraftReviewEdits === "function" ? persistMealDraftReviewEdits : null,
            handleBeforeAuthenticationRequired: typeof handleBeforeAuthenticationRequired === "function" ? handleBeforeAuthenticationRequired : null,
            maybeRestoreAfterAuth: typeof maybeRestoreAfterAuth === "function" ? maybeRestoreAfterAuth : null,
        })`,
    ].join("\n");

    const openedDraftIds: string[] = [];

    const sandbox = {
        crypto: globalThis.crypto,
        localStorage: storage,
        document: fakeDocument,
        dialog,
        openDialog,
        state: {
            bootstrap: {
                profile: { timezone: "UTC" },
                features: { pantry: opts.pantryEnabled !== false },
            },
            route: "today",
            date: "2026-11-20",
            todayRange: null,
            todayDayData: { totals: { calories: 500 } },
            postAuthRestoreChecked: false,
        },
        mealComposer: {
            items: [] as Array<Record<string, unknown>>,
            options: new Map(),
            searchTimer: null,
            usuals: new Map(),
            yesterday: null,
            mealTypeTouched: false,
        },
        mealDraftReview: {
            draft: null as null | {
                id: string;
                version: number;
                items: Array<Record<string, unknown>>;
            },
            options: new Map(),
            pendingManual: [] as Array<Record<string, unknown>>,
            dirtyItems: new Set<string>(),
            detailsDirty: false,
            expandedItems: new Set<string>(),
            actionNote: null as string | null,
            savedMessage: null as string | null,
        },
        sourceLabels: {
            usda: "USDA",
            user_supplied: "User supplied",
            past_meal: "Past meal",
            saved_food: "Saved food",
        },
        sourceClasses: {},
        SESSION_EXPIRED_PRESERVED_MESSAGE:
            (appApi as Record<string, unknown>)
                .SESSION_EXPIRED_PRESERVED_MESSAGE ??
            "Your session expired. Your meal is saved on this device — sign in again to continue.",
        featureFlags: () => ({ pantry: opts.pantryEnabled !== false }),
        defaultMealType: () => opts.defaultSlot ?? "breakfast",
        searchMealFoods: () => {},
        loadMealUsuals: () => Promise.resolve(),
        openMealDraft: async (id: string) => {
            openedDraftIds.push(id);
            openDialog(
                "Review meal draft",
                `<div id="meal-draft-review"></div>`,
            );
        },
        formatRecipeQuantity: (n: number) => String(n),
    };

    const exports = runInNewContext(code, sandbox) as {
        state: typeof sandbox.state;
        mealComposer: typeof sandbox.mealComposer;
        mealDraftReview: typeof sandbox.mealDraftReview;
        openMealComposer: () => void;
        syncMealComposerFromDom: () => void;
        renderMealComposerItems: () => void;
        mealComposerPayload: () => unknown[];
        readMealComposerDraft:
            ((now?: number) => Record<string, unknown> | null) | null;
        writeMealComposerDraft:
            ((draft: Record<string, unknown>) => boolean) | null;
        clearMealComposerDraft: (() => void) | null;
        persistMealComposerState:
            ((opts?: { reopenAfterAuth?: boolean }) => boolean) | null;
        readMealDraftReviewEdits:
            | ((
                  draftId?: string | null,
                  now?: number,
              ) => Record<string, unknown> | null)
            | null;
        clearMealDraftReviewEdits: ((draftId?: string | null) => void) | null;
        persistMealDraftReviewEdits:
            ((opts?: { reopenAfterAuth?: boolean }) => boolean) | null;
        handleBeforeAuthenticationRequired: (() => unknown) | null;
        maybeRestoreAfterAuth: (() => Promise<void>) | null;
    };

    return {
        ...exports,
        dialog,
        formEl,
        draftReviewEl,
        mealTypeEl,
        notesEl,
        pantryEl,
        clearBtnEl,
        totalsEl,
        openedDraftIds,
        get dialogOpen() {
            return dialogOpen;
        },
        get dialogTitle() {
            return dialogTitle;
        },
        get dialogHtml() {
            return dialogHtml;
        },
        get itemRowElements() {
            return itemRowElements;
        },
        setDraftReviewOpen(
            draft: {
                id: string;
                version: number;
                items: Array<Record<string, unknown>>;
            },
            itemEdits: Record<string, string>,
            detailsMealType: string,
            addText = "",
        ) {
            exports.mealDraftReview.draft = draft;
            exports.mealDraftReview.dirtyItems.add(
                String(draft.items[0]?.id ?? "index:0"),
            );
            exports.mealDraftReview.detailsDirty = true;
            draftItemFields.clear();
            for (const [field, value] of Object.entries(itemEdits)) {
                draftItemFields.set(
                    field,
                    makeFakeEl({ value, dataset: { draftField: field } }),
                );
            }
            draftDetailsMealType.dataset = { draftField: "meal_type" };
            draftDetailsMealType.value = detailsMealType;
            draftAddTextEl.value = addText;
            openDialog(
                "Review meal draft",
                `<div id="meal-draft-review"></div>`,
            );
        },
    };
}

const SAMPLE_FOOD = {
    candidate_id: "usda:171265",
    provider: "usda",
    provider_food_id: "171265",
    name: "Eggs, whole, scrambled",
    confidence: 0.95,
    portions: [
        {
            id: "large-egg",
            label: "1 large egg",
            gram_weight: 61,
            nutrients: {
                calories: 91,
                protein_g: 6.1,
                carbs_g: 1.0,
                fat_g: 6.7,
            },
        },
        {
            id: "cup",
            label: "1 cup",
            gram_weight: 220,
            nutrients: {
                calories: 328,
                protein_g: 22.0,
                carbs_g: 3.5,
                fat_g: 24.2,
            },
        },
    ],
};

describe("manual meal composer survival (Finding 4)", () => {
    test("composer draft (items, quantities, notes, meal type, pantry) persists and restores across a simulated reload / app kill", () => {
        const storage = createFakeStorage();

        // Session 1: user composes a meal by hand.
        const session1 = createComposerInstance(storage, {
            pantryEnabled: true,
            defaultSlot: "breakfast",
        });
        session1.openMealComposer();

        session1.mealComposer.items.push(
            {
                kind: "food",
                food: SAMPLE_FOOD,
                candidateId: SAMPLE_FOOD.candidate_id,
                portionId: "cup",
                quantity: 2,
            },
            {
                kind: "manual",
                name: "Sourdough toast",
                portionLabel: "1 slice",
                quantity: 1.5,
                nutrients: {
                    calories: 120,
                    protein_g: 4,
                    carbs_g: 24,
                    fat_g: 1,
                },
                sourceType: "user_supplied",
            },
        );
        session1.renderMealComposerItems();
        session1.mealTypeEl.value = "dinner";
        session1.mealComposer.mealTypeTouched = true;
        session1.notesEl.value = "Post-workout dinner";
        session1.pantryEl.checked = true;
        session1.persistMealComposerState?.();

        // The draft must be written to persistent storage before any reload.
        expect(storage.store.size).toBeGreaterThan(0);

        // Session 2: simulated OS app kill / browser tab close / full-page reload
        // (brand-new JS heap, empty mealComposer, same localStorage).
        const session2 = createComposerInstance(storage, {
            pantryEnabled: true,
            defaultSlot: "breakfast",
        });
        session2.openMealComposer();

        expect(session2.mealComposer.items).toHaveLength(2);
        expect(session2.mealComposer.items[0]).toMatchObject({
            kind: "food",
            candidateId: "usda:171265",
            portionId: "cup",
            quantity: 2,
        });
        expect(session2.mealComposer.items[1]).toMatchObject({
            kind: "manual",
            name: "Sourdough toast",
            portionLabel: "1 slice",
            quantity: 1.5,
            nutrients: { calories: 120, protein_g: 4, carbs_g: 24, fat_g: 1 },
        });
        expect(session2.mealTypeEl.value).toBe("dinner");
        expect(session2.notesEl.value).toBe("Post-workout dinner");
        expect(session2.pantryEl.checked).toBe(true);
        // Running macro strip reflects restored items: 2*328 + 1.5*120 = 836 kcal.
        expect(session2.totalsEl.textContent).toContain("836 kcal");
    });

    test("reopening the composer in the same session does not discard in-progress contents", () => {
        const storage = createFakeStorage();
        const session = createComposerInstance(storage, {
            defaultSlot: "lunch",
        });
        session.openMealComposer();
        session.mealComposer.items.push({
            kind: "manual",
            name: "Greek yogurt",
            portionLabel: "1 bowl",
            quantity: 2,
            nutrients: { calories: 150, protein_g: 15 },
            sourceType: "user_supplied",
        });
        session.renderMealComposerItems();
        session.notesEl.value = "With berries";
        session.persistMealComposerState?.();

        // Close and reopen the composer dialog in the same session.
        session.dialog.close();
        session.openMealComposer();

        expect(session.mealComposer.items).toHaveLength(1);
        expect(session.mealComposer.items[0]).toMatchObject({
            name: "Greek yogurt",
            quantity: 2,
        });
        expect(session.notesEl.value).toBe("With berries");
    });

    test("successful meal submit clears the persisted composer draft", () => {
        const submitStart = appSource.indexOf('if (form.id === "meal-form")');
        expect(submitStart).toBeGreaterThan(-1);
        const submitBlock = appSource.slice(submitStart, submitStart + 900);
        expect(submitBlock).toContain("clearMealComposerDraft()");

        // Explicit logout also clears local drafts so another user never inherits them.
        const logoutStart = appSource.indexOf('if (action === "logout")');
        expect(logoutStart).toBeGreaterThan(-1);
        const logoutBlock = appSource.slice(logoutStart, logoutStart + 350);
        expect(logoutBlock).toContain("clearMealComposerDraft()");

        // Runtime check: clearing leaves the next open clean.
        const storage = createFakeStorage();
        const session = createComposerInstance(storage);
        session.openMealComposer();
        session.mealComposer.items.push({
            kind: "manual",
            name: "Oats",
            portionLabel: "1 cup",
            quantity: 1,
            nutrients: { calories: 300 },
            sourceType: "user_supplied",
        });
        session.renderMealComposerItems();
        session.persistMealComposerState?.();
        expect(storage.store.size).toBeGreaterThan(0);

        session.clearMealComposerDraft?.();
        const nextSession = createComposerInstance(storage);
        nextSession.openMealComposer();
        expect(nextSession.mealComposer.items).toHaveLength(0);
        expect(nextSession.notesEl.value).toBe("");
    });

    test("expired (>24h) and malformed stored drafts are ignored safely", () => {
        const storage = createFakeStorage();
        const session = createComposerInstance(storage);
        expect(session.readMealComposerDraft).not.toBeNull();

        // Malformed JSON
        storage.setItem("munch.meal-composer-draft", "{not valid json");
        expect(session.readMealComposerDraft!()).toBeNull();

        // Expired draft (25 hours old)
        const now = Date.now();
        storage.setItem(
            "munch.meal-composer-draft",
            JSON.stringify({
                version: 1,
                items: [
                    {
                        kind: "manual",
                        name: "Stale item",
                        quantity: 1,
                        nutrients: { calories: 100 },
                    },
                ],
                mealType: "lunch",
                notes: "old",
                savedAt: now - 25 * 60 * 60 * 1000,
            }),
        );
        expect(session.readMealComposerDraft!(now)).toBeNull();
        expect(storage.getItem("munch.meal-composer-draft")).toBeNull();
    });

    test("honest offline: offline meal submit fails honestly without queueing while keeping the persisted draft", async () => {
        const storage = createFakeStorage();
        const session = createComposerInstance(storage);
        session.openMealComposer();
        session.mealComposer.items.push({
            kind: "manual",
            name: "Chicken breast",
            portionLabel: "200g",
            quantity: 1,
            nutrients: { calories: 330, protein_g: 62 },
            sourceType: "user_supplied",
        });
        session.renderMealComposerItems();
        session.persistMealComposerState?.();

        setOnLine(false);
        let networkHit = false;
        globalThis.fetch = (async () => {
            networkHit = true;
            return Response.json({ ok: true });
        }) as typeof fetch;

        const error = await appApi
            .requestJson("/api/app/meals", {
                method: "POST",
                body: JSON.stringify({ items: session.mealComposerPayload() }),
            })
            .catch((caught) => caught);

        expect(appApi.isConnectivityError(error)).toBe(true);
        expect(error.message).toContain("Nothing was queued");
        expect(networkHit).toBe(false);
        expect(session.readMealComposerDraft?.()?.items).toHaveLength(1);
    });
});

describe("401 session expiry mid-task must not destroy composed state (Finding 5)", () => {
    test("web 401 during composer save preserves composed meal, defers redirect, and auto-restores after re-auth", async () => {
        setOnLine(true);
        const storage = createFakeStorage();
        let redirectCount = 0;

        appApi.setMunchPlatformAdapter({
            kind: "web",
            apiBaseUrl: null,
            async onAuthenticationRequired() {
                redirectCount += 1;
            },
        });

        const session1 = createComposerInstance(storage, {
            defaultSlot: "breakfast",
        });

        // Wire the real pre-auth hook (from app.js) into the real transport (app-api.js).
        const registerHook = (appApi as Record<string, unknown>)
            .setBeforeAuthenticationRequired as
            ((fn: () => unknown) => void) | undefined;
        if (registerHook && session1.handleBeforeAuthenticationRequired) {
            registerHook(session1.handleBeforeAuthenticationRequired);
        }

        session1.openMealComposer();
        session1.mealComposer.items.push({
            kind: "food",
            food: SAMPLE_FOOD,
            candidateId: SAMPLE_FOOD.candidate_id,
            portionId: "large-egg",
            quantity: 3,
        });
        session1.renderMealComposerItems();
        session1.mealTypeEl.value = "lunch";
        session1.mealComposer.mealTypeTouched = true;
        session1.notesEl.value = "Late lunch after meeting";

        globalThis.fetch = (async () =>
            Response.json(
                { error: "authentication_required" },
                { status: 401 },
            )) as typeof fetch;

        const error = await appApi
            .requestJson("/api/app/meals", {
                method: "POST",
                body: JSON.stringify({ items: session1.mealComposerPayload() }),
            })
            .catch((caught) => caught);

        // Must NOT redirect before the composer's failure protection runs.
        expect(redirectCount).toBe(0);
        expect(error).toBeInstanceOf(Error);
        expect(error.status).toBe(401);
        expect(error.authDeferred).toBe(true);

        // Composer remains open with everything intact and an in-place sign-in notice.
        expect(session1.dialogOpen).toBe(true);
        expect(session1.mealComposer.items).toHaveLength(1);
        const notice = session1.formEl.querySelector(
            '[data-testid="auth-expired-notice"]',
        );
        expect(notice).not.toBeNull();
        expect(notice!.innerHTML).toContain('data-action="reauth-continue"');

        // Draft is durably persisted with reopenAfterAuth = true.
        const saved = session1.readMealComposerDraft?.();
        expect(saved).not.toBeNull();
        expect(saved?.reopenAfterAuth).toBe(true);
        expect(saved?.mealType).toBe("lunch");
        expect(saved?.notes).toBe("Late lunch after meeting");

        // Clicking "Sign in to continue" invokes the platform redirect cleanly.
        const triggerAuth = (appApi as Record<string, unknown>)
            .triggerAuthenticationRequired as
            ((event?: { reason: string }) => Promise<void>) | undefined;
        expect(typeof triggerAuth).toBe("function");
        await triggerAuth!({ reason: "unauthorized" });
        expect(redirectCount).toBe(1);

        // After re-authentication (fresh JS heap, same localStorage), the
        // composer automatically reopens with the user's composed meal.
        const session2 = createComposerInstance(storage, {
            defaultSlot: "breakfast",
        });
        expect(typeof session2.maybeRestoreAfterAuth).toBe("function");
        await session2.maybeRestoreAfterAuth!();
        expect(session2.dialogOpen).toBe(true);
        expect(session2.mealComposer.items).toHaveLength(1);
        expect(session2.mealComposer.items[0]).toMatchObject({
            kind: "food",
            candidateId: "usda:171265",
            portionId: "large-egg",
            quantity: 3,
        });
        expect(session2.mealTypeEl.value).toBe("lunch");
        expect(session2.notesEl.value).toBe("Late lunch after meeting");
        // Auto-reopen flag is consumed so a subsequent refresh won't keep popping it up,
        // while the saved draft itself stays until logged or cleared.
        expect(session2.readMealComposerDraft?.()?.reopenAfterAuth).toBe(false);
    });

    test("mobile 401 during composer save does not wipe token and jump to login prematurely", async () => {
        setOnLine(true);
        const storage = createFakeStorage();
        let tokenWiped = false;
        let jumpedToLogin = false;

        appApi.setMunchPlatformAdapter({
            kind: "mobile",
            apiBaseUrl: "https://munch.business",
            async getAccessToken() {
                return tokenWiped ? null : "expired-mobile-bearer-token";
            },
            async onAuthenticationRequired() {
                tokenWiped = true;
                jumpedToLogin = true;
            },
        });

        const session = createComposerInstance(storage);
        const registerHook = (appApi as Record<string, unknown>)
            .setBeforeAuthenticationRequired as
            ((fn: () => unknown) => void) | undefined;
        if (registerHook && session.handleBeforeAuthenticationRequired) {
            registerHook(session.handleBeforeAuthenticationRequired);
        }

        session.openMealComposer();
        session.mealComposer.items.push({
            kind: "manual",
            name: "Protein shake",
            portionLabel: "1 bottle",
            quantity: 1,
            nutrients: { calories: 160, protein_g: 30 },
            sourceType: "user_supplied",
        });
        session.renderMealComposerItems();
        session.notesEl.value = "Gym bag";

        globalThis.fetch = (async () =>
            Response.json(
                { error: "authentication_required" },
                { status: 401 },
            )) as typeof fetch;

        const error = await appApi
            .requestJson("/api/app/meals", {
                method: "POST",
                body: JSON.stringify({ items: session.mealComposerPayload() }),
            })
            .catch((caught) => caught);

        expect(tokenWiped).toBe(false);
        expect(jumpedToLogin).toBe(false);
        expect(error.status).toBe(401);
        expect(error.authDeferred).toBe(true);
        expect(session.dialogOpen).toBe(true);
        expect(session.readMealComposerDraft?.()?.items).toHaveLength(1);
    });

    test("401 when no composer or draft review is open still triggers onAuthenticationRequired immediately", async () => {
        setOnLine(true);
        const storage = createFakeStorage();
        let authReason = "";

        appApi.setMunchPlatformAdapter({
            kind: "web",
            apiBaseUrl: null,
            async onAuthenticationRequired(event: { reason?: string }) {
                authReason = event.reason ?? "";
            },
        });

        const session = createComposerInstance(storage);
        const registerHook = (appApi as Record<string, unknown>)
            .setBeforeAuthenticationRequired as
            ((fn: () => unknown) => void) | undefined;
        if (registerHook && session.handleBeforeAuthenticationRequired) {
            registerHook(session.handleBeforeAuthenticationRequired);
        }

        globalThis.fetch = (async () =>
            Response.json(
                { error: "authentication_required" },
                { status: 401 },
            )) as typeof fetch;

        const error = await appApi
            .requestJson("/api/app/bootstrap")
            .catch((caught) => caught);

        expect(authReason).toBe("unauthorized");
        expect(error.status).toBe(401);
        expect(error.message).toBe("Authentication required");
        expect(error.authDeferred).toBeUndefined();
    });

    test("401 during meal-draft review stashes unsaved edits, defers redirect, and restores after re-auth", async () => {
        setOnLine(true);
        const storage = createFakeStorage();
        let redirectCount = 0;

        appApi.setMunchPlatformAdapter({
            kind: "web",
            apiBaseUrl: null,
            async onAuthenticationRequired() {
                redirectCount += 1;
            },
        });

        const session1 = createComposerInstance(storage);
        const registerHook = (appApi as Record<string, unknown>)
            .setBeforeAuthenticationRequired as
            ((fn: () => unknown) => void) | undefined;
        if (registerHook && session1.handleBeforeAuthenticationRequired) {
            registerHook(session1.handleBeforeAuthenticationRequired);
        }

        session1.setDraftReviewOpen(
            {
                id: "draft-42",
                version: 3,
                items: [{ id: "item-1", name: "Burrito", quantity: 1 }],
            },
            { quantity: "1.5", calories: "780" },
            "dinner",
            "added guacamole",
        );

        globalThis.fetch = (async () =>
            Response.json(
                { error: "authentication_required" },
                { status: 401 },
            )) as typeof fetch;

        const error = await appApi
            .requestJson("/api/app/meal-drafts/draft-42/confirm", {
                method: "POST",
                body: JSON.stringify({ expected_version: 3, confirmed: true }),
            })
            .catch((caught) => caught);

        expect(redirectCount).toBe(0);
        expect(error.status).toBe(401);
        expect(error.authDeferred).toBe(true);
        expect(
            session1.draftReviewEl.querySelector(
                '[data-testid="auth-expired-notice"]',
            ),
        ).not.toBeNull();

        const stashed = session1.readMealDraftReviewEdits?.("draft-42");
        expect(stashed).not.toBeNull();
        expect(stashed?.reopenAfterAuth).toBe(true);
        expect(stashed?.addText).toBe("added guacamole");

        // Post-reauth session automatically reopens draft-42.
        const session2 = createComposerInstance(storage);
        await session2.maybeRestoreAfterAuth?.();
        expect(session2.openedDraftIds).toEqual(["draft-42"]);
    });

    test("mobile runtime routes foreground session expiry through notifyAuthenticationRequired and stays free of localStorage", () => {
        expect(runtimeSource.includes("notifyAuthenticationRequired")).toBe(
            true,
        );
        expect(runtimeSource.includes("setBeforeAuthenticationRequired")).toBe(
            true,
        );
        expect(runtimeSource.includes("triggerAuthenticationRequired")).toBe(
            true,
        );
        // Preserves mobile-shell-smoke invariant: installed bearer credentials must not touch localStorage.
        expect(/localStorage/.test(runtimeSource)).toBe(false);
    });
});
