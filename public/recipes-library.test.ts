import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Cross-work slice 2 — Recipes library: divided View · Log · Plan
// card strip + real library sorting. The helpers under test are
// extracted from app.js and executed, following the pattern of
// cooks-navigation.test.ts; the card markup is rendered with stubbed
// view helpers so the assertions run on the real template.

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const cssSource = readFileSync(
    new URL("./app-overrides.css", import.meta.url),
    "utf8",
);

type RecipeFixture = {
    name: string;
    times_logged: number;
    last_logged_at: string | null;
    created_at: string;
};

const LIBRARY: RecipeFixture[] = [
    {
        name: "Turkey Chili",
        times_logged: 4,
        last_logged_at: "2026-11-08T12:00:00.000Z",
        created_at: "2026-10-01T00:00:00.000Z",
    },
    {
        name: "Lemon Herb Chicken & Rice",
        times_logged: 9,
        last_logged_at: "2026-11-02T12:00:00.000Z",
        created_at: "2026-09-01T00:00:00.000Z",
    },
    {
        name: "Overnight Oats",
        times_logged: 11,
        last_logged_at: null,
        created_at: "2026-11-01T00:00:00.000Z",
    },
    {
        name: "Sheet-Pan Salmon & Broccoli",
        times_logged: 5,
        last_logged_at: "2026-11-10T12:00:00.000Z",
        created_at: "2026-08-01T00:00:00.000Z",
    },
];

function loadSortHelpers(sessionStore = new Map<string, string>()) {
    const start = appSource.indexOf("const RECIPE_SORT_STORAGE_KEY");
    const end = appSource.indexOf("function recipeCardHtml");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const chunk = appSource.slice(start, end);
    const context = {
        sessionStorage: {
            getItem: (key: string) => sessionStore.get(key) ?? null,
            setItem: (key: string, value: string) =>
                sessionStore.set(key, value),
            removeItem: (key: string) => sessionStore.delete(key),
        },
    };
    return runInNewContext(
        `${chunk}; ({ sortRecipes, visibleRecipes, readRecipeSortPreference, writeRecipeSortPreference })`,
        context,
    ) as {
        sortRecipes: (
            recipes: RecipeFixture[],
            sort: string,
        ) => RecipeFixture[];
        visibleRecipes: (
            recipes: RecipeFixture[],
            query: string,
            sort: string,
        ) => RecipeFixture[];
        readRecipeSortPreference: () => string;
        writeRecipeSortPreference: (value: string) => void;
    };
}

const names = (recipes: RecipeFixture[]) => recipes.map((r) => r.name);

test("Most cooked sorts by times_logged descending", () => {
    const { sortRecipes } = loadSortHelpers();
    expect(names(sortRecipes(LIBRARY, "most-cooked"))).toEqual([
        "Overnight Oats",
        "Lemon Herb Chicken & Rice",
        "Sheet-Pan Salmon & Broccoli",
        "Turkey Chili",
    ]);
    // The input library is not mutated by sorting.
    expect(names(LIBRARY)[0]).toBe("Turkey Chili");
});

test("Recently made sorts by last_logged_at descending, never-made last", () => {
    const { sortRecipes } = loadSortHelpers();
    expect(names(sortRecipes(LIBRARY, "recently-made"))).toEqual([
        "Sheet-Pan Salmon & Broccoli",
        "Turkey Chili",
        "Lemon Herb Chicken & Rice",
        "Overnight Oats",
    ]);
});

test("Newest sorts by created_at descending; A–Z by title", () => {
    const { sortRecipes } = loadSortHelpers();
    expect(names(sortRecipes(LIBRARY, "newest"))).toEqual([
        "Overnight Oats",
        "Turkey Chili",
        "Lemon Herb Chicken & Rice",
        "Sheet-Pan Salmon & Broccoli",
    ]);
    expect(names(sortRecipes(LIBRARY, "a-z"))).toEqual([
        "Lemon Herb Chicken & Rice",
        "Overnight Oats",
        "Sheet-Pan Salmon & Broccoli",
        "Turkey Chili",
    ]);
});

