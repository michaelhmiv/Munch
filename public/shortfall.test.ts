import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Cross-work slice 5 (brief §3) — plan → pantry shortfall indicator.
// The dialog builder is extracted from app.js and executed with
// stubbed helpers, following public/pantry-drawdown.test.ts:
// assertions run on the real templates, not on copies of them.

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const routesSource = readFileSync(
    new URL("../src/app/routes.ts", import.meta.url),
    "utf8",
);

function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

const sampleItem = {
    name: "Sandwich bread",
    normalized_name: "sandwich bread",
    need_quantity: 5,
    need_unit: "loaf",
    have_quantity: 0,
    short_quantity: 5,
    pantry_state: "none",
    reasons: [{ recipe_name: "Work Lunch", planned_meal_id: "m1", times: 5 }],
    planned_meal_id: "m1",
};

// The real flag component the rundown rows render (defined earlier
// in app.js, beside the grocery rows) — prepended so assertions run
// on the shipped markup, not a stub.
function flagChunk() {
    const start = appSource.indexOf("const PANTRY_FLAG_CHECK_SVG");
    const end = appSource.indexOf("// Grocery rows render the same component");
    if (start < 0 || end < 0 || end <= start)
        throw new Error("pantry flag chunk not found in app.js");
    return appSource.slice(start, end);
}

function dialogChunk() {
    const start = appSource.indexOf("function shortfallQty");
    const end = appSource.indexOf("async function addShortfallItems");
    return `${flagChunk()}\n${appSource.slice(start, end)}`;
}

test("rundown dialog renders data rows with per-item and add-all actions", () => {
    let title = "";
    let body = "";
    let actions = "";
    const context: Record<string, unknown> = {
        escapeHtml,
        state: { shortfall: { enabled: true, items: [sampleItem] } },
        openDialog: (t: string, b: string, a: string) => {
            title = t;
            body = b;
            actions = a;
        },
    };
    runInNewContext(
        `${dialogChunk()}\nthis.__open = openShortfallDialog;`,
        context,
    );
    (context.__open as () => void)();
    expect(title).toBe("Short for this week");
    expect(body).toContain("Sandwich bread");
    expect(body).toContain("need ~5 loaf");
    expect(body).toContain("Work Lunch ×5");
    expect(body).toContain("Pantry: none");
    expect(body).toContain('data-action="shortfall-add"');
    expect(actions).toContain('data-action="shortfall-add-all"');
});

test("opening the rundown adds nothing — adds ride explicit taps only", () => {
    const calls: unknown[] = [];
    const context: Record<string, unknown> = {
        escapeHtml,
        state: { shortfall: { enabled: true, items: [sampleItem] } },
        openDialog: () => {},
        api: (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve({});
        },
    };
    runInNewContext(
        `${dialogChunk()}\nthis.__open = openShortfallDialog;`,
        context,
    );
    (context.__open as () => void)();
    expect(calls).toHaveLength(0);
    // The only grocery-write call in the slice lives behind the add
    // handlers: refresh + dialog code contain no groceries endpoint.
    const sliceStart = appSource.indexOf("function shortfallWeekRange");
    const sliceEnd = appSource.indexOf("async function renderGroceries");
    const slice = appSource.slice(sliceStart, sliceEnd);
    const addStart = slice.indexOf("async function addShortfallItems");
    expect(slice.slice(0, addStart)).not.toContain("/api/app/groceries/items");
    expect(slice.slice(addStart)).toContain("/api/app/groceries/items");
});

test("an added item re-renders as Added with no add-all left", () => {
    let body = "";
    let actions = "unset";
    const context: Record<string, unknown> = {
        escapeHtml,
        state: {
            shortfall: {
                enabled: true,
                items: [{ ...sampleItem, added: true }],
            },
        },
        openDialog: (_t: string, b: string, a: string) => {
            body = b;
            actions = a;
        },
    };
    runInNewContext(
        `${dialogChunk()}\nthis.__open = openShortfallDialog;`,
        context,
    );
    (context.__open as () => void)();
    expect(body).toContain("Added");
    expect(body).not.toContain('data-action="shortfall-add"');
    expect(actions).toBe("");
});

