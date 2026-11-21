import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// W1a Two-apples regression (Dani, 2026-11-20):
// Adding the same food twice in the meal composer must merge into one
// entry (incrementing quantity and doubling calories) instead of
// stacking duplicate rows across all composer add paths (search
// candidate, saved food, recent, usuals, same-as-yesterday, and
// manual where identity is well-defined). And client portion selection
// must avoid calorie-less / non-headline fallback portions when a
// calorie-bearing portion exists on the same food.
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

interface FakeInput {
    value: string;
}

interface FakeRow {
    dataset: { composerIndex: string };
    inputs: Map<string, FakeInput>;
    querySelector: (selector: string) => FakeInput | null;
}

function fakeRow(index: number, fields: Record<string, string>): FakeRow {
    const inputs = new Map<string, FakeInput>();
    for (const [name, value] of Object.entries(fields)) {
        inputs.set(name, { value });
    }
    return {
        dataset: { composerIndex: String(index) },
        inputs,
        querySelector(selector: string) {
            const match = selector.match(/data-composer-field="([^"]+)"/);
            if (!match) return null;
            return inputs.get(match[1]!) ?? null;
        },
    };
}

interface MealComposerHarness {
    mealComposer: {
        items: Record<string, any>[];
        options: Map<string, Record<string, any>>;
        usuals: Map<string, Record<string, any>>;
        yesterday: Record<string, any> | null;
    };
    foodPortion: (food: any, portionId?: string) => any;
    selectMealOption: (key: string) => Promise<void>;
    selectMealUsual: (key: string) => void;
    addYesterdayMeal: () => void;
    mealComposerTotals: () => {
        calories: number;
        protein_g: number;
        carbs_g: number;
        fat_g: number;
    };
    mealComposerPayload: () => Record<string, any>[];
    setRows: (rows: FakeRow[]) => void;
    focusedIndices: number[];
}

