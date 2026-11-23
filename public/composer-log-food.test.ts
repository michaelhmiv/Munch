import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as cheerio from "cheerio";

// Composer changes (approved rendering, Michael 2026-11-20/21):
// 1. The "Log meal" family reads "Log food" — composer submit,
//    openRecipeLog, openPlannedLog, and photo review's two
//    "Confirm and log meal" buttons. editMeal's "Save meal" stays.
//    The MCP meal-review widget button joined the family by
//    Michael's follow-up ruling later on 2026-11-21.
// 2. The Selected foods list renders newest first (the items array
//    itself stays in add order — only the display flips, so sync,
//    payload order, and draft persistence are untouched).
// 3. Swipe-to-remove on a composer card mirrors the shipped draft
//    review gesture: left swipe >= 64px armed on the card head only,
//    landing on the shared inline confirmation ("Remove {food} from
//    this meal?"). The per-card Remove button stays a direct remove.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");

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

const appleFood = {
    candidate_id: "usda:apple",
    brand: null as string | null,
    name: "Apple, raw",
    provider: "usda",
    confidence: 0.95,
    portions: [
        {
            id: "medium",
            label: "1 medium",
            gram_weight: 182,
            nutrients: {
                calories: 95,
                protein_g: 0.5,
                carbs_g: 25.1,
                fat_g: 0.3,
            },
        },
    ],
};

const yogurtFood = {
    candidate_id: "off:yogurt",
    brand: "Fage",
    name: "Greek Yogurt, Plain Nonfat",
    provider: "off",
    confidence: 0.95,
    portions: [
        {
            id: "container",
            label: "1 container",
            gram_weight: 170,
            nutrients: {
                calories: 90,
                protein_g: 15,
                carbs_g: 5,
                fat_g: 0,
            },
        },
    ],
};

// ----------------------------------------------------------------
// Harness 1: the real renderMealComposerItems + add paths against a
// stub document, so the rendered HTML itself can be inspected.
// ----------------------------------------------------------------

interface RenderHarness {
    mealComposer: {
        items: Record<string, any>[];
        options: Map<string, Record<string, any>>;
    };
    selectMealOption: (key: string) => Promise<void>;
    addMealComposerItem: (item: Record<string, any>) => number;
    renderMealComposerItems: () => void;
    mealComposerPayload: () => Record<string, any>[];
    rootHtml: () => string;
    totalsText: () => string;
    focusLog: number[];
}

function buildRenderHarness(): RenderHarness {
    const rootEl = {
        innerHTML: "",
        querySelectorAll: () => [] as unknown[],
    };
    const totalsEl = { textContent: "" };
    const deltaEl = { textContent: "" };
    const focusLog: number[] = [];
    const foodsById: Record<string, unknown> = {
        "usda:apple": appleFood,
        "off:yogurt": yogurtFood,
    };
    const context: Record<string, unknown> = {
        document: {
            getElementById: (id: string) =>
                id === "meal-selected-items"
                    ? rootEl
                    : id === "meal-composer-totals"
                      ? totalsEl
                      : id === "meal-composer-delta"
                        ? deltaEl
                        : null,
            querySelector: (selector: string) => {
                const match = selector.match(/data-composer-index="(\d+)"/);
                if (!match) return null;
                const index = Number(match[1]);
                return {
                    scrollIntoView: () => {},
                    querySelector: () => ({
                        focus: () => {
                            focusLog.push(index);
                        },
                    }),
                };
            },
        },
        api: async (url: string) => {
            const parsed = new URL(url, "https://munch.test");
            const candidateId = parsed.searchParams.get("candidate_id") || "";
            return { food: foodsById[candidateId] ?? null };
        },
        state: {
            route: "home",
            todayRange: null,
            todayDayData: null,
            bootstrap: null,
            date: "2026-11-21",
        },
        sourceBadge: () => "",
        confidenceBadge: () => "",
        persistMealComposerState: () => {},
        syncMealComposerClearButton: () => {},
    };
    runInNewContext(
        [
            extractConst("mealComposer", "\n};"),
            extract("escapeHtml"),
            extract("number"),
            extract("foodTitle"),
            extract("foodPortion"),
            extract("portionOptionLabelJs"),
            extract("composerCustomPortionNutrients"),
            extract("foodMacroLine"),
            extract("syncMealComposerFromDom"),
            extract("mealComposerItemMacros"),
            extract("mealComposerTotals"),
            extract("mealComposerDayTotals"),
            extract("updateMealComposerStrip"),
            extract("renderMealComposerItems"),
            extract("focusMealComposerItem"),
            extract("normalizedComposerText"),
            extract("composerNutrientsEqual"),
            extract("findComposerDuplicate"),
            extract("mergeMealComposerItem"),
            extract("addMealComposerItem"),
            extractOptional("recentQuantity"),
            extract("selectMealOption"),
            extract("mealComposerPayload"),
            "this.__mealComposer = mealComposer;",
            "this.__selectMealOption = selectMealOption;",
            "this.__addMealComposerItem = addMealComposerItem;",
            "this.__renderMealComposerItems = renderMealComposerItems;",
            "this.__mealComposerPayload = mealComposerPayload;",
        ].join("\n"),
        context,
    );
    const mealComposer =
        context.__mealComposer as RenderHarness["mealComposer"];
    mealComposer.options = new Map();
    return {
        mealComposer,
        selectMealOption:
            context.__selectMealOption as RenderHarness["selectMealOption"],
        addMealComposerItem:
            context.__addMealComposerItem as RenderHarness["addMealComposerItem"],
        renderMealComposerItems:
            context.__renderMealComposerItems as RenderHarness["renderMealComposerItems"],
        mealComposerPayload:
            context.__mealComposerPayload as RenderHarness["mealComposerPayload"],
        rootHtml: () => rootEl.innerHTML,
        totalsText: () => totalsEl.textContent,
        focusLog,
    };
}

