import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Detail-editor quantity rescale (W2 recipes Finding 1): PR #325
// fixed silent undercounting in the CREATE composer — a quantity
// change on a food-picked ingredient rescales nutrients from the
// stored portion snapshot. The in-place DETAIL editor is a separate
// sync path that deliberately never rescaled: change "1 slice
// cheddar" to "12 slices" there and the new revision kept 1 slice's
// calories and gram weight, still labelled complete. Exercised on
// the real detail path lifted out of app.js (record → composer
// state → DOM rows → sync → payload) with only the document seam
// stubbed, the same harness shape as recipe-quantity-rescale.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extract(name: string): string {
    const match = source.match(
        new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`),
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

interface FakeInput {
    value: string;
}

interface FakeRow {
    dataset: { recipeDetailIngredientIndex: string };
    querySelector: (selector: string) => FakeInput | null;
    inputs: Map<string, FakeInput>;
}

function fakeRow(index: number, fields: Record<string, string>): FakeRow {
    const inputs = new Map<string, FakeInput>();
    for (const [name, value] of Object.entries(fields)) {
        inputs.set(name, { value });
    }
    return {
        dataset: { recipeDetailIngredientIndex: String(index) },
        inputs,
        querySelector(selector: string) {
            const match = selector.match(/data-detail-field="([^"]+)"/);
            if (!match) return null;
            return inputs.get(match[1]!) ?? null;
        },
    };
}

interface DetailEditor {
    fromRecord: (ingredient: Record<string, any>) => Record<string, any>;
    payload: (values: Record<string, string>) => {
        ingredients: Record<string, any>[];
    };
    composer: { ingredients: Record<string, any>[] };
    setRows: (rows: FakeRow[]) => void;
}

function buildEditor(): DetailEditor {
    const holder: { rows: FakeRow[] } = { rows: [] };
    const context: Record<string, unknown> = {
        document: {
            getElementById: (id: string) =>
                id === "recipe-detail-ingredients"
                    ? { querySelectorAll: () => holder.rows }
                    : null,
        },
    };
    runInNewContext(
        [
            extractConst("recipeNutrientFields", "\n];"),
            extractConst("recipeComposer", "\n};"),
            "let recipeDetailRecipe = { name: 'Probe Bake', source: {} };",
            "let recipeDetailSteps = [];",
            extract("recipeIngredientFromRecord"),
            extract("rescaleRecipeIngredientFromSnapshot"),
            extract("syncRecipeDetailEditFromDom"),
            extract("recipeDetailPayload"),
            "this.__fromRecord = recipeIngredientFromRecord;",
            "this.__payload = recipeDetailPayload;",
            "this.__composer = recipeComposer;",
        ].join("\n"),
        context,
    );
    return {
        fromRecord: context.__fromRecord as DetailEditor["fromRecord"],
        payload: context.__payload as DetailEditor["payload"],
        composer: context.__composer as DetailEditor["composer"],
        setRows: (rows) => {
            holder.rows = rows;
        },
    };
}

const oneSlice = {
    calories: 115,
    protein_g: 6.8,
    carbs_g: 0.1,
    fat_g: 9.5,
    fiber_g: 0,
    sugar_g: 0.1,
    sodium_mg: 183,
};

/** A saved picked-food ingredient record, as getRecipe returns it. */
const cheddarRecord = {
    name: "Cheddar, sharp, sliced",
    quantity: 1,
    unit: "1 slice (1 oz)",
    preparation: "",
    optional: false,
    gram_weight: 28,
    nutrients: { ...oneSlice },
    provider: "usda",
    provider_food_id: "test-cheddar",
    source_type: "usda",
    confidence: 1,
    source_snapshot: {
        resolution_layer: "food_search",
        candidate_id: "cand-cheddar",
        provider: "usda",
        provider_food_id: "test-cheddar",
        selected_portion_id: "slice",
        selected_portion_label: "1 slice (1 oz)",
        selected_quantity: 1,
        nutrition_snapshot: { ...oneSlice },
    },
};

function detailRowFor(
    ingredient: Record<string, any>,
    overrides: Record<string, string> = {},
): FakeRow {
    return fakeRow(0, {
        name: ingredient.name || "",
        quantity:
            ingredient.quantity == null ? "" : String(ingredient.quantity),
        unit: ingredient.unit || "",
        ...overrides,
    });
}

describe("recipe detail editor quantity rescale", () => {
    test("quantity 1 → 12 on a picked ingredient rescales nutrients and gram weight from the snapshot", () => {
        const { fromRecord, payload, composer, setRows } = buildEditor();
        composer.ingredients.push(fromRecord(structuredClone(cheddarRecord)));
        setRows([detailRowFor(cheddarRecord, { quantity: "12" })]);

        const saved = payload({ servings: "4" }).ingredients[0]!;
        expect(saved.quantity).toBe(12);
        expect(saved.nutrients).toEqual({
            calories: 1380,
            protein_g: 81.6,
            carbs_g: 1.2,
            fat_g: 114,
            fiber_g: 0,
            sugar_g: 1.2,
            sodium_mg: 2196,
        });
        expect(saved.gram_weight).toBe(336);
        // The snapshot tracks the quantity the nutrients now serve.
        expect(saved.source_snapshot.selected_quantity).toBe(12);
    });

    test("unchanged quantity keeps the stored nutrients and gram weight verbatim", () => {
        const { fromRecord, payload, composer, setRows } = buildEditor();
        composer.ingredients.push(fromRecord(structuredClone(cheddarRecord)));
        setRows([detailRowFor(cheddarRecord)]);

        const saved = payload({ servings: "4" }).ingredients[0]!;
        expect(saved.quantity).toBe(1);
        expect(saved.nutrients).toEqual({ ...oneSlice });
        expect(saved.gram_weight).toBe(28);
        expect(saved.source_snapshot.selected_quantity).toBe(1);
    });

    test("manual ingredient (no snapshot): quantity change leaves typed nutrients and gram weight untouched", () => {
        const { fromRecord, payload, composer, setRows } = buildEditor();
        const manual = {
            name: "Homemade stock",
            quantity: 1,
            unit: "cup",
            preparation: "",
            optional: false,
            gram_weight: 240,
            nutrients: { calories: 200 },
            source_type: "user_supplied",
        };
        composer.ingredients.push(fromRecord(manual));
        setRows([detailRowFor(manual, { quantity: "3" })]);

        const saved = payload({ servings: "4" }).ingredients[0]!;
        expect(saved.quantity).toBe(3);
        expect(saved.nutrients).toEqual({ calories: 200 });
        expect(saved.gram_weight).toBe(240);
    });
});
