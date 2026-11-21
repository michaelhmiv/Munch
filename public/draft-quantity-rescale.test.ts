import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// W2 logging math Finding 1: in the meal draft review, changing the
// quantity of an item WITHOUT a portion picker (manual foods, past-meal
// snapshots, model-estimate photo items) never rescaled its nutrients —
// drafts store TOTAL nutrients for the current quantity, so the save
// shipped the old totals at the new quantity. The fix rescales from
// the original item's totals in draftItemPayloadFromDom and live in
// the editor via applyDraftQuantityToEditor, without touching fields
// the user hand-edited and without disturbing the portion-picker path.
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

class FakeInput {
    dataset: Record<string, string> = {};
    #current: string;
    constructor(initial = "") {
        this.#current = initial;
    }
    get value(): string {
        return this.#current;
    }
    set value(next: unknown) {
        this.#current = next == null ? "" : String(next);
    }
    closest(): FakeRoot | null {
        return this.owner;
    }
    owner: FakeRoot | null = null;
}

class FakeRoot {
    dataset = { draftItemIndex: "0" };
    fields = new Map<string, FakeInput>();
    querySelector(selector: string): FakeInput | null {
        const match = selector.match(/data-draft-field="([^"]+)"/);
        if (!match) return null;
        return this.fields.get(match[1]!) ?? null;
    }
}

interface DraftHarness {
    setItem: (
        item: Record<string, any>,
        fields: Record<string, string>,
    ) => void;
    field: (name: string) => FakeInput;
    payload: () => Record<string, any>;
    applyQuantity: () => void;
    applyPortion: () => void;
}