test("search filters the sorted list (search + sort compose)", () => {
    const { visibleRecipes } = loadSortHelpers();
    // "e" matches all four titles, so the pair of orders below can
    // only differ if the sort is really applied after filtering.
    expect(names(visibleRecipes(LIBRARY, "e", "most-cooked"))).toEqual([
        "Overnight Oats",
        "Lemon Herb Chicken & Rice",
        "Sheet-Pan Salmon & Broccoli",
        "Turkey Chili",
    ]);
    expect(names(visibleRecipes(LIBRARY, "e", "a-z"))).toEqual([
        "Lemon Herb Chicken & Rice",
        "Overnight Oats",
        "Sheet-Pan Salmon & Broccoli",
        "Turkey Chili",
    ]);
    expect(names(visibleRecipes(LIBRARY, "zzz", "newest"))).toEqual([]);
    expect(names(visibleRecipes(LIBRARY, "", "most-cooked"))).toHaveLength(4);
});

test("sort preference defaults to Most cooked and round-trips the session", () => {
    const helpers = loadSortHelpers();
    expect(helpers.readRecipeSortPreference()).toBe("most-cooked");
    helpers.writeRecipeSortPreference("a-z");
    expect(helpers.readRecipeSortPreference()).toBe("a-z");
    const bogus = loadSortHelpers(new Map([["munch-recipe-sort", "bogus"]]));
    expect(bogus.readRecipeSortPreference()).toBe("most-cooked");
});

function loadCardRenderer(planOn: boolean) {
    const fn = appSource.match(
        /function recipeCardHtml\(recipe\) \{[\s\S]*?\n\}/,
    )![0];
    const context = {
        featureFlags: () => ({ plan: planOn, groceries: true }),
        escapeHtml: (value: unknown) => String(value ?? ""),
        number: (value: unknown, digits = 0) =>
            value == null ? "—" : Number(value).toFixed(digits),
        formatDate: (date: string) => `DATE(${date})`,
    };
    return runInNewContext(`${fn}; recipeCardHtml`, context) as (
        recipe: Record<string, unknown>,
    ) => string;
}

const CARD_RECIPE = {
    recipe_id: "fixture-salmon",
    revision_id: "fixture-salmon-r3",
    name: "Sheet-Pan Salmon & Broccoli",
    ownership: "personal",
    servings: 4,
    nutrition_status: "complete",
    nutrition_per_serving: {
        calories: 412,
        protein_g: 36,
        carbs_g: 9,
        fat_g: 25,
    },
    times_scheduled: 4,
    times_logged: 5,
    last_logged_at: "2026-11-10T12:00:00.000Z",
    created_at: "2026-08-01T00:00:00.000Z",
};

test("card exposes exactly View · Log · Plan and no grocery action", () => {
    const html = loadCardRenderer(true)(CARD_RECIPE);
    const strip = html.match(
        /<div class="auth-actions recipe-panel-actions">([\s\S]*?)<\/div>/,
    )![1];
    const actions = [...strip.matchAll(/data-action="([^"]+)"/g)].map(
        (m) => m[1],
    );
    expect(actions).toEqual(["view-recipe", "log-recipe", "plan-recipe"]);
    expect(strip).toContain(">View</button>");
    expect(strip).toContain(">Log</button>");
    expect(strip).toContain(">Plan</button>");
    // Segments are secondary in markup (design authority §4: the old
    // primary-class View button lied about the spec).
    expect(strip).not.toContain("button-primary");
    expect(html).not.toContain("recipe-groceries");
    expect(html).not.toContain("Add to grocery list");
    // The detail view keeps its own add-to-grocery action (app.js
    // still carries it outside the card renderer).
    expect(appSource).toContain('data-action="recipe-groceries"');
});

