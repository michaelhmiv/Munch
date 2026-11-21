import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// W2 logging math Findings 5 & 6: water, weight, meal-composer, and
// meal-duplicate submits minted a fresh idempotency key per attempt
// (or sent none), so a timeout/network retry — or a retry after the
// 401 session-expiry reload — inserted a duplicate even though the
// server deduplicates on (user_id, idempotency_key). After the fix
// each form owns ONE key for its lifetime: retries reuse it, success
// or an explicit fresh start rotates it.
//
// The submit/action branches are sliced verbatim out of public/app.js
// and wrapped, so the tests execute the production handler code.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const patchesSource = readFileSync(
    new URL("./app-patches.js", import.meta.url),
    "utf8",
);

function extract(name: string): string {
    const match = source.match(
        new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`app.js function not found: ${name}`);
    return match[0];
}

function extractOptional(name: string): string {
    const match = source.match(
        new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    return match ? match[0] : "";
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
    if (start < 0) throw new Error(`slice start not found: ${startMarker}`);
    const end = source.indexOf(endMarker, start + startMarker.length);
    if (end < 0) throw new Error(`slice end not found: ${endMarker}`);
    return source.slice(start, end);
}

function createFakeStorage() {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
            map.set(key, String(value));
        },
        removeItem: (key: string) => {
            map.delete(key);
        },
    };
}

interface ApiCall {
    url: string;
    body: Record<string, any> | null;
}

interface Harness {
    mealComposer: { items: any[]; idempotencyKey?: string | null };
    apiCalls: ApiCall[];
    toasts: string[];
    toastActions: string[];
    dialogHtml: string;
    waterForm: { dataset: Record<string, string> } | null;
    failNextApiCalls: (count: number) => void;
    submit: (form: any, values: Record<string, any>) => Promise<void>;
    action: (action: string, button: any) => Promise<void>;
    openMealComposer: () => void;
    openMealDuplicate: (id: string) => Promise<void>;
}

