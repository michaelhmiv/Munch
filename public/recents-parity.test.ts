import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// W2 Finding 1 — Recents re-add parity: /api/app/food-search now
// serializes a recent with its logged quantity and PER-QUANTITY
// nutrients (the Usuals contract). Every web consumer must honor its
// own endpoint's scaling contract:
//  - meal composer: prefill quantity, per-quantity nutrients (the
//    composer multiplies for display; the server multiplies on save);
//  - draft review POST /items: stores LINE TOTALS, so the client
//    scales per-quantity nutrients back up by quantity;
//  - recipe composer: ingredients store LINE TOTALS plus a rescale
//    snapshot (selected_quantity + nutrition_snapshot);
//  - meal patch editor: replace (PATCH) scales server-side like the
//    composer (per-quantity), add (POST /items) stores line totals.
// Exercised on the real functions lifted out of public/app.js and
// public/app-patches.js, matching public/draft-add-item.test.ts.
const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const patchSource = readFileSync(
    new URL("./app-patches.js", import.meta.url),
    "utf8",
);

function extractFrom(source: string, name: string): string {
    const match = source.match(
        new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`function not found: ${name}`);
    return match[0];
}

function extractOptionalFrom(source: string, name: string): string {
    const match = source.match(
        new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    return match ? match[0] : "";
}

function extractConstFrom(
    source: string,
    name: string,
    terminator: string,
): string {
    const start = source.indexOf(`const ${name} =`);
    if (start < 0) throw new Error(`const not found: ${name}`);
    const end = source.indexOf(terminator, start);
    if (end < 0) throw new Error(`const terminator not found: ${name}`);
    return source.slice(start, end + terminator.length);
}

// The serialized shape after the Finding 1 server fix: logged at
// quantity 2 with stored totals 300 kcal / 20 P / 16 C / 8 F, so the
// wire carries quantity 2 and per-quantity 150 / 10 / 8 / 4.
const recent = {
    mealId: "m1",
    itemId: "i1",
    name: "Greek yogurt",
    quantity: 2,
    portionLabel: "1 cup",
    nutrients: { calories: 150, protein_g: 10, carbs_g: 8, fat_g: 4 },
    sourceType: "past_meal",
    provider: "usda",
    providerFoodId: "123",
    confidence: 0.95,
    loggedAt: "2026-11-10T12:00:00.000Z",
};

interface ComposerHarness {
    mealComposer: {
        items: Record<string, any>[];
        options: Map<string, Record<string, any>>;
    };
    resultsEl: { innerHTML: string };
    renderMealSearchResults: (data: Record<string, any>) => void;
    selectMealOption: (key: string) => Promise<void>;
    mealComposerTotals: () => { calories: number };
    mealComposerPayload: () => Record<string, any>[];
}

function buildComposer(): ComposerHarness {
    const resultsEl = { innerHTML: "" };
    const context: Record<string, unknown> = {
        document: {
            getElementById: (id: string) => {
                if (id === "meal-food-results") return resultsEl;
                if (id === "meal-selected-items") {
                    return { querySelectorAll: () => [] };
                }
                return null;
            },
        },
        api: async () => {
            throw new Error("unexpected api call");
        },
        renderMealComposerItems: () => {},
        focusMealComposerItem: () => {},
    };
    runInNewContext(
        [
            extractConstFrom(appSource, "mealComposer", "\n};"),
            "const sourceBadge = () => '';",
            extractFrom(appSource, "escapeHtml"),
            extractFrom(appSource, "number"),
            extractFrom(appSource, "portionsListLine"),
            extractFrom(appSource, "foodTitle"),
            extractFrom(appSource, "foodPortion"),
            extractFrom(appSource, "syncMealComposerFromDom"),
            extractFrom(appSource, "mealComposerItemMacros"),
            extractFrom(appSource, "mealComposerTotals"),
            extractOptionalFrom(appSource, "normalizedComposerText"),
            extractOptionalFrom(appSource, "composerNutrientsEqual"),
            extractOptionalFrom(appSource, "findComposerDuplicate"),
            extractOptionalFrom(appSource, "mergeMealComposerItem"),
            extractOptionalFrom(appSource, "addMealComposerItem"),
            extractOptionalFrom(appSource, "recentQuantity"),
            extractOptionalFrom(appSource, "scaleRecentNutrients"),
            extractOptionalFrom(appSource, "recentPortionSummary"),
            extractFrom(appSource, "renderMealSearchResults"),
            extractFrom(appSource, "selectMealOption"),
            extractFrom(appSource, "mealComposerPayload"),
            "this.__mealComposer = mealComposer;",
            "this.__renderMealSearchResults = renderMealSearchResults;",
            "this.__selectMealOption = selectMealOption;",
            "this.__mealComposerTotals = mealComposerTotals;",
            "this.__mealComposerPayload = mealComposerPayload;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );
    return {
        mealComposer: context.__mealComposer as ComposerHarness["mealComposer"],
        resultsEl,
        renderMealSearchResults:
            context.__renderMealSearchResults as ComposerHarness["renderMealSearchResults"],
        selectMealOption:
            context.__selectMealOption as ComposerHarness["selectMealOption"],
        mealComposerTotals:
            context.__mealComposerTotals as ComposerHarness["mealComposerTotals"],
        mealComposerPayload:
            context.__mealComposerPayload as ComposerHarness["mealComposerPayload"],
    };
}

interface DraftHarness {
    resultsEl: { innerHTML: string };
    apiCalls: { path: string; method: string; body: any }[];
    renderDraftFoodResults: (data: Record<string, any>) => void;
    selectDraftFoodOption: (key: string) => Promise<void>;
}

function buildDraftReview(): DraftHarness {
    const resultsEl = { innerHTML: "" };
    const apiCalls: DraftHarness["apiCalls"] = [];
    const prelude = `
var mealDraftReview = {
    draft: { id: "d1", version: 3, status: "open", expires_at: null },
    options: new Map(),
    pendingManual: [],
    searchTimer: null,
};
const sourceBadge = () => "";
const document = {
    getElementById: (id) =>
        id === "meal-draft-food-results" ? __resultsEl : null,
};
const api = async (path, options = {}) => {
    __apiCalls.push({
        path,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : undefined,
    });
    return { draft: mealDraftReview.draft };
};
const renderMealDraftReview = () => {};
const toast = () => {};
const searchDraftFoods = async () => {};
`;
    const context: Record<string, unknown> = {
        __resultsEl: resultsEl,
        __apiCalls: apiCalls,
    };
    runInNewContext(
        [
            prelude,
            extractFrom(appSource, "escapeHtml"),
            extractFrom(appSource, "number"),
            extractFrom(appSource, "foodPortion"),
            extractOptionalFrom(appSource, "recentQuantity"),
            extractOptionalFrom(appSource, "scaleRecentNutrients"),
            extractOptionalFrom(appSource, "recentPortionSummary"),
            extractFrom(appSource, "renderDraftFoodResults"),
            extractFrom(appSource, "selectDraftFoodOption"),
            "this.__renderDraftFoodResults = renderDraftFoodResults;",
            "this.__selectDraftFoodOption = selectDraftFoodOption;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );
    return {
        resultsEl,
        apiCalls,
        renderDraftFoodResults:
            context.__renderDraftFoodResults as DraftHarness["renderDraftFoodResults"],
        selectDraftFoodOption:
            context.__selectDraftFoodOption as DraftHarness["selectDraftFoodOption"],
    };
}

interface RecipeHarness {
    recipeIngredientFromRecent: (
        recent: Record<string, any>,
    ) => Record<string, any>;
    rescaleRecipeIngredientFromSnapshot: (
        ingredient: Record<string, any>,
        quantity: number,
        field?: unknown,
    ) => boolean;
}

function buildRecipe(): RecipeHarness {
    const context: Record<string, unknown> = {};
    runInNewContext(
        [
            extractConstFrom(appSource, "recipeNutrientFields", "];"),
            extractOptionalFrom(appSource, "recentQuantity"),
            extractOptionalFrom(appSource, "scaleRecentNutrients"),
            extractOptionalFrom(appSource, "recentPortionSummary"),
            extractFrom(appSource, "recipeIngredientFromRecent"),
            extractFrom(appSource, "rescaleRecipeIngredientFromSnapshot"),
            "this.__recipeIngredientFromRecent = recipeIngredientFromRecent;",
            "this.__rescale = rescaleRecipeIngredientFromSnapshot;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );
    return {
        recipeIngredientFromRecent:
            context.__recipeIngredientFromRecent as RecipeHarness["recipeIngredientFromRecent"],
        rescaleRecipeIngredientFromSnapshot:
            context.__rescale as RecipeHarness["rescaleRecipeIngredientFromSnapshot"],
    };
}

interface PatchHarness {
    patchMealEditor: { options: Map<string, Record<string, any>> };
    resultsEl: { innerHTML: string };
    renderPatchFoodResults: (data: Record<string, any>) => void;
    patchFoodBody: (
        option: Record<string, any>,
        replacing: boolean,
    ) => Record<string, any>;
}

function buildPatchEditor(): PatchHarness {
    const resultsEl = { innerHTML: "" };
    const context: Record<string, unknown> = {
        document: {
            getElementById: (id: string) =>
                id === "patch-food-results" ? resultsEl : null,
        },
    };
    runInNewContext(
        [
            extractConstFrom(patchSource, "patchMealEditor", "\n};"),
            extractFrom(patchSource, "patchEscape"),
            extractFrom(patchSource, "patchNumber"),
            extractOptionalFrom(patchSource, "patchRecentQuantity"),
            extractOptionalFrom(patchSource, "patchScaleNutrients"),
            extractOptionalFrom(patchSource, "patchRecentPortionSummary"),
            extractFrom(patchSource, "renderPatchFoodResults"),
            extractFrom(patchSource, "patchFoodBody"),
            "this.__patchMealEditor = patchMealEditor;",
            "this.__renderPatchFoodResults = renderPatchFoodResults;",
            "this.__patchFoodBody = patchFoodBody;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );
    return {
        patchMealEditor:
            context.__patchMealEditor as PatchHarness["patchMealEditor"],
        resultsEl,
        renderPatchFoodResults:
            context.__renderPatchFoodResults as PatchHarness["renderPatchFoodResults"],
        patchFoodBody: context.__patchFoodBody as PatchHarness["patchFoodBody"],
    };
}

describe("recents re-add parity (W2 Finding 1)", () => {
    test("meal composer selectMealOption prefills recent.quantity and computes running totals without doubling", async () => {
        const harness = buildComposer();
        harness.renderMealSearchResults({
            candidates: [],
            savedFoods: [],
            recentMealItems: [recent],
            providerFailures: [],
        });
        // The row shows the logged quantity and the logged TOTAL.
        expect(harness.resultsEl.innerHTML).toContain("2 × 1 cup");
        expect(harness.resultsEl.innerHTML).toContain("300 kcal");

        await harness.selectMealOption("recent:0");
        const item = harness.mealComposer.items[0]!;
        expect(item.quantity).toBe(2);
        expect(item.nutrients.calories).toBe(150);
        // Strip macros multiply per-quantity by quantity: the original
        // logged total, not double.
        expect(harness.mealComposerTotals().calories).toBe(300);

        // Editing quantity down to 1 shows and saves the per-quantity
        // value (what the server will store via suppliedMealItem).
        item.quantity = 1;
        expect(harness.mealComposerTotals().calories).toBe(150);
        const payload = harness.mealComposerPayload();
        expect(payload).toHaveLength(1);
        expect(payload[0]!.quantity).toBe(1);
        expect(payload[0]!.nutrients).toEqual({
            calories: 150,
            protein_g: 10,
            carbs_g: 8,
            fat_g: 4,
        });
    });

    test("draft review, recipe composer, and meal patch editor preserve total calories for multi-quantity recents", async () => {
        // Draft review: POST /items stores line totals.
        const draft = buildDraftReview();
        draft.renderDraftFoodResults({
            candidates: [],
            savedFoods: [],
            recentMealItems: [recent],
        });
        expect(draft.resultsEl.innerHTML).toContain("300 kcal");
        await draft.selectDraftFoodOption("recent:0");
        const post = draft.apiCalls.find(
            (call) => call.method === "POST" && call.path.includes("/items"),
        );
        expect(post).toBeDefined();
        expect(post!.body.item.quantity).toBe(2);
        expect(post!.body.item.nutrients.calories).toBe(300);

        // Recipe composer: line totals + rescale snapshot.
        const recipe = buildRecipe();
        const ingredient = recipe.recipeIngredientFromRecent(recent);
        expect(ingredient.quantity).toBe(2);
        expect(ingredient.nutrients.calories).toBe(300);
        const rescaled = recipe.rescaleRecipeIngredientFromSnapshot(
            ingredient,
            1,
        );
        expect(rescaled).toBe(true);
        expect(ingredient.nutrients.calories).toBe(150);

        // Meal patch editor: replace scales server-side (per-quantity),
        // add stores line totals.
        const patch = buildPatchEditor();
        patch.renderPatchFoodResults({
            candidates: [],
            savedFoods: [],
            recentMealItems: [recent],
        });
        expect(patch.resultsEl.innerHTML).toContain("300 kcal");
        const option = patch.patchMealEditor.options.get("recent:0")!;
        const replacingBody = patch.patchFoodBody(option, true);
        expect(replacingBody.quantity).toBe(2);
        expect(replacingBody.nutrients).toEqual({
            calories: 150,
            protein_g: 10,
            carbs_g: 8,
            fat_g: 4,
        });
        expect(replacingBody.replace_item).toBe(true);
        const addBody = patch.patchFoodBody(option, false);
        expect(addBody.quantity).toBe(2);
        expect(addBody.nutrients.calories).toBe(300);
        expect(addBody.replace_item).toBeUndefined();
    });
});