test("card meta keeps the cooked count and last-cooked date", () => {
    const html = loadCardRenderer(true)(CARD_RECIPE);
    expect(html).toContain("logged 5 times");
    expect(html).toContain("last cooked DATE(2026-11-10)");
    const neverCooked = loadCardRenderer(true)({
        ...CARD_RECIPE,
        times_logged: 0,
        last_logged_at: null,
    });
    expect(neverCooked).not.toContain("last cooked");
});

test("Plan segment hides with the Meal Plan flag off (T7 behavior kept)", () => {
    const html = loadCardRenderer(false)(CARD_RECIPE);
    expect(html).not.toContain('data-action="plan-recipe"');
    expect(html).toContain('data-action="view-recipe"');
    expect(html).toContain('data-action="log-recipe"');
});

test("filter row carries the Sort select with exactly the four orders", () => {
    const render = appSource.match(
        /async function renderRecipes\(\) \{[\s\S]*?\n\}/,
    )![0];
    expect(render).toContain('id="recipe-sort"');
    expect(render).toContain('id="recipe-filter"');
    for (const label of ["Most cooked", "Recently made", "Newest", "A–Z"]) {
        expect(appSource).toContain(`label: "${label}"`);
    }
});

test("strip CSS is the direction-C bar: transparent, rule border, hairline dividers", () => {
    const bar = cssSource.match(
        /\.recipes-view \.recipe-panel-actions \{([\s\S]*?)\}/,
    )![1];
    expect(bar).toContain("border: 1px solid #8a7c63");
    expect(bar).toContain("border-radius: 10px");
    expect(bar).toContain("background: transparent");
    expect(bar).toContain("gap: 0");
    const divider = cssSource.match(
        /\.recipes-view \.recipe-panel-actions \.button \+ \.button \{([\s\S]*?)\}/,
    )![1];
    expect(divider).toContain("border-left: 1px solid #d8cdb6");
    const segment = cssSource.match(
        /\.recipes-view \.recipe-panel-actions \.button \{([\s\S]*?)\}/,
    )![1];
    expect(segment).toContain("min-height: 31px");
    expect(segment).toContain("color: #2b2620");
});

// Regression (2026-11-13): after Calculate nutrition healed a stored
// recipe, the DETAIL showed the new revision's nutrition but the
// library CARD kept "unavailable nutrition" — the calculate flow
// re-rendered only the detail dialog, while the card renders from
// state.recipeLibrary, which nothing refreshed. The replay below is
// the production shape end to end: a pre-heal library entry exactly
// as GET /api/app/planning returned it (revision 1, unavailable,
// empty per-serving facts), the calculate endpoint's real response
// shape ({ result, recipe } with the healed revision 2), and then
// the real card template rendered from the synced entry.
function loadCalculateSync(apiResponse: unknown) {
    const start = appSource.indexOf("function syncRecipeLibraryEntry");
    const end = appSource.indexOf("function recipeHealSummary");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const chunk = appSource.slice(start, end);
    const library: Array<Record<string, unknown>> = [
        {
            recipe_id: "pot-pie",
            revision_id: "pot-pie-rev-1",
            name: "Chicken Pot Pie",
            version: 1,
            ownership: "personal",
            servings: 6,
            nutrition_status: "unavailable",
            nutrition_per_serving: {},
            times_scheduled: 0,
            times_logged: 3,
            last_logged_at: "2026-11-01T12:00:00.000Z",
            created_at: "2026-08-31T21:05:35.000Z",
            updated_at: "2026-08-31T21:05:35.000Z",
        },
        {
            recipe_id: "other-recipe",
            revision_id: "other-rev-1",
            name: "Overnight Oats",
            version: 1,
            ownership: "personal",
            servings: 1,
            nutrition_status: "complete",
            nutrition_per_serving: { calories: 320 },
            times_scheduled: 0,
            times_logged: 11,
            last_logged_at: null,
            created_at: "2026-11-01T00:00:00.000Z",
            updated_at: "2026-11-01T00:00:00.000Z",
        },
    ];
    let gridRefreshes = 0;
    const context = {
        state: { recipeLibrary: library },
        api: async () => apiResponse,
        refreshRecipeGrid: () => {
            gridRefreshes += 1;
        },
    };
    const calculateRecipeNutrition = runInNewContext(
        `${chunk}; calculateRecipeNutrition`,
        context,
    ) as (id: string) => Promise<Record<string, unknown>>;
    return {
        calculateRecipeNutrition,
        library,
        gridRefreshes: () => gridRefreshes,
    };
}