function createInstance(
    storage: ReturnType<typeof createFakeStorage>,
): Harness {
    const harness: Harness = {
        mealComposer: null as never,
        apiCalls: [],
        toasts: [],
        toastActions: [],
        dialogHtml: "",
        waterForm: null,
        failNextApiCalls: () => {},
        submit: null as never,
        action: null as never,
        openMealComposer: null as never,
        openMealDuplicate: null as never,
    };
    let failuresRemaining = 0;
    harness.failNextApiCalls = (count) => {
        failuresRemaining = count;
    };

    const mealTypeField = { value: "lunch" };
    const notesField = { value: "" };
    const pantryField = { checked: false };
    const fakeMealForm = {
        querySelector: (selector: string) => {
            if (selector.includes("meal_type")) return mealTypeField;
            if (selector.includes("notes")) return notesField;
            if (selector.includes("from_pantry")) return pantryField;
            return null;
        },
    };

    const context: Record<string, unknown> = {
        crypto: globalThis.crypto,
        localStorage: storage,
        document: {
            getElementById: (id: string) => {
                if (id === "meal-form") return fakeMealForm;
                if (id === "water-form") return harness.waterForm;
                return null;
            },
        },
        state: {
            date: "2026-11-20",
            bootstrap: {
                profile: { timezone: "UTC", preferred_weight_unit: "lb" },
            },
        },
        api: async (url: string, options?: { body?: string }) => {
            const body = options?.body
                ? (JSON.parse(options.body) as Record<string, any>)
                : null;
            harness.apiCalls.push({ url, body });
            if (failuresRemaining > 0) {
                failuresRemaining -= 1;
                throw new Error("simulated timeout");
            }
            if (url === "/api/app/meals/meal-1") {
                return {
                    meal: {
                        mealType: "lunch",
                        description: "Soup",
                        items: [{ name: "Soup" }],
                    },
                };
            }
            if (url === "/api/app/water") {
                return { entry: { id: "water-1" }, deduplicated: true };
            }
            if (url === "/api/app/weight") {
                return { entry: { id: "weight-1" }, deduplicated: true };
            }
            return { meal: { id: "meal-new" }, deduplicated: false };
        },
        toast: (message: string) => {
            harness.toasts.push(message);
        },
        toastAction: (message: string) => {
            harness.toastActions.push(message);
        },
        queueOutlierPrompt: () => {},
        queueDrawdownSummary: () => {},
        dialog: { open: false },
        closeAppDialog: () => {},
        renderRoute: async () => {},
        navigate: () => {},
        openDialog: (_title: string, html: string) => {
            harness.dialogHtml = html;
            if (html.includes('id="water-form"')) {
                harness.waterForm = { dataset: {} };
            }
        },
        addWaterDialogMarkup: () => '<form id="water-form"></form>',
        featureFlags: () => ({ pantry: false }),
        defaultMealType: () => "lunch",
        mealTypeOptionsHtml: () => "",
        renderMealComposerItems: () => {},
        searchMealFoods: () => {},
        loadMealUsuals: async () => {},
        savedWeightUnit: () => "lb",
        dateInTimezone: () => "2026-11-20",
        shiftDate: () => "2026-11-21",
        formatDate: (value: unknown) => String(value),
        number: (value: unknown, digits = 0) =>
            new Intl.NumberFormat("en-US", {
                maximumFractionDigits: digits,
            }).format(Number(value || 0)),
    };

    const submitSlices = [
        sliceBetween(
            'if (form.id === "meal-form") {',
            'if (form.id === "duplicate-meal-form") {',
        ),
        sliceBetween(
            'if (form.id === "duplicate-meal-form") {',
            'if (form.id === "meal-draft-create-form") {',
        ),
        sliceBetween(
            'if (form.id === "water-form") {',
            'if (form.id === "weight-form") {',
        ),
        sliceBetween(
            'if (form.id === "weight-form") {',
            'if (form.id === "edit-water-form") {',
        ),
    ].join("\n");
    const actionSlices = [
        sliceBetween(
            'if (action === "water-preset") {',
            'if (action === "add-water") {',
        ),
        sliceBetween(
            'if (action === "add-water") {',
            'if (action === "add-weight") {',
        ),
        sliceBetween(
            'if (action === "add-weight") {',
            'if (action === "billing-checkout") {',
        ),
        sliceBetween(
            'if (action === "clear-meal-composer") {',
            'if (action === "reauth-continue") {',
        ),
    ].join("\n");

    runInNewContext(
        [
            extractConst("mealComposer", "\n};"),
            extractConst("MEAL_COMPOSER_DRAFT_KEY", '";'),
            extractConst("MEAL_COMPOSER_DRAFT_TTL_MS", ";"),
            extractConst("VALID_MEAL_TYPES", ");"),
            extract("escapeHtml"),
            extractOptional("createIdempotencyKey"),
            extract("normalizeComposerDraftItem"),
            extract("hasMealComposerDraftContent"),
            extract("readMealComposerDraft"),
            extract("writeMealComposerDraft"),
            extract("clearMealComposerDraft"),
            extract("persistMealComposerState"),
            extract("syncMealComposerFromDom"),
            extract("foodTitle"),
            extract("foodPortion"),
            extractOptional("composerCustomPortionNutrients"),
            extractOptional("normalizedComposerText"),
            extractOptional("composerNutrientsEqual"),
            extractOptional("findComposerDuplicate"),
            extractOptional("mergeMealComposerItem"),
            extract("mealComposerPayload"),
            extract("composerMealDescription"),
            extract("waterFormAmountMl"),
            extract("openMealComposer"),
            extract("openMealDuplicate"),
            `this.__submit = async (form, values) => {\n${submitSlices}\n};`,
            `this.__action = async (action, button) => {\n${actionSlices}\n};`,
            "this.__mealComposer = mealComposer;",
            "this.__openMealComposer = openMealComposer;",
            "this.__openMealDuplicate = openMealDuplicate;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );

    harness.mealComposer = context.__mealComposer as Harness["mealComposer"];
    harness.submit = context.__submit as Harness["submit"];
    harness.action = context.__action as Harness["action"];
    harness.openMealComposer =
        context.__openMealComposer as Harness["openMealComposer"];
    harness.openMealDuplicate =
        context.__openMealDuplicate as Harness["openMealDuplicate"];
    return harness;
}

const mealFormValues = {
    meal_type: "lunch",
    logged_at: "2026-11-20T12:00:00.000Z",
    notes: "",
};

const mealForm = () => ({
    id: "meal-form",
    querySelector: () => null,
});

const manualItem = {
    kind: "manual",
    name: "Toast",
    quantity: 1,
    portionLabel: "1 slice",
    nutrients: { calories: 100 },
    sourceType: "user_supplied",
};

describe("composer submit idempotency (W2 logging math Finding 6)", () => {
    test("a retried meal submit sends the identical idempotency_key; success rotates it", async () => {
        const harness = createInstance(createFakeStorage());
        harness.openMealComposer();
        const form = mealForm();

        harness.failNextApiCalls(1);
        await expect(harness.submit(form, mealFormValues)).rejects.toThrow(
            "simulated timeout",
        );
        await harness.submit(form, mealFormValues);

        const posts = harness.apiCalls.filter(
            (call) => call.url === "/api/app/meals",
        );
        expect(posts).toHaveLength(2);
        const firstKey = posts[0]!.body?.idempotency_key;
        expect(typeof firstKey).toBe("string");
        expect(firstKey.length).toBeGreaterThan(0);
        expect(posts[1]!.body?.idempotency_key).toBe(firstKey);
        // Success cleared the session key; reopening mints a fresh one.
        expect(harness.mealComposer.idempotencyKey).toBeNull();
        harness.openMealComposer();
        const reopenedKey = harness.mealComposer.idempotencyKey;
        expect(typeof reopenedKey).toBe("string");
        expect(reopenedKey).not.toBe(firstKey);
    });

    test("the composer key survives a localStorage reload and Clear draft rotates it", async () => {
        const storage = createFakeStorage();
        const first = createInstance(storage);
        first.openMealComposer();
        first.mealComposer.items = [manualItem];
        const sessionKey = first.mealComposer.idempotencyKey;
        expect(typeof sessionKey).toBe("string");

        first.failNextApiCalls(1);
        await expect(first.submit(mealForm(), mealFormValues)).rejects.toThrow(
            "simulated timeout",
        );

        // Simulated reload / post-401 recovery: a brand-new instance
        // over the same storage restores the same key.
        const second = createInstance(storage);
        second.openMealComposer();
        expect(second.mealComposer.items).toHaveLength(1);
        expect(second.mealComposer.idempotencyKey).toBe(sessionKey);

        await second.action("clear-meal-composer", {});
        const rotated = second.mealComposer.idempotencyKey;
        expect(typeof rotated).toBe("string");
        expect(rotated).not.toBe(sessionKey);
    });
});

describe("duplicate submit idempotency (W2 logging math Finding 6)", () => {
    test("a retried duplicate submit reuses the dialog's key; reopening mints a new one", async () => {
        const harness = createInstance(createFakeStorage());
        await harness.openMealDuplicate("meal-1");
        const match = harness.dialogHtml.match(
            /data-idempotency-key="([^"]+)"/,
        );
        expect(match).not.toBeNull();
        const dialogKey = match![1]!;

        const form = {
            id: "duplicate-meal-form",
            dataset: { id: "meal-1", idempotencyKey: dialogKey },
        };
        const values = { target_date: "2026-11-21", meal_type: "lunch" };
        harness.failNextApiCalls(1);
        await expect(harness.submit(form, values)).rejects.toThrow(
            "simulated timeout",
        );
        await harness.submit(form, values);

        const copies = harness.apiCalls.filter((call) =>
            call.url.endsWith("/copy"),
        );
        expect(copies).toHaveLength(2);
        expect(copies[0]!.body?.idempotency_key).toBe(dialogKey);
        expect(copies[1]!.body?.idempotency_key).toBe(dialogKey);

        await harness.openMealDuplicate("meal-1");
        const reopened = harness.dialogHtml.match(
            /data-idempotency-key="([^"]+)"/,
        );
        expect(reopened).not.toBeNull();
        expect(reopened![1]).not.toBe(dialogKey);
    });
});

