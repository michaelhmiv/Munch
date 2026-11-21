import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// W2 Finding 2 — Search race: every food-search surface guards its
// renders with a per-surface sequence token + AbortController and a
// current-input check, so a slow earlier query resolving last can
// never overwrite the current query's results (or error state).
// Exercised on the real functions lifted out of public/app.js and
// public/app-patches.js with controlled deferred promises, matching
// public/draft-add-item.test.ts.
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

interface Deferred {
    promise: Promise<Record<string, any>>;
    resolve: (value: Record<string, any>) => void;
    reject: (error: unknown) => void;
}

function deferred(): Deferred {
    let resolve!: (value: Record<string, any>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Record<string, any>>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

interface SearchCall {
    path: string;
    signal: AbortSignal | undefined;
    deferred: Deferred;
}

function candidateData(candidateId: string, name: string) {
    return {
        candidates: [
            {
                candidate_id: candidateId,
                brand: null,
                name,
                provider: "usda",
                portions: [{ label: "1 cup" }],
                default_portion: { label: "1 cup", calories: 100 },
            },
        ],
        savedFoods: [],
        recentMealItems: [],
        providerFailures: [],
    };
}

const soupData = candidateData("soup", "Chicken soup");
const chickenData = candidateData("chicken", "Plain chicken breast");

interface FakeElement {
    innerHTML: string;
    value: string;
}

interface AppSearchHarness {
    calls: SearchCall[];
    el: (id: string) => FakeElement;
    setInput: (id: string, value: string) => void;
    options: (surface: string) => Map<string, Record<string, any>>;
    searchMealFoods: (query: string) => Promise<void>;
    searchDraftFoods: (query: string) => Promise<void>;
    searchRecipeFoods: (query: string) => Promise<void>;
    searchSavedFoodCandidates: () => Promise<void>;
}

function buildAppSearch(): AppSearchHarness {
    const elements = new Map<string, FakeElement>();
    const el = (id: string): FakeElement => {
        let element = elements.get(id);
        if (!element) {
            element = { innerHTML: "", value: "" };
            elements.set(id, element);
        }
        return element;
    };
    const calls: SearchCall[] = [];
    const prelude = `
const sourceBadge = () => "";
const document = {
    getElementById: (id) => __el(id),
};
const api = (path, options = {}) => {
    const d = __deferred();
    __calls.push({ path, signal: options.signal, deferred: d });
    return d.promise;
};
`;
    const context: Record<string, unknown> = {
        __el: el,
        __calls: calls,
        __deferred: deferred,
        AbortController,
        DOMException,
    };
    runInNewContext(
        [
            prelude,
            extractConstFrom(appSource, "mealComposer", "\n};"),
            extractConstFrom(appSource, "mealDraftReview", "\n};"),
            extractConstFrom(appSource, "recipeComposer", "\n};"),
            extractConstFrom(appSource, "savedFoodManager", "\n};"),
            extractFrom(appSource, "escapeHtml"),
            extractFrom(appSource, "number"),
            extractFrom(appSource, "portionsListLine"),
            extractFrom(appSource, "foodPortion"),
            extractOptionalFrom(appSource, "beginSurfaceSearch"),
            extractOptionalFrom(appSource, "isCurrentSurfaceSearch"),
            extractFrom(appSource, "renderMealSearchResults"),
            extractFrom(appSource, "renderDraftFoodResults"),
            extractFrom(appSource, "renderRecipeSearchResults"),
            extractFrom(appSource, "renderSavedFoodSearchResults"),
            extractFrom(appSource, "searchMealFoods"),
            extractFrom(appSource, "searchDraftFoods"),
            extractFrom(appSource, "searchRecipeFoods"),
            extractFrom(appSource, "searchSavedFoodCandidates"),
            "this.__surfaces = { mealComposer, mealDraftReview, recipeComposer, savedFoodManager };",
            "this.__searchMealFoods = searchMealFoods;",
            "this.__searchDraftFoods = searchDraftFoods;",
            "this.__searchRecipeFoods = searchRecipeFoods;",
            "this.__searchSavedFoodCandidates = searchSavedFoodCandidates;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );
    const surfaces = context.__surfaces as Record<
        string,
        { options: Map<string, Record<string, any>> }
    >;
    return {
        calls,
        el,
        setInput: (id, value) => {
            el(id).value = value;
        },
        options: (surface) => surfaces[surface]!.options,
        searchMealFoods:
            context.__searchMealFoods as AppSearchHarness["searchMealFoods"],
        searchDraftFoods:
            context.__searchDraftFoods as AppSearchHarness["searchDraftFoods"],
        searchRecipeFoods:
            context.__searchRecipeFoods as AppSearchHarness["searchRecipeFoods"],
        searchSavedFoodCandidates:
            context.__searchSavedFoodCandidates as AppSearchHarness["searchSavedFoodCandidates"],
    };
}

interface PatchSearchHarness {
    calls: SearchCall[];
    el: (id: string) => FakeElement;
    setInput: (id: string, value: string) => void;
    options: Map<string, Record<string, any>>;
    searchPatchFoods: (query: string) => Promise<void>;
}

function buildPatchSearch(): PatchSearchHarness {
    const elements = new Map<string, FakeElement>();
    const el = (id: string): FakeElement => {
        let element = elements.get(id);
        if (!element) {
            element = { innerHTML: "", value: "" };
            elements.set(id, element);
        }
        return element;
    };
    const calls: SearchCall[] = [];
    const prelude = `
const document = {
    getElementById: (id) => __el(id),
};
const patchApi = (path, options = {}) => {
    const d = __deferred();
    __calls.push({ path, signal: options.signal, deferred: d });
    return d.promise;
};
`;
    const context: Record<string, unknown> = {
        __el: el,
        __calls: calls,
        __deferred: deferred,
        AbortController,
        DOMException,
    };
    runInNewContext(
        [
            prelude,
            extractConstFrom(patchSource, "patchMealEditor", "\n};"),
            extractFrom(patchSource, "patchEscape"),
            extractFrom(patchSource, "patchNumber"),
            extractFrom(patchSource, "renderPatchFoodResults"),
            extractFrom(patchSource, "searchPatchFoods"),
            "this.__patchMealEditor = patchMealEditor;",
            "this.__searchPatchFoods = searchPatchFoods;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );
    const editor = context.__patchMealEditor as {
        options: Map<string, Record<string, any>>;
    };
    return {
        calls,
        el,
        setInput: (id, value) => {
            el(id).value = value;
        },
        options: editor.options,
        searchPatchFoods:
            context.__searchPatchFoods as PatchSearchHarness["searchPatchFoods"],
    };
}

describe("search race — stale responses never overwrite current results (W2 Finding 2)", () => {
    test("searchMealFoods: slow earlier query resolving last never overwrites later query results", async () => {
        const harness = buildAppSearch();
        harness.setInput("meal-food-search", "chicken");
        const first = harness.searchMealFoods("chicken");
        harness.setInput("meal-food-search", "chicken soup");
        const second = harness.searchMealFoods("chicken soup");

        expect(harness.calls).toHaveLength(2);
        // The superseded request is aborted via its per-surface signal.
        expect(harness.calls[0]!.signal?.aborted).toBe(true);

        harness.calls[1]!.deferred.resolve(soupData);
        await second;
        expect(harness.el("meal-food-results").innerHTML).toContain(
            "Chicken soup",
        );

        harness.calls[0]!.deferred.resolve(chickenData);
        await first;
        const html = harness.el("meal-food-results").innerHTML;
        expect(html).toContain("Chicken soup");
        expect(html).not.toContain("Plain chicken breast");
        expect(
            harness.options("mealComposer").get("candidate:0")?.candidateId,
        ).toBe("soup");
    });

    test("searchDraftFoods: slow earlier query resolving last never overwrites later query results", async () => {
        const harness = buildAppSearch();
        harness.setInput("meal-draft-food-search", "chicken");
        const first = harness.searchDraftFoods("chicken");
        harness.setInput("meal-draft-food-search", "chicken soup");
        const second = harness.searchDraftFoods("chicken soup");

        expect(harness.calls).toHaveLength(2);
        expect(harness.calls[0]!.signal?.aborted).toBe(true);

        harness.calls[1]!.deferred.resolve(soupData);
        await second;
        expect(harness.el("meal-draft-food-results").innerHTML).toContain(
            "Chicken soup",
        );

        harness.calls[0]!.deferred.resolve(chickenData);
        await first;
        const html = harness.el("meal-draft-food-results").innerHTML;
        expect(html).toContain("Chicken soup");
        expect(html).not.toContain("Plain chicken breast");
        expect(
            harness.options("mealDraftReview").get("candidate:0")?.candidateId,
        ).toBe("soup");
    });

    test("searchRecipeFoods: slow earlier query resolving last never overwrites later query results", async () => {
        const harness = buildAppSearch();
        harness.setInput("recipe-food-search", "chicken");
        const first = harness.searchRecipeFoods("chicken");
        harness.setInput("recipe-food-search", "chicken soup");
        const second = harness.searchRecipeFoods("chicken soup");

        expect(harness.calls).toHaveLength(2);
        expect(harness.calls[0]!.signal?.aborted).toBe(true);

        harness.calls[1]!.deferred.resolve(soupData);
        await second;
        expect(harness.el("recipe-food-results").innerHTML).toContain(
            "Chicken soup",
        );

        harness.calls[0]!.deferred.resolve(chickenData);
        await first;
        const html = harness.el("recipe-food-results").innerHTML;
        expect(html).toContain("Chicken soup");
        expect(html).not.toContain("Plain chicken breast");
        expect(
            harness.options("recipeComposer").get("candidate:0")?.candidateId,
        ).toBe("soup");
    });

    test("searchSavedFoodCandidates: slow earlier query resolving last never overwrites later query results and abort does not throw", async () => {
        const harness = buildAppSearch();
        harness.setInput("saved-food-search", "chicken");
        const first = harness.searchSavedFoodCandidates();
        harness.setInput("saved-food-search", "chicken soup");
        const second = harness.searchSavedFoodCandidates();

        expect(harness.calls).toHaveLength(2);
        expect(harness.calls[0]!.signal?.aborted).toBe(true);

        harness.calls[1]!.deferred.resolve(soupData);
        await second;
        expect(harness.el("saved-food-search-results").innerHTML).toContain(
            "Chicken soup",
        );

        harness.calls[0]!.deferred.resolve(chickenData);
        await first;
        const html = harness.el("saved-food-search-results").innerHTML;
        expect(html).toContain("Chicken soup");
        expect(html).not.toContain("Plain chicken breast");
        expect(
            harness.options("savedFoodManager").get("candidate:0")?.candidateId,
        ).toBe("soup");

        // A superseded search rejected with AbortError must resolve
        // cleanly — the submit handler would otherwise toast it.
        harness.setInput("saved-food-search", "chicken");
        let abortError: unknown = null;
        const third = harness
            .searchSavedFoodCandidates()
            .catch((error: unknown) => {
                abortError = error;
            });
        harness.setInput("saved-food-search", "chicken soup");
        const fourth = harness.searchSavedFoodCandidates();
        harness.calls[2]!.deferred.reject(
            new DOMException("The operation was aborted", "AbortError"),
        );
        await third;
        expect(abortError).toBeNull();
        harness.calls[3]!.deferred.resolve(soupData);
        await fourth;
        expect(harness.el("saved-food-search-results").innerHTML).toContain(
            "Chicken soup",
        );
    });

    test("searchPatchFoods: slow earlier query resolving last never overwrites later query results", async () => {
        const harness = buildPatchSearch();
        harness.setInput("patch-food-search", "chicken");
        const first = harness.searchPatchFoods("chicken");
        harness.setInput("patch-food-search", "chicken soup");
        const second = harness.searchPatchFoods("chicken soup");

        expect(harness.calls).toHaveLength(2);
        expect(harness.calls[0]!.signal?.aborted).toBe(true);

        harness.calls[1]!.deferred.resolve(soupData);
        await second;
        expect(harness.el("patch-food-results").innerHTML).toContain(
            "Chicken soup",
        );

        harness.calls[0]!.deferred.resolve(chickenData);
        await first;
        const html = harness.el("patch-food-results").innerHTML;
        expect(html).toContain("Chicken soup");
        expect(html).not.toContain("Plain chicken breast");
        expect(harness.options.get("candidate:0")?.candidateId).toBe("soup");
    });

    test("stale query response arriving after input changed mid-debounce is dropped", async () => {
        const harness = buildAppSearch();
        harness.setInput("meal-food-search", "chicken");
        const first = harness.searchMealFoods("chicken");
        // The user keeps typing; the debounced second search has not
        // fired yet, so no abort/sequence bump has happened.
        harness.setInput("meal-food-search", "chicken soup");
        harness.calls[0]!.deferred.resolve(chickenData);
        await first;
        expect(harness.el("meal-food-results").innerHTML).not.toContain(
            "Plain chicken breast",
        );
    });

    test("late network error from superseded query never overwrites newer query results", async () => {
        const harness = buildAppSearch();
        harness.setInput("meal-food-search", "chicken");
        const first = harness.searchMealFoods("chicken");
        harness.setInput("meal-food-search", "chicken soup");
        const second = harness.searchMealFoods("chicken soup");

        harness.calls[1]!.deferred.resolve(soupData);
        await second;
        harness.calls[0]!.deferred.reject(new Error("504 timeout"));
        await first;
        const html = harness.el("meal-food-results").innerHTML;
        expect(html).toContain("Chicken soup");
        expect(html).not.toContain("504 timeout");
    });
});