function renderedCards(html: string) {
    const $ = cheerio.load(`<div id="root">${html}</div>`);
    return $("#root article.meal-composer-item")
        .map((_, node) => {
            const $card = $(node);
            return {
                index: $card.attr("data-composer-index"),
                title: $card.find(".meal-composer-item-head strong").text(),
                removeIndex: $card
                    .find('[data-action="remove-meal-item"]')
                    .attr("data-index"),
                quantity: $card
                    .find('[data-composer-field="quantity"]')
                    .attr("value"),
            };
        })
        .get();
}

describe("composer newest-first list (approved rendering frame A/C)", () => {
    test("two added foods render newest first; indexes stay glued to their items", async () => {
        const harness = buildRenderHarness();
        harness.mealComposer.options.set("candidate:0", {
            kind: "candidate",
            candidateId: "usda:apple",
        });
        harness.mealComposer.options.set("candidate:1", {
            kind: "candidate",
            candidateId: "off:yogurt",
        });

        await harness.selectMealOption("candidate:0");
        await harness.selectMealOption("candidate:1");

        const cards = renderedCards(harness.rootHtml());
        expect(cards).toHaveLength(2);
        // Yogurt was added last: it is the first child, on top.
        expect(cards[0]!.title).toContain("Greek Yogurt");
        expect(cards[1]!.title).toContain("Apple, raw");
        // Display flips; addressing does not — each card keeps the
        // array index of its item (sync/focus/payload all key off it).
        expect(cards[0]!.index).toBe("1");
        expect(cards[1]!.index).toBe("0");
        expect(cards[0]!.removeIndex).toBe(cards[0]!.index);
        expect(cards[1]!.removeIndex).toBe(cards[1]!.index);
        // Totals strip is order-blind and still correct.
        expect(harness.totalsText()).toContain("185 kcal");
    });

    test("C4 focus after add lands on the new item, which sits at the top", async () => {
        const harness = buildRenderHarness();
        harness.mealComposer.options.set("candidate:0", {
            kind: "candidate",
            candidateId: "usda:apple",
        });
        harness.mealComposer.options.set("candidate:1", {
            kind: "candidate",
            candidateId: "off:yogurt",
        });

        await harness.selectMealOption("candidate:0");
        await harness.selectMealOption("candidate:1");

        expect(harness.focusLog).toEqual([0, 1]);
        const cards = renderedCards(harness.rootHtml());
        // The focused item (array index 1, just added) is the top card.
        expect(cards[0]!.index).toBe("1");
    });

    test("merge-on-add still merges under the new ordering (W1a)", async () => {
        const harness = buildRenderHarness();
        harness.mealComposer.options.set("candidate:0", {
            kind: "candidate",
            candidateId: "usda:apple",
        });
        harness.mealComposer.options.set("candidate:1", {
            kind: "candidate",
            candidateId: "off:yogurt",
        });

        await harness.selectMealOption("candidate:0");
        await harness.selectMealOption("candidate:1");
        await harness.selectMealOption("candidate:0");

        expect(harness.mealComposer.items).toHaveLength(2);
        expect(harness.mealComposer.items[0]!.quantity).toBe(2);
        const cards = renderedCards(harness.rootHtml());
        expect(cards[0]!.title).toContain("Greek Yogurt");
        expect(cards[1]!.title).toContain("Apple, raw");
        expect(cards[1]!.quantity).toBe("2");
        // The submitted payload keeps add order — only display flips.
        const payload = harness.mealComposerPayload();
        expect(payload.map((entry) => entry.candidate_id)).toEqual([
            "usda:apple",
            "off:yogurt",
        ]);
        expect(payload[0]!.quantity).toBe(2);
    });

    test("a manual food added last renders on top", () => {
        const harness = buildRenderHarness();
        harness.addMealComposerItem({
            kind: "food",
            food: appleFood,
            candidateId: appleFood.candidate_id,
            portionId: "medium",
            quantity: 1,
        });
        harness.addMealComposerItem({
            kind: "manual",
            name: "Honey",
            quantity: 1,
            portionLabel: "1 tbsp",
            nutrients: { calories: 64 },
            sourceType: "user_supplied",
        });
        harness.renderMealComposerItems();

        const cards = renderedCards(harness.rootHtml());
        expect(cards).toHaveLength(2);
        expect(cards[0]!.index).toBe("1");
        expect(cards[1]!.title).toContain("Apple, raw");
    });
});

