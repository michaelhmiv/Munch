import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Verified-food quantity rescale (owner-approved fix, 2026-11-13): a
// food picked into the recipe form seeds one portion's nutrients at
// quantity 1; changing the Quantity field must rescale the nutrients
// from the stored portion snapshot, or the recipe silently counts one
// portion (probe: 12 slices of cheddar saved at 116 kcal/serving
// instead of ~582). Manual ingredients have no snapshot — their typed
// nutrients are the line total and must never rescale. Exercised on
// the real composer path lifted out of app.js (pick → DOM rows →
// sync → payload) with only the document seam stubbed, the same
// harness shape as recipe-detail-d2.
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

const NUTRIENT_KEYS = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "sodium_mg",
];

interface FakeInput {
    value: string;
    checked: boolean;
}

interface FakeRow {
    dataset: { recipeIngredientIndex: string };
    querySelector: (selector: string) => FakeInput | null;
    inputs: Map<string, FakeInput>;
}

/** An input stub with the DOM's value coercion: assigning a number stores its string form. */
function fakeInput(value: string, checked = false): FakeInput {
    let stored = value;
    return {
        get value() {
            return stored;
        },
        set value(next: string) {
            stored = next == null ? "" : String(next);
        },
        checked,
    };
}

function fakeRow(
    index: number,
    fields: Record<string, string>,
    optionalChecked = false,
): FakeRow {
    const inputs = new Map<string, FakeInput>();
    for (const [name, value] of Object.entries(fields)) {
        inputs.set(name, fakeInput(value));
    }
    if (!inputs.has("optional")) {
        inputs.set("optional", fakeInput("", optionalChecked));
    }
    return {
        dataset: { recipeIngredientIndex: String(index) },
        inputs,
        querySelector(selector: string) {
            const match = selector.match(/data-recipe-field="([^"]+)"/);
            if (!match) return null;
            return inputs.get(match[1]!) ?? null;
        },
    };
}

/** Row fields exactly as renderRecipeIngredients would emit them. */
function rowFieldsFor(ingredient: Record<string, any>): Record<string, string> {
    const fields: Record<string, string> = {
        name: ingredient.name || "",
        quantity:
            ingredient.quantity == null ? "" : String(ingredient.quantity),
        unit: ingredient.unit || "",
        preparation: ingredient.preparation || "",
    };
    for (const key of NUTRIENT_KEYS) {
        const value = ingredient.nutrients?.[key];
        fields[key] = value == null ? "" : String(value);
    }
    return fields;
}

interface Composer {
    fromFood: (food: unknown, portionId?: string) => Record<string, any>;
    payload: (values: Record<string, string>) => {
        ingredients: Record<string, any>[];
    };
    composer: { ingredients: Record<string, any>[] };
    setRows: (rows: FakeRow[]) => void;
}

function buildComposer(): Composer {
    const holder: { rows: FakeRow[] } = { rows: [] };
    const context: Record<string, unknown> = {
        document: {
            getElementById: (id: string) =>
                id === "recipe-ingredients"
                    ? { querySelectorAll: () => holder.rows }
                    : null,
        },
    };
    runInNewContext(
        [
            extractConst("recipeNutrientFields", "\n];"),
            extractConst("recipeComposer", "\n};"),
            extract("foodTitle"),
            extract("foodPortion"),
            extract("recipeIngredientFromFood"),
            extract("rescaleRecipeIngredientFromSnapshot"),
            extract("syncRecipeComposerFromDom"),
            extract("recipeYieldFromValues"),
            extract("recipePayloadFromForm"),
            "this.__fromFood = recipeIngredientFromFood;",
            "this.__payload = recipePayloadFromForm;",
            "this.__composer = recipeComposer;",
        ].join("\n"),
        context,
    );
    return {
        fromFood: context.__fromFood as Composer["fromFood"],
        payload: context.__payload as Composer["payload"],
        composer: context.__composer as Composer["composer"],
        setRows: (rows) => {
            holder.rows = rows;
        },
    };
}

const formValues: Record<string, string> = {
    name: "Probe Bake",
    servings: "4",
    instructions: "Bake.",
    preparation_minutes: "",
    cooking_minutes: "",
    source_type: "",
    source_title: "",
    source_url: "",
};