function buildComposer(
    detailsByCandidateId: Record<string, Record<string, any>> = {},
): MealComposerHarness {
    const holder: { rows: FakeRow[] } = { rows: [] };
    const focusedIndices: number[] = [];

    const context: Record<string, unknown> = {
        document: {
            getElementById: (id: string) =>
                id === "meal-selected-items"
                    ? { querySelectorAll: () => holder.rows }
                    : null,
        },
        api: async (url: string) => {
            const parsed = new URL(url, "https://munch.test");
            const candidateId = parsed.searchParams.get("candidate_id") || "";
            return { food: detailsByCandidateId[candidateId] ?? null };
        },
        renderMealComposerItems: () => {},
        focusMealComposerItem: (index: number) => {
            focusedIndices.push(index);
        },
    };

    runInNewContext(
        [
            extractConst("mealComposer", "\n};"),
            extract("foodTitle"),
            extract("foodPortion"),
            extractOptional("composerCustomPortionNutrients"),
            extract("syncMealComposerFromDom"),
            extract("mealComposerItemMacros"),
            extract("mealComposerTotals"),
            extractOptional("normalizedComposerText"),
            extractOptional("composerNutrientsEqual"),
            extractOptional("findComposerDuplicate"),
            extractOptional("mergeMealComposerItem"),
            extractOptional("addMealComposerItem"),
            extractOptional("recentQuantity"),
            extractOptional("scaleRecentNutrients"),
            extractOptional("recentPortionSummary"),
            extract("selectMealOption"),
            extract("usualComposerItem"),
            extract("selectMealUsual"),
            extract("addYesterdayMeal"),
            extract("mealComposerPayload"),
            "this.__mealComposer = mealComposer;",
            "this.__foodPortion = foodPortion;",
            "this.__selectMealOption = selectMealOption;",
            "this.__selectMealUsual = selectMealUsual;",
            "this.__addYesterdayMeal = addYesterdayMeal;",
            "this.__mealComposerTotals = mealComposerTotals;",
            "this.__mealComposerPayload = mealComposerPayload;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );

    return {
        mealComposer:
            context.__mealComposer as MealComposerHarness["mealComposer"],
        foodPortion:
            context.__foodPortion as MealComposerHarness["foodPortion"],
        selectMealOption:
            context.__selectMealOption as MealComposerHarness["selectMealOption"],
        selectMealUsual:
            context.__selectMealUsual as MealComposerHarness["selectMealUsual"],
        addYesterdayMeal:
            context.__addYesterdayMeal as MealComposerHarness["addYesterdayMeal"],
        mealComposerTotals:
            context.__mealComposerTotals as MealComposerHarness["mealComposerTotals"],
        mealComposerPayload:
            context.__mealComposerPayload as MealComposerHarness["mealComposerPayload"],
        setRows: (rows) => {
            holder.rows = rows;
        },
        focusedIndices,
    };
}

const appleFood = {
    candidate_id: "usda:171688",
    name: "Apples, raw, with skin",
    brand: null,
    provider: "usda",
    provider_food_id: "171688",
    confidence: 0.95,
    portions: [
        {
            id: "medium",
            label: "1 medium apple",
            gram_weight: 182,
            nutrients: {
                calories: 95,
                protein_g: 0.5,
                carbs_g: 25,
                fat_g: 0.3,
            },
        },
        {
            id: "100g",
            label: "100 g",
            gram_weight: 100,
            nutrients: {
                calories: 52,
                protein_g: 0.3,
                carbs_g: 13.8,
                fat_g: 0.2,
            },
        },
    ],
};

describe("meal composer merge-on-re-add (Dani two-apples regression)", () => {
    test("verified search candidate added twice merges into one entry with quantity 2 and full calories", async () => {
        const harness = buildComposer({ "usda:171688": appleFood });
        harness.mealComposer.options.set("candidate:0", {
            kind: "candidate",
            candidateId: "usda:171688",
        });

        await harness.selectMealOption("candidate:0");
        await harness.selectMealOption("candidate:0");

        expect(harness.mealComposer.items).toHaveLength(1);
        expect(harness.mealComposer.items[0]!.quantity).toBe(2);
        expect(harness.mealComposerTotals().calories).toBe(190);
        expect(harness.focusedIndices).toEqual([0, 0]);

        const payload = harness.mealComposerPayload();
        expect(payload).toHaveLength(1);
        expect(payload[0]).toEqual({
            candidate_id: "usda:171688",
            saved_food_id: undefined,
            portion_id: "medium",
            quantity: 2,
        });
    });

    test("saved food added twice merges into one entry with quantity 2 and full calories", async () => {
        const harness = buildComposer();
        harness.mealComposer.options.set("saved:0", {
            kind: "food",
            food: appleFood,
            savedFoodId: "saved-apple-1",
            defaultPortionId: "medium",
        });

        await harness.selectMealOption("saved:0");
        await harness.selectMealOption("saved:0");

        expect(harness.mealComposer.items).toHaveLength(1);
        expect(harness.mealComposer.items[0]!.quantity).toBe(2);
        expect(harness.mealComposerTotals().calories).toBe(190);
    });

    test("recent food added twice merges into one entry with quantity 2 and full calories", async () => {
        const harness = buildComposer();
        harness.mealComposer.options.set("recent:0", {
            kind: "recent",
            recent: {
                mealId: "meal-1",
                itemId: "item-1",
                name: "Apples, raw, with skin",
                portionLabel: "1 medium apple",
                nutrients: { calories: 95, carbs_g: 25 },
                provider: "usda",
                providerFoodId: "171688",
            },
        });

        await harness.selectMealOption("recent:0");
        await harness.selectMealOption("recent:0");

        expect(harness.mealComposer.items).toHaveLength(1);
        expect(harness.mealComposer.items[0]!.quantity).toBe(2);
        expect(harness.mealComposerTotals().calories).toBe(190);
    });

    test("usual added twice merges and adds its median quantity cleanly", () => {
        const harness = buildComposer();
        harness.mealComposer.usuals.set("usual:0", {
            key: "provider:usda:171688",
            name: "Apples, raw, with skin",
            quantity: 1.5,
            portionLabel: "1 medium apple",
            nutrients: { calories: 95, carbs_g: 25 },
            provider: "usda",
            providerFoodId: "171688",
        });

        harness.selectMealUsual("usual:0");
        harness.selectMealUsual("usual:0");

        expect(harness.mealComposer.items).toHaveLength(1);
        expect(harness.mealComposer.items[0]!.quantity).toBe(3);
        expect(harness.mealComposerTotals().calories).toBe(285);
    });

    test("same-as-yesterday added twice merges each item instead of duplicating rows", () => {
        const harness = buildComposer();
        harness.mealComposer.yesterday = {
            mealId: "meal-yesterday",
            items: [
                {
                    name: "Apples, raw, with skin",
                    quantity: 1,
                    portionLabel: "1 medium apple",
                    nutrients: { calories: 95, carbs_g: 25 },
                    provider: "usda",
                    providerFoodId: "171688",
                },
                {
                    name: "Greek yogurt",
                    quantity: 2,
                    portionLabel: "1 container",
                    nutrients: { calories: 150, protein_g: 17 },
                    provider: null,
                    providerFoodId: null,
                },
            ],
        };

        harness.addYesterdayMeal();
        harness.addYesterdayMeal();

        expect(harness.mealComposer.items).toHaveLength(2);
        expect(harness.mealComposer.items[0]!.quantity).toBe(2);
        expect(harness.mealComposer.items[1]!.quantity).toBe(4);
        expect(harness.mealComposerTotals().calories).toBe(790);
    });

    test("usual followed by same-as-yesterday merges the overlapping food", () => {
        const harness = buildComposer();
        harness.mealComposer.usuals.set("usual:0", {
            key: "provider:usda:171688",
            name: "Apples, raw, with skin",
            quantity: 1,
            portionLabel: "1 medium apple",
            nutrients: { calories: 95, carbs_g: 25 },
            provider: "usda",
            providerFoodId: "171688",
        });
        harness.mealComposer.yesterday = {
            mealId: "meal-yesterday",
            items: [
                {
                    name: "Apples, raw, with skin",
                    quantity: 1,
                    portionLabel: "1 medium apple",
                    nutrients: { calories: 95, carbs_g: 25 },
                    provider: "usda",
                    providerFoodId: "171688",
                },
                {
                    name: "Almonds",
                    quantity: 1,
                    portionLabel: "1 oz",
                    nutrients: { calories: 164 },
                    provider: null,
                    providerFoodId: null,
                },
            ],
        };

        harness.selectMealUsual("usual:0");
        harness.addYesterdayMeal();

        expect(harness.mealComposer.items).toHaveLength(2);
        expect(harness.mealComposer.items[0]!.name).toBe(
            "Apples, raw, with skin",
        );
        expect(harness.mealComposer.items[0]!.quantity).toBe(2);
        expect(harness.mealComposer.items[1]!.name).toBe("Almonds");
        expect(harness.mealComposerTotals().calories).toBe(354);
    });

    test("manual items with identical well-defined identity coalesce in payload, while blank or distinct rows stay separate", () => {
        const harness = buildComposer();
        harness.mealComposer.items.push(
            {
                kind: "manual",
                name: "Honeycrisp apple",
                quantity: 1,
                portionLabel: "1 medium",
                nutrients: { calories: 95, carbs_g: 25 },
                sourceType: "user_supplied",
            },
            {
                kind: "manual",
                name: "  honeycrisp  apple ",
                quantity: 1,
                portionLabel: "1 Medium",
                nutrients: { calories: 95, carbs_g: 25 },
                sourceType: "user_supplied",
            },
            {
                kind: "manual",
                name: "Honeycrisp apple",
                quantity: 1,
                portionLabel: "1 large",
                nutrients: { calories: 115, carbs_g: 30 },
                sourceType: "user_supplied",
            },
        );

        const payload = harness.mealComposerPayload();
        expect(payload).toHaveLength(2);
        expect(payload[0]!.name).toBe("Honeycrisp apple");
        expect(payload[0]!.quantity).toBe(2);
        expect(payload[1]!.portion_label).toBe("1 large");
        expect(payload[1]!.quantity).toBe(1);

        // Blank manual items have no well-defined identity and must stay separate.
        const blankHarness = buildComposer();
        blankHarness.mealComposer.items.push(
            {
                kind: "manual",
                name: "",
                quantity: 1,
                portionLabel: "",
                nutrients: {},
                sourceType: "user_supplied",
            },
            {
                kind: "manual",
                name: "",
                quantity: 1,
                portionLabel: "",
                nutrients: {},
                sourceType: "user_supplied",
            },
        );
        expect(blankHarness.mealComposerPayload()).toHaveLength(2);
    });

    test("different portion on existing row does not merge when default portion is re-added", async () => {
        const harness = buildComposer({ "usda:171688": appleFood });
        harness.mealComposer.options.set("candidate:0", {
            kind: "candidate",
            candidateId: "usda:171688",
        });

        await harness.selectMealOption("candidate:0");
        // User switches row 0 to 100 g in the DOM before re-adding.
        harness.setRows([fakeRow(0, { portion_id: "100g", quantity: "1" })]);

        await harness.selectMealOption("candidate:0");

        expect(harness.mealComposer.items).toHaveLength(2);
        expect(harness.mealComposer.items[0]!.portionId).toBe("100g");
        expect(harness.mealComposer.items[1]!.portionId).toBe("medium");
    });

    test("default portion selection skips a calorie-less leading portion in favor of a calorie-bearing portion", async () => {
        const appleWithBrokenFirstPortion = {
            ...appleFood,
            portions: [
                {
                    id: "no-cal",
                    label: "1 serving",
                    gram_weight: 182,
                    nutrients: {
                        calories: null,
                        protein_g: 0.5,
                        carbs_g: 25,
                        fat_g: 0.3,
                    },
                },
                ...appleFood.portions,
            ],
        };
        const harness = buildComposer({
            "usda:171688": appleWithBrokenFirstPortion,
        });
        harness.mealComposer.options.set("candidate:0", {
            kind: "candidate",
            candidateId: "usda:171688",
        });

        await harness.selectMealOption("candidate:0");
        await harness.selectMealOption("candidate:0");

        expect(harness.mealComposer.items).toHaveLength(1);
        expect(harness.mealComposer.items[0]!.portionId).toBe("medium");
        expect(harness.mealComposer.items[0]!.quantity).toBe(2);
        expect(harness.mealComposerTotals().calories).toBe(190);
    });
});