describe('"Log meal" family renamed to "Log food"', () => {
    test("no Log meal / Confirm and log meal labels remain in app.js", () => {
        expect(source).not.toContain("Log meal");
        expect(source).not.toContain("Confirm and log meal");
    });

    test("the MCP meal-review widget button reads Log food", () => {
        const widget = readFileSync(
            new URL(
                "./widgets/src/templates/meal-review.html",
                import.meta.url,
            ),
            "utf8",
        );
        expect(widget).not.toContain("Log meal");
        expect(widget).toContain(">Log food</button>");
        expect(widget).toContain("Nothing is saved until you tap Log food.");
    });

    test("the three Log food submits and two Confirm and log food buttons exist", () => {
        expect(
            source.match(/data-log-submit>Log food<\/button>/g),
        ).toHaveLength(2);
        expect(source.match(/type="submit">Log food<\/button>/g)).toHaveLength(
            1,
        );
        expect(source.match(/Confirm and log food/g)).toHaveLength(2);
    });

    test("each renamed surface carries its new label", () => {
        const composer = source.slice(
            source.indexOf("function openMealComposer("),
            source.indexOf("function openMealDraftComposer("),
        );
        expect(composer).toContain('type="submit">Log food</button>');
        const planned = source.slice(
            source.indexOf("async function openPlannedLog("),
            source.indexOf("function planCardActions("),
        );
        expect(planned).toContain("data-log-submit>Log food</button>");
        const recipe = source.slice(
            source.indexOf("async function openRecipeLog("),
            source.indexOf("async function openRecipeLog(") + 8000,
        );
        expect(recipe).toContain("data-log-submit>Log food</button>");
    });

    test("editMeal keeps Save meal (not a log label)", () => {
        const edit = source.slice(
            source.indexOf("async function editMeal("),
            source.indexOf("async function editMeal(") + 4000,
        );
        expect(edit).toContain(">Save meal</button>");
    });
});

// ----------------------------------------------------------------
// Harness 2: the swipe gesture — real document listeners lifted from
// app.js, driven with fake touch events against a fake element tree,
// with the real showInlineConfirm / dismissInlineConfirm.
// ----------------------------------------------------------------

