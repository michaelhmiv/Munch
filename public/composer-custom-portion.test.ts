import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { getFoodSearchService } from "../src/food-providers/service.js";
import type { FoodCandidate } from "../src/food-providers/types.js";
import { resolveWebMealItem } from "../src/app/meal-entry.js";

// W2 logging math Finding 2: the composer's "Custom portion…" gram
// weight was recorded on the item but never scaled nutrients — the
// preview showed the full listed portion and the payload shipped the
// unscaled portion nutrients as a supplied item. After the fix the
// payload routes through candidate_id + gram_weight, the server
// rescales authoritatively, and the client preview computes the
// identical single-step scale.
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

interface ComposerHarness {
    mealComposer: { items: Record<string, any>[] };
    foodMacroLine: (food: any, portionId?: string, item?: any) => string;
    mealComposerItemMacros: (item: any) => Record<string, number>;
    mealComposerTotals: () => Record<string, number>;
    mealComposerPayload: () => Record<string, any>[];
}

function buildComposer(): ComposerHarness {
    const context: Record<string, unknown> = {
        document: { getElementById: () => null },
        escapeHtml: (value: unknown) =>
            String(value ?? "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;"),
        number: (value: unknown, digits = 0) =>
            new Intl.NumberFormat("en-US", {
                maximumFractionDigits: digits,
            }).format(Number(value || 0)),
    };
    runInNewContext(
        [
            extractConst("mealComposer", "\n};"),
            extract("foodTitle"),
            extract("foodPortion"),
            extractOptional("composerCustomPortionNutrients"),
            extract("foodMacroLine"),
            extract("syncMealComposerFromDom"),
            extract("mealComposerItemMacros"),
            extract("mealComposerTotals"),
            extractOptional("normalizedComposerText"),
            extractOptional("composerNutrientsEqual"),
            extractOptional("findComposerDuplicate"),
            extractOptional("mergeMealComposerItem"),
            extract("mealComposerPayload"),
            "this.__mealComposer = mealComposer;",
            "this.__foodMacroLine = foodMacroLine;",
            "this.__mealComposerItemMacros = mealComposerItemMacros;",
            "this.__mealComposerTotals = mealComposerTotals;",
            "this.__mealComposerPayload = mealComposerPayload;",
        ]
            .filter(Boolean)
            .join("\n"),
        context,
    );
    return {
        mealComposer: context.__mealComposer as ComposerHarness["mealComposer"],
        foodMacroLine:
            context.__foodMacroLine as ComposerHarness["foodMacroLine"],
        mealComposerItemMacros:
            context.__mealComposerItemMacros as ComposerHarness["mealComposerItemMacros"],
        mealComposerTotals:
            context.__mealComposerTotals as ComposerHarness["mealComposerTotals"],
        mealComposerPayload:
            context.__mealComposerPayload as ComposerHarness["mealComposerPayload"],
    };
}

// Client-side food shape (snake_case, as the API serializes it).
const appleFood = {
    candidate_id: "usda:171688",
    name: "Apples, raw, with skin",
    brand: null,
    provider: "usda",
    provider_food_id: "171688",
    confidence: 0.95,
    nutrients_per_100g: {
        calories: 52,
        protein_g: 0.3,
        carbs_g: 13.8,
        fat_g: 0.2,
    },
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
    ],
};

function appleCandidate(): FoodCandidate {
    return {
        provider: "usda",
        providerFoodId: "171688",
        name: "Apples, raw, with skin",
        dataKind: "generic",
        nutrientsPer100g: {
            calories: 52,
            protein_g: 0.3,
            carbs_g: 13.8,
            fat_g: 0.2,
        },
        portions: [
            {
                id: "medium",
                amount: 1,
                unit: "piece",
                label: "1 medium apple",
                gramWeight: 182,
                nutrients: {
                    calories: 95,
                    protein_g: 0.5,
                    carbs_g: 25,
                    fat_g: 0.3,
                },
            },
        ],
        confidence: 0.95,
        attribution: { label: "USDA", url: "https://fdc.nal.usda.gov/" },
    };
}

let detailsSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
    detailsSpy?.mockRestore();
    detailsSpy = undefined;
});

function customAppleItem(overrides: Record<string, any> = {}) {
    return {
        kind: "food",
        food: appleFood,
        candidateId: "usda:171688",
        savedFoodId: undefined,
        portionId: "medium",
        quantity: 1,
        customPortion: true,
        customGramWeight: "91",
        portionLabel: "Half apple",
        ...overrides,
    };
}

describe("composer custom portion (W2 logging math Finding 2)", () => {
    test("custom gram weight at half the portion weight halves preview macros and matches server resolveWebMealItem identically", async () => {
        const harness = buildComposer();
        const item = customAppleItem();
        harness.mealComposer.items = [item];

        // Preview: half of the 182 g portion.
        expect(harness.mealComposerTotals()).toEqual({
            calories: 47.5,
            protein_g: 0.25,
            carbs_g: 12.5,
            fat_g: 0.15,
        });
        const line = harness.foodMacroLine(appleFood, "medium", item);
        expect(line).toContain("Half apple");
        expect(line).toContain("48 kcal");
        expect(line).toContain("P 0.3g");

        // Payload routes through the candidate with the gram weight;
        // the server resolves it to the exact same macros.
        const payload = harness.mealComposerPayload();
        expect(payload).toHaveLength(1);
        expect(payload[0]!.candidate_id).toBe("usda:171688");
        expect(payload[0]!.gram_weight).toBe(91);
        expect(payload[0]!.nutrients).toBeUndefined();

        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate(),
        );
        const resolved = await resolveWebMealItem("user-1", payload[0]!);
        expect(resolved.nutrients).toEqual({
            calories: 47.5,
            protein_g: 0.25,
            carbs_g: 12.5,
            fat_g: 0.15,
        });
        expect(resolved.gramWeight).toBe(91);
    });

    test("preview and server agree for arbitrary custom ratio and quantity (75 g of 182 g × quantity 2)", async () => {
        const harness = buildComposer();
        const item = customAppleItem({
            customGramWeight: "75",
            portionLabel: "",
            quantity: 2,
        });
        harness.mealComposer.items = [item];

        const preview = harness.mealComposerItemMacros(item);
        const payload = harness.mealComposerPayload();
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate(),
        );
        const resolved = await resolveWebMealItem("user-1", payload[0]!);

        for (const key of ["calories", "protein_g", "carbs_g", "fat_g"]) {
            expect(preview[key]).toBe(resolved.nutrients[key]);
        }
        expect(preview.calories).toBe(78.3);
        expect(resolved.gramWeight).toBe(150);
    });

    test("blank custom gram weight leaves portion macros unscaled", async () => {
        const harness = buildComposer();
        const item = customAppleItem({
            customGramWeight: "",
            portionLabel: "1 apple",
        });
        harness.mealComposer.items = [item];

        expect(harness.mealComposerTotals().calories).toBe(95);

        const payload = harness.mealComposerPayload();
        expect(payload[0]!.gram_weight).toBeUndefined();
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate(),
        );
        const resolved = await resolveWebMealItem("user-1", payload[0]!);
        expect(resolved.nutrients.calories).toBe(95);
        expect(resolved.gramWeight).toBe(182);
    });
});