const cheddar = {
    brand: "Test Farms",
    name: "Cheddar, sharp, sliced",
    provider: "usda",
    provider_food_id: "test-cheddar",
    candidate_id: "cand-cheddar",
    confidence: 1,
    portions: [
        {
            id: "slice",
            label: "1 slice (1 oz)",
            gram_weight: 28,
            nutrients: {
                calories: 115,
                protein_g: 6.8,
                carbs_g: 0.1,
                fat_g: 9.5,
                fiber_g: 0,
                sugar_g: 0.1,
                sodium_mg: 183,
            },
        },
    ],
};

describe("recipe verified-food quantity rescale", () => {
    test("pick at 1 portion, change quantity to 12: payload nutrients are 12x the portion", () => {
        const { fromFood, payload, composer, setRows } = buildComposer();
        const ingredient = fromFood(cheddar, "slice");
        expect(ingredient.quantity).toBe(1);
        expect(ingredient.nutrients.calories).toBe(115);
        composer.ingredients.push(ingredient);

        const row = fakeRow(0, rowFieldsFor(ingredient));
        row.inputs.get("quantity")!.value = "12";
        setRows([row]);

        const saved = payload(formValues).ingredients[0]!;
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
        // The snapshot tracks the quantity the nutrients now serve.
        expect(saved.source_snapshot.selected_quantity).toBe(12);
        // The visible fields update to the values that save.
        expect(row.inputs.get("calories")!.value).toBe("1380");
        expect(row.inputs.get("protein_g")!.value).toBe("81.6");
    });

    test("manual ingredient: typed nutrients are the line total and never rescale", () => {
        const { payload, composer, setRows } = buildComposer();
        composer.ingredients.push({
            name: "Homemade stock",
            quantity: 1,
            unit: "cup",
            preparation: "",
            optional: false,
            nutrients: { calories: 200 },
            sourceType: "user_supplied",
        });
        const row = fakeRow(0, {
            name: "Homemade stock",
            quantity: "3",
            unit: "cup",
            preparation: "",
            calories: "200",
            protein_g: "",
            carbs_g: "",
            fat_g: "",
            fiber_g: "",
            sugar_g: "",
            sodium_mg: "",
        });
        setRows([row]);

        const saved = payload(formValues).ingredients[0]!;
        expect(saved.quantity).toBe(3);
        expect(saved.nutrients).toEqual({ calories: 200 });
    });

    test("unchanged quantity keeps hand-edited nutrient values verbatim", () => {
        const { fromFood, payload, composer, setRows } = buildComposer();
        const ingredient = fromFood(cheddar, "slice");
        composer.ingredients.push(ingredient);

        const row = fakeRow(0, rowFieldsFor(ingredient));
        row.inputs.get("protein_g")!.value = "9.9";
        setRows([row]);

        const saved = payload(formValues).ingredients[0]!;
        expect(saved.quantity).toBe(1);
        expect(saved.nutrients.protein_g).toBe(9.9);
        expect(saved.nutrients.calories).toBe(115);
        expect(saved.source_snapshot.selected_quantity).toBe(1);
    });

    test("a second change rescales from the updated base, not the original portion", () => {
        const { fromFood, payload, composer, setRows } = buildComposer();
        const ingredient = fromFood(cheddar, "slice");
        composer.ingredients.push(ingredient);

        const first = fakeRow(0, rowFieldsFor(ingredient));
        first.inputs.get("quantity")!.value = "12";
        setRows([first]);
        payload(formValues);
        expect(ingredient.nutrients.calories).toBe(1380);

        const second = fakeRow(0, rowFieldsFor(ingredient));
        second.inputs.get("quantity")!.value = "6";
        setRows([second]);

        const saved = payload(formValues).ingredients[0]!;
        expect(saved.quantity).toBe(6);
        expect(saved.nutrients.calories).toBe(690);
        expect(saved.nutrients.protein_g).toBe(40.8);
        expect(saved.source_snapshot.selected_quantity).toBe(6);
    });

    test("cleared quantity leaves the typed nutrient values untouched", () => {
        const { fromFood, payload, composer, setRows } = buildComposer();
        const ingredient = fromFood(cheddar, "slice");
        composer.ingredients.push(ingredient);

        const row = fakeRow(0, rowFieldsFor(ingredient));
        row.inputs.get("quantity")!.value = "";
        setRows([row]);

        const saved = payload(formValues).ingredients[0]!;
        expect(saved.quantity).toBeUndefined();
        expect(saved.nutrients.calories).toBe(115);
        expect(saved.source_snapshot.selected_quantity).toBe(1);
    });
});