const swipePrelude = `
class HTMLElement {}
class FakeElement extends HTMLElement {
    constructor(tagName) {
        super();
        this.tagName = tagName;
        this.dataset = {};
        this.style = {};
        this.children = [];
        this.parent = null;
        this.className = "";
        this.textContent = "";
        this.attributes = {};
        this.focused = false;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    append(...kids) {
        for (const kid of kids) { kid.parent = this; this.children.push(kid); }
    }
    insertAdjacentElement(position, el) {
        if (position !== "afterend" || !this.parent) return;
        const siblings = this.parent.children;
        el.parent = this.parent;
        siblings.splice(siblings.indexOf(this) + 1, 0, el);
    }
    get previousElementSibling() {
        if (!this.parent) return null;
        const index = this.parent.children.indexOf(this);
        return index > 0 ? this.parent.children[index - 1] : null;
    }
    remove() {
        if (!this.parent) return;
        const siblings = this.parent.children;
        siblings.splice(siblings.indexOf(this), 1);
        this.parent = null;
    }
    closest(selector) {
        let node = this;
        while (node) {
            if (
                selector.startsWith(".") &&
                String(node.className).split(/\\s+/).includes(selector.slice(1))
            ) return node;
            node = node.parent;
        }
        return null;
    }
    focus() { this.focused = true; }
}
const __listeners = {};
const document = {
    createElement: (tag) => new FakeElement(tag),
    addEventListener: (type, fn) => {
        (__listeners[type] ||= []).push(fn);
    },
};
`;

interface SwipeHarness {
    mealComposer: { items: Record<string, any>[] };
    listeners: Record<string, Array<(event: any) => void>>;
    FakeElement: new (tag: string) => any;
    dismissInlineConfirm: (button: any) => void;
    requestRemoveMealItem: ((index: number, anchor: any) => void) | null;
}

function swipeListenerSlice(): string {
    const start = source.indexOf("let composerSwipeArm");
    const end = source.indexOf("async function handleAction");
    if (start < 0 || end <= start) return "";
    return source.slice(start, end);
}