const HEALED_CALCULATE_RESPONSE = {
    result: {
        healed: true,
        revision_id: "pot-pie-rev-2",
        revision_number: 2,
        nutrition_status: "complete",
        nutrition_per_serving: {
            calories: 610.79,
            protein_g: 25.29,
            carbs_g: 55.21,
            fat_g: 32.14,
        },
        resolved_ingredients: ["Butter", "Onion"],
        unresolved_ingredients: [],
    },
    recipe: {
        id: "pot-pie",
        version: 2,
        revision_id: "pot-pie-rev-2",
        revision_number: 2,
        servings: 6,
        name: "Chicken Pot Pie",
        nutrition_status: "complete",
        nutrition_per_serving: {
            calories: 610.79,
            protein_g: 25.29,
            carbs_g: 55.21,
            fat_g: 32.14,
            fiber_g: 4.97,
            sugar_g: 3.25,
            sodium_mg: 790.72,
        },
        updated_at: "2026-11-13T13:51:50.000Z",
    },
};

test("calculate syncs the library entry so list and detail agree", async () => {
    const { calculateRecipeNutrition, library, gridRefreshes } =
        loadCalculateSync(HEALED_CALCULATE_RESPONSE);
    const result = await calculateRecipeNutrition("pot-pie");
    // The caller still gets the heal result it renders from.
    expect(result.nutrition_status).toBe("complete");
    const entry = library[0]!;
    expect(entry.nutrition_status).toBe("complete");
    expect(entry.revision_id).toBe("pot-pie-rev-2");
    expect(entry.version).toBe(2);
    expect((entry.nutrition_per_serving as { calories: number }).calories).toBe(
        610.79,
    );
    expect(entry.updated_at).toBe("2026-11-13T13:51:50.000Z");
    // List-only fields the detail payload doesn't carry survive.
    expect(entry.times_logged).toBe(3);
    expect(entry.last_logged_at).toBe("2026-11-01T12:00:00.000Z");
    expect(entry.created_at).toBe("2026-08-31T21:05:35.000Z");
    // The card grid repaints, and the other recipe is untouched.
    expect(gridRefreshes()).toBe(1);
    expect(library[1]!.nutrition_status).toBe("complete");
    expect(library[1]!.revision_id).toBe("other-rev-1");
    // The real card template now renders the healed state, with the
    // Log button pinned to the NEW revision — not the pre-heal one.
    const html = loadCardRenderer(true)(entry);
    expect(html).toContain("complete nutrition");
    expect(html).toContain("611 kcal");
    expect(html).toContain('data-revision="pot-pie-rev-2"');
    expect(html).not.toContain("unavailable nutrition");
});

test("calculate with no matching library entry is a no-op (other surfaces)", async () => {
    const { calculateRecipeNutrition, library, gridRefreshes } =
        loadCalculateSync(HEALED_CALCULATE_RESPONSE);
    // Calculate can run where the library was never loaded into this
    // shape (e.g. a lone entry) — the sync must not throw or repaint.
    library.splice(0, library.length);
    const result = await calculateRecipeNutrition("pot-pie");
    expect(result.healed).toBe(true);
    expect(gridRefreshes()).toBe(0);
});