test("a module off means no fetch and no indicator state", async () => {
    const start = appSource.indexOf("async function refreshShortfall");
    const end = appSource.indexOf("function paintShortfallIndicator");
    const chunk = appSource.slice(start, end);
    const calls: unknown[] = [];
    const context: Record<string, unknown> = {
        state: { shortfall: { items: [sampleItem] } },
        featureFlags: () => ({ plan: true, groceries: true, pantry: false }),
        paintShortfallIndicator: () => {},
        shortfallWeekRange: () => ({ start: "2026-11-09", end: "2026-11-15" }),
        api: (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve({});
        },
    };
    runInNewContext(`${chunk}\nthis.__refresh = refreshShortfall;`, context);
    await (context.__refresh as () => Promise<void>)();
    expect(calls).toHaveLength(0);
    expect((context.state as { shortfall: unknown }).shortfall).toBeNull();
});

test("the indicator is a dot and a badge — never a banner", () => {
    expect(appSource).toContain("nav-shortfall-dot");
    expect(appSource).toContain('class="shortfall-badge"');
    expect(appSource).not.toContain("shortfall-banner");
    // The badge sits beside the Groceries title in the heading template.
    const heading = appSource.indexOf("<h2>Groceries");
    expect(heading).toBeGreaterThan(-1);
    expect(appSource.slice(heading, heading + 260)).toContain(
        'data-action="shortfall-open"',
    );
});

test("rows carry the presence flag beside the quantity line — separate channels", () => {
    let body = "";
    const shortItem = {
        ...sampleItem,
        name: "Milk",
        pantry_state: "short",
        have_quantity: 0.25,
        short_quantity: 0.25,
        need_unit: "cup",
        on_list: false,
        pantry_flag: {
            state: "have",
            pantry_item_id: "pantry-milk",
            pantry_name: "Milk",
        },
    };
    const context: Record<string, unknown> = {
        escapeHtml,
        state: { shortfall: { enabled: true, items: [shortItem] } },
        openDialog: (_t: string, b: string) => {
            body = b;
        },
    };
    runInNewContext(
        `${dialogChunk()}\nthis.__open = openShortfallDialog;`,
        context,
    );
    (context.__open as () => void)();
    // The row reports quantity; the flag reports presence.
    expect(body).toContain("Pantry: ~0.25 cup");
    expect(body).toContain("pantry-flag pantry-flag-have");
    expect(body).toContain("In your pantry");
    // A short row is still addable — presence never vetoes the tap.
    expect(body).toContain('data-action="shortfall-add"');
});

test("an on-list row shows the listed flag and no Add — and scopes add-all out", () => {
    let body = "";
    let actions = "unset";
    const listedItem = {
        ...sampleItem,
        on_list: true,
        pantry_flag: {
            state: "listed",
            pantry_item_id: null,
            pantry_name: null,
        },
    };
    const context: Record<string, unknown> = {
        escapeHtml,
        state: { shortfall: { enabled: true, items: [listedItem] } },
        openDialog: (_t: string, b: string, a: string) => {
            body = b;
            actions = a;
        },
    };
    runInNewContext(
        `${dialogChunk()}\nthis.__open = openShortfallDialog;`,
        context,
    );
    (context.__open as () => void)();
    expect(body).toContain("pantry-flag pantry-flag-listed");
    expect(body).toContain("On your list");
    expect(body).not.toContain('data-action="shortfall-add"');
    // Nothing left that needs adding → no Add all either.
    expect(actions).toBe("");
});

test("a none row flags Not in pantry and keeps its Add", () => {
    let body = "";
    const noneItem = {
        ...sampleItem,
        on_list: false,
        pantry_flag: {
            state: "none",
            pantry_item_id: null,
            pantry_name: null,
        },
    };
    const context: Record<string, unknown> = {
        escapeHtml,
        state: { shortfall: { enabled: true, items: [noneItem] } },
        openDialog: (_t: string, b: string) => {
            body = b;
        },
    };
    runInNewContext(
        `${dialogChunk()}\nthis.__open = openShortfallDialog;`,
        context,
    );
    (context.__open as () => void)();
    expect(body).toContain("pantry-flag pantry-flag-none");
    expect(body).toContain("Not in pantry");
    expect(body).toContain('data-action="shortfall-add"');
});

test("the shortfall endpoint is read-only (no grocery writes server-side)", () => {
    const start = routesSource.indexOf('"/api/app/planning/shortfall"');
    expect(start).toBeGreaterThan(-1);
    const handler = routesSource.slice(start, start + 1200);
    expect(handler).toContain("getPlanShortfall");
    expect(handler).not.toContain("addGroceryItems");
    expect(handler).not.toContain("addRecipeToGroceryList");
});