function buildSwipeHarness(): SwipeHarness {
    const context: Record<string, unknown> = {};
    runInNewContext(
        [
            swipePrelude,
            extractConst("mealComposer", "\n};"),
            extract("foodTitle"),
            extract("draftSwipeRemoves"),
            extract("buildInlineConfirmBox"),
            extract("showInlineConfirm"),
            extract("dismissInlineConfirm"),
            extractOptional("requestRemoveMealItem"),
            swipeListenerSlice(),
            "this.__mealComposer = mealComposer;",
            "this.__listeners = __listeners;",
            "this.__FakeElement = FakeElement;",
            "this.__dismissInlineConfirm = dismissInlineConfirm;",
            "this.__requestRemoveMealItem = typeof requestRemoveMealItem === 'function' ? requestRemoveMealItem : null;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );
    return {
        mealComposer: context.__mealComposer as SwipeHarness["mealComposer"],
        listeners: context.__listeners as SwipeHarness["listeners"],
        FakeElement: context.__FakeElement as SwipeHarness["FakeElement"],
        dismissInlineConfirm:
            context.__dismissInlineConfirm as SwipeHarness["dismissInlineConfirm"],
        requestRemoveMealItem:
            context.__requestRemoveMealItem as SwipeHarness["requestRemoveMealItem"],
    };
}

function fireTouch(
    harness: SwipeHarness,
    type: "touchstart" | "touchend",
    event: Record<string, unknown>,
) {
    for (const listener of harness.listeners[type] ?? []) listener(event);
}

function headTargetFor(card: any) {
    const head = {
        closest: (selector: string) =>
            selector === "[data-composer-index]" ? card : null,
    };
    return {
        closest: (selector: string) =>
            selector === ".meal-composer-item-head" ? head : null,
    };
}

function buildSwipeScene(harness: SwipeHarness) {
    const FakeElement = harness.FakeElement;
    const list = new FakeElement("div");
    const cardA = new FakeElement("article");
    cardA.className = "meal-composer-item";
    cardA.dataset.composerIndex = "0";
    const cardB = new FakeElement("article");
    cardB.className = "meal-composer-item";
    cardB.dataset.composerIndex = "1";
    list.append(cardA, cardB);
    harness.mealComposer.items = [
        {
            kind: "food",
            food: appleFood,
            candidateId: appleFood.candidate_id,
            portionId: "medium",
            quantity: 1,
        },
        {
            kind: "food",
            food: yogurtFood,
            candidateId: yogurtFood.candidate_id,
            portionId: "container",
            quantity: 1,
        },
    ];
    return { list, cardA, cardB };
}

function swipeOn(
    harness: SwipeHarness,
    target: unknown,
    startX: number,
    endX: number,
) {
    fireTouch(harness, "touchstart", {
        target,
        touches: [{ clientX: startX }],
    });
    fireTouch(harness, "touchend", {
        changedTouches: [{ clientX: endX }],
    });
}

describe("composer swipe-to-remove (mirrors the draft review gesture)", () => {
    test("a >=64px left swipe on the card head hides the card and shows the inline confirmation", () => {
        const harness = buildSwipeHarness();
        const { list, cardA, cardB } = buildSwipeScene(harness);

        swipeOn(harness, headTargetFor(cardB), 300, 200);

        expect(cardB.style.display).toBe("none");
        expect(cardB.dataset.confirmPending).toBe("true");
        expect(cardA.style.display).toBeUndefined();
        expect(list.children).toHaveLength(3);
        const box = list.children[2];
        expect(box.className).toBe("plan-inline-confirm");
        const [note, confirmButton, dismissButton] = box.children;
        expect(note.textContent).toBe(
            "Remove Fage — Greek Yogurt, Plain Nonfat from this meal?",
        );
        expect(note.className).toBe("plan-inline-note is-destructive");
        expect(confirmButton.dataset.action).toBe("confirm-remove-meal-item");
        expect(confirmButton.dataset.index).toBe("1");
        expect(confirmButton.textContent).toBe("Yes, remove item");
        expect(confirmButton.className).toContain("plan-inline-confirm-danger");
        expect(dismissButton.dataset.action).toBe(
            "dismiss-plan-inline-confirm",
        );
        expect(dismissButton.textContent).toBe("Keep item");
        // Nothing is removed yet — the swipe only asks.
        expect(harness.mealComposer.items).toHaveLength(2);
    });

    test("Keep item restores the card with its place in the list", () => {
        const harness = buildSwipeHarness();
        const { list, cardB } = buildSwipeScene(harness);

        swipeOn(harness, headTargetFor(cardB), 300, 200);
        const box = list.children[2];
        const dismissButton = box.children[2];
        harness.dismissInlineConfirm(dismissButton);

        expect(cardB.style.display).toBe("");
        expect(cardB.dataset.confirmPending).toBeUndefined();
        expect(list.children).toHaveLength(2);
        expect(list.children[1]).toBe(cardB);
        expect(harness.mealComposer.items).toHaveLength(2);
    });

    test("a sub-threshold or rightward swipe does nothing", () => {
        const harness = buildSwipeHarness();
        const { list, cardB } = buildSwipeScene(harness);

        swipeOn(harness, headTargetFor(cardB), 300, 250);
        expect(cardB.style.display).toBeUndefined();
        expect(list.children).toHaveLength(2);

        swipeOn(harness, headTargetFor(cardB), 200, 320);
        expect(cardB.style.display).toBeUndefined();
        expect(list.children).toHaveLength(2);
    });

    test("exactly 64px is enough (the shipped threshold)", () => {
        const harness = buildSwipeHarness();
        const { list, cardB } = buildSwipeScene(harness);

        swipeOn(harness, headTargetFor(cardB), 300, 236);
        expect(cardB.style.display).toBe("none");
        expect(list.children).toHaveLength(3);
    });

    test("a swipe starting inside the Portion/Quantity fields never arms", () => {
        const harness = buildSwipeHarness();
        const { list, cardB } = buildSwipeScene(harness);
        const fieldTarget = { closest: () => null };

        swipeOn(harness, fieldTarget, 300, 150);
        expect(cardB.style.display).toBeUndefined();
        expect(list.children).toHaveLength(2);
    });

    test("the confirm action removes the item and re-renders (handler wiring)", () => {
        const start = source.indexOf(
            'if (action === "confirm-remove-meal-item")',
        );
        expect(start).toBeGreaterThan(-1);
        const handler = source.slice(
            start,
            source.indexOf("if (action ===", start + 10),
        );
        expect(handler).toContain(
            "mealComposer.items.splice(Number(button.dataset.index), 1)",
        );
        expect(handler).toContain("renderMealComposerItems()");
        // The per-card Remove button keeps its existing direct-remove
        // behavior — it does NOT route through the confirmation.
        const removeStart = source.indexOf(
            'if (action === "remove-meal-item")',
        );
        const removeHandler = source.slice(
            removeStart,
            source.indexOf("if (action ===", removeStart + 10),
        );
        expect(removeHandler).toContain("mealComposer.items.splice(");
        expect(removeHandler).not.toContain("requestRemoveMealItem(");
    });
});