describe("water & weight idempotency (W2 logging math Finding 5)", () => {
    test("water form retry reuses the form key; reopening Add water mints a new key", async () => {
        const harness = createInstance(createFakeStorage());
        await harness.action("add-water", {});
        const form = harness.waterForm;
        expect(form).not.toBeNull();
        const formKey = form!.dataset.idempotencyKey;
        expect(typeof formKey).toBe("string");
        expect(formKey.length).toBeGreaterThan(0);

        const values = { amount: "12", unit: "fl oz", notes: "" };
        harness.failNextApiCalls(1);
        await expect(
            harness.submit(
                { id: "water-form", dataset: form!.dataset },
                values,
            ),
        ).rejects.toThrow("simulated timeout");
        await harness.submit(
            { id: "water-form", dataset: form!.dataset },
            values,
        );

        const posts = harness.apiCalls.filter(
            (call) => call.url === "/api/app/water",
        );
        expect(posts).toHaveLength(2);
        expect(posts[0]!.body?.idempotency_key).toBe(formKey);
        expect(posts[1]!.body?.idempotency_key).toBe(formKey);
        expect(harness.toasts).toContain("Water already added.");

        await harness.action("add-water", {});
        const reopenedKey = harness.waterForm!.dataset.idempotencyKey;
        expect(typeof reopenedKey).toBe("string");
        expect(reopenedKey).not.toBe(formKey);
    });

    test("water preset chip retry after a failed POST re-enables the chip and reuses its key", async () => {
        const harness = createInstance(createFakeStorage());
        const button = {
            dataset: { ml: "355", ozLabel: "12" } as Record<string, string>,
            disabled: false,
        };
        harness.failNextApiCalls(1);
        await expect(harness.action("water-preset", button)).rejects.toThrow(
            "simulated timeout",
        );
        expect(button.disabled).toBe(false);
        const chipKey = button.dataset.idempotencyKey;
        expect(typeof chipKey).toBe("string");

        await harness.action("water-preset", button);
        const posts = harness.apiCalls.filter(
            (call) => call.url === "/api/app/water",
        );
        expect(posts).toHaveLength(2);
        expect(posts[0]!.body?.idempotency_key).toBe(chipKey);
        expect(posts[1]!.body?.idempotency_key).toBe(chipKey);
        expect(posts[0]!.body?.amount_ml).toBe(355);
    });

    test("weight forms from both markups carry a key and the submit reuses it across retries", async () => {
        // Production markup (app-patches.js shadows the app.js fallback).
        expect(patchesSource).toContain('id="weight-form"');
        const patchFormTag = patchesSource.match(
            /<form id="weight-form"[^>]*>/,
        );
        expect(patchFormTag).not.toBeNull();
        expect(patchFormTag![0]).toContain("data-idempotency-key=");

        const harness = createInstance(createFakeStorage());
        await harness.action("add-weight", {});
        const match = harness.dialogHtml.match(
            /data-idempotency-key="([^"]+)"/,
        );
        expect(match).not.toBeNull();
        const formKey = match![1]!;

        const form = {
            id: "weight-form",
            dataset: { idempotencyKey: formKey },
        };
        const values = { weight: "180", unit: "lb", notes: "" };
        harness.failNextApiCalls(1);
        await expect(harness.submit(form, values)).rejects.toThrow(
            "simulated timeout",
        );
        await harness.submit(form, values);

        const posts = harness.apiCalls.filter(
            (call) => call.url === "/api/app/weight",
        );
        expect(posts).toHaveLength(2);
        expect(posts[0]!.body?.idempotency_key).toBe(formKey);
        expect(posts[1]!.body?.idempotency_key).toBe(formKey);
        expect(harness.toasts).toContain("Weight already added.");
    });
});