function buildDraft(): DraftHarness {
    const root = new FakeRoot();
    const mealDraftReview: { draft: { items: Record<string, any>[] } | null } =
        { draft: null };
    const context: Record<string, unknown> = {
        document: {
            querySelector: (selector: string) =>
                selector.includes("data-draft-item-index") ? root : null,
        },
        mealDraftReview,
    };
    runInNewContext(
        [
            extractConst("draftNutrientFields", "];"),
            extract("draftNumber"),
            extractOptional("draftBaseQuantity"),
            extractOptional("scaleDraftValue"),
            extract("draftItemPayloadFromDom"),
            extract("applyDraftPortionToEditor"),
            extractOptional("applyDraftQuantityToEditor"),
            "this.__payload = draftItemPayloadFromDom;",
            "this.__applyPortion = applyDraftPortionToEditor;",
            "this.__applyQuantity = typeof applyDraftQuantityToEditor === 'function' ? applyDraftQuantityToEditor : undefined;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );
    const payload = context.__payload as (index: number) => Record<string, any>;
    const applyPortion = context.__applyPortion as (select: unknown) => void;
    const applyQuantity = context.__applyQuantity as
        ((input: unknown) => void) | undefined;
    return {
        setItem(item, fields) {
            mealDraftReview.draft = { items: [item] };
            root.fields.clear();
            for (const [name, value] of Object.entries(fields)) {
                const input = new FakeInput(value);
                input.owner = root;
                root.fields.set(name, input);
            }
        },
        field: (name) => {
            const input = root.fields.get(name);
            if (!input) throw new Error(`missing fake field ${name}`);
            return input;
        },
        payload: () => payload(0),
        applyQuantity: () => {
            if (!applyQuantity)
                throw new Error("applyDraftQuantityToEditor not found");
            applyQuantity(root.fields.get("quantity"));
        },
        applyPortion: () => applyPortion(root.fields.get("portion_id")),
    };
}

const portionlessItem = (overrides: Record<string, any> = {}) => ({
    name: "Manual stew",
    quantity: 1,
    gram_weight: 180,
    nutrients: { calories: 320, protein_g: 24, carbs_g: 30, fat_g: 10 },
    portions: [],
    source_type: "user_supplied",
    assumptions: [],
    ...overrides,
});

const portionlessFields = (overrides: Record<string, string> = {}) => ({
    name: "Manual stew",
    quantity: "1",
    portion_label: "",
    gram_weight: "180",
    calories: "320",
    protein_g: "24",
    carbs_g: "30",
    fat_g: "10",
    ...overrides,
});

describe("draft quantity rescale (W2 logging math Finding 1)", () => {
    test("portion-picker-less item saved at quantity 2 rescales nutrients and gram weight", () => {
        const harness = buildDraft();
        harness.setItem(
            portionlessItem(),
            portionlessFields({ quantity: "2" }),
        );
        const payload = harness.payload();
        expect(payload.quantity).toBe(2);
        expect(payload.nutrients).toEqual({
            calories: 640,
            protein_g: 48,
            carbs_g: 60,
            fat_g: 20,
        });
        expect(payload.gram_weight).toBe(360);
    });

    test("rescale uses the item's stored quantity as the base and treats a missing quantity as 1", () => {
        const harness = buildDraft();
        harness.setItem(
            portionlessItem({
                quantity: 1.5,
                gram_weight: 300,
                nutrients: { calories: 600 },
            }),
            portionlessFields({
                quantity: "3",
                gram_weight: "300",
                calories: "600",
                protein_g: "",
                carbs_g: "",
                fat_g: "",
            }),
        );
        const payload = harness.payload();
        expect(payload.nutrients.calories).toBe(1200);
        expect(payload.gram_weight).toBe(600);

        harness.setItem(
            portionlessItem({
                quantity: null,
                gram_weight: null,
                nutrients: { calories: 400 },
            }),
            portionlessFields({
                quantity: "2",
                gram_weight: "",
                calories: "400",
                protein_g: "",
                carbs_g: "",
                fat_g: "",
            }),
        );
        const nullBase = harness.payload();
        expect(nullBase.nutrients.calories).toBe(800);
        expect(nullBase.gram_weight).toBeUndefined();
    });

    test("live quantity changes update the editor from the original totals and the save does not double-scale", () => {
        const harness = buildDraft();
        harness.setItem(portionlessItem(), portionlessFields());

        harness.field("quantity").value = "2";
        harness.applyQuantity();
        expect(harness.field("calories").value).toBe("640");
        expect(harness.field("gram_weight").value).toBe("360");

        harness.field("quantity").value = "3";
        harness.applyQuantity();
        expect(harness.field("calories").value).toBe("960");
        expect(harness.field("gram_weight").value).toBe("540");

        const payload = harness.payload();
        expect(payload.nutrients.calories).toBe(960);
        expect(payload.gram_weight).toBe(540);
    });

    test("hand-edited nutrient fields are preserved while untouched fields rescale", () => {
        const harness = buildDraft();
        harness.setItem(
            portionlessItem(),
            portionlessFields({ quantity: "2" }),
        );
        const calories = harness.field("calories");
        calories.value = "500";
        calories.dataset.draftEdited = "1";

        harness.applyQuantity();
        expect(calories.value).toBe("500");
        expect(harness.field("protein_g").value).toBe("48");

        const payload = harness.payload();
        expect(payload.nutrients.calories).toBe(500);
        expect(payload.nutrients.protein_g).toBe(48);
        expect(payload.gram_weight).toBe(360);

        // Unchanged quantity: hand edits pass through verbatim.
        harness.setItem(
            portionlessItem(),
            portionlessFields({ quantity: "1" }),
        );
        const caloriesAgain = harness.field("calories");
        caloriesAgain.value = "500";
        caloriesAgain.dataset.draftEdited = "1";
        const unchanged = harness.payload();
        expect(unchanged.nutrients.calories).toBe(500);
        expect(unchanged.nutrients.protein_g).toBe(24);
    });

    test("portion-picker path is unchanged: chosen portion drives nutrients × quantity", () => {
        const harness = buildDraft();
        harness.setItem(
            portionlessItem({
                portions: [
                    {
                        id: "cup",
                        label: "1 cup",
                        gram_weight: 244,
                        nutrients: { calories: 149, protein_g: 7.7 },
                    },
                ],
                nutrients: { calories: 149, protein_g: 7.7 },
                gram_weight: 244,
                source_snapshot: {},
            }),
            portionlessFields({
                quantity: "2",
                portion_id: "cup",
                gram_weight: "244",
                calories: "149",
                protein_g: "7.7",
                carbs_g: "",
                fat_g: "",
            }),
        );
        const payload = harness.payload();
        expect(payload.nutrients).toEqual({ calories: 298, protein_g: 15.4 });
        expect(payload.gram_weight).toBe(488);
        expect(payload.source_snapshot.selected_portion_id).toBe("cup");
    });

    test('"Custom portion…" on a portion-picker item rescales from the original totals', () => {
        const harness = buildDraft();
        harness.setItem(
            portionlessItem({
                portions: [
                    {
                        id: "cup",
                        label: "1 cup",
                        gram_weight: 244,
                        nutrients: { calories: 149, protein_g: 7.7 },
                    },
                ],
                nutrients: { calories: 100 },
                gram_weight: 100,
                source_snapshot: {},
            }),
            portionlessFields({
                quantity: "2",
                portion_id: "__custom__",
                gram_weight: "100",
                calories: "100",
                protein_g: "",
                carbs_g: "",
                fat_g: "",
            }),
        );
        const payload = harness.payload();
        expect(payload.nutrients.calories).toBe(200);
        expect(payload.gram_weight).toBe(200);
    });
});
