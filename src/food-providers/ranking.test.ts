import { describe, expect, test } from "bun:test";
import { rankCandidates } from "./ranking.js";
import type { FoodCandidate } from "./types.js";

function food(
    name: string,
    overrides: Partial<FoodCandidate> = {},
): FoodCandidate {
    return {
        provider: "usda",
        providerFoodId: name,
        name,
        dataKind: "generic",
        nutrientsPer100g: { calories: 100, protein_g: 5 },
        portions: [
            {
                id: "100g",
                amount: 100,
                unit: "g",
                label: "100 g",
                gramWeight: 100,
                nutrients: { calories: 100, protein_g: 5 },
            },
        ],
        attribution: { label: "USDA FoodData Central" },
        confidence: 0.9,
        raw: {
            ingestionSource: "bulk_seed",
            dataset: "sr_legacy",
            datasetRelease: "2018-04",
        },
        ...overrides,
    };
}

function top(query: string, candidates: FoodCandidate[]): string {
    return rankCandidates({ query }, candidates)[0]!.name;
}

describe("generic food ranking", () => {
    test("prefers plain milk over token-related packaged milk", () => {
        expect(
            top("milk", [
                food("Muscle Milk Chocolate", {
                    dataKind: "packaged",
                    brand: "Muscle Milk",
                    barcode: "049000028904",
                    confidence: 0.96,
                    raw: undefined,
                }),
                food("Milk, whole, 3.25% milkfat, without added vitamin A"),
            ]),
        ).toBe("Milk, whole, 3.25% milkfat, without added vitamin A");
    });

    test("prefers basic ingredients over composite dishes", () => {
        expect(
            top("cheddar cheese", [
                food("Cheese sandwich, cheddar cheese, on white bread", {
                    raw: { dataset: "survey" },
                }),
                food("Cheese, cheddar"),
            ]),
        ).toBe("Cheese, cheddar");
        expect(
            top("sweet potato", [
                food("Pie, sweet potato", { raw: { dataset: "survey" } }),
                food("Sweet potato, raw, unprepared"),
            ]),
        ).toBe("Sweet potato, raw, unprepared");
        expect(
            top("salmon", [
                food("Salmon salad", { raw: { dataset: "survey" } }),
                food("Fish, salmon, Atlantic, wild, raw"),
            ]),
        ).toBe("Fish, salmon, Atlantic, wild, raw");
    });

    test("prefers candidates led by the requested ingredient", () => {
        expect(
            top("2% milk", [
                food("Rennin, vanilla, dry mix, prepared with 2% milk", {
                    raw: { dataset: "survey" },
                }),
                food(
                    "Milk, reduced fat, fluid, 2% milkfat, with added vitamin A and vitamin D",
                ),
            ]),
        ).toBe(
            "Milk, reduced fat, fluid, 2% milkfat, with added vitamin A and vitamin D",
        );
        expect(
            top("skim milk", [
                food("Yogurt, plain, skim milk", {
                    raw: { dataset: "survey" },
                }),
                food(
                    "Milk, nonfat, fluid, with added vitamin A and vitamin D (fat free or skim)",
                ),
            ]),
        ).toBe(
            "Milk, nonfat, fluid, with added vitamin A and vitamin D (fat free or skim)",
        );
        expect(
            top("onion", [
                food("Gravy, onion, dry, mix", {
                    raw: { dataset: "survey" },
                }),
                food("Onions, raw"),
            ]),
        ).toBe("Onions, raw");
    });

    test("singularizes food words when matching generic USDA names", () => {
        expect(
            top("sugar", [
                food("Cookie, sugar wafer, sugar free", {
                    raw: { dataset: "survey" },
                }),
                food("Sugars, granulated"),
            ]),
        ).toBe("Sugars, granulated");
        expect(
            top("potatoes", [food("Potato, raw"), food("Potato chips")]),
        ).toBe("Potato, raw");
    });

    test("does not demote an exact branded product query", () => {
        expect(
            top("Simply Nature Creamy Peanut Butter", [
                food("Peanut butter"),
                food("Creamy Peanut Butter", {
                    dataKind: "packaged",
                    brand: "Simply Nature",
                    barcode: "4099100316896",
                    confidence: 0.96,
                    raw: undefined,
                }),
            ]),
        ).toBe("Creamy Peanut Butter");
    });
    test("demotes prepared forms for plain ingredient queries", () => {
        expect(
            top("cinnamon", [
                food("Cinnamon buns, frosted", { raw: { dataset: "survey" } }),
                food("Spices, cinnamon, ground"),
            ]),
        ).toBe("Spices, cinnamon, ground");
        expect(
            top("egg", [
                food("Egg, yolk, dried"),
                food("Egg, whole, raw, fresh"),
            ]),
        ).toBe("Egg, whole, raw, fresh");
        expect(
            top("tuna", [
                food("Tuna with cream or white sauce", {
                    raw: { dataset: "survey" },
                }),
                food("Fish, tuna, light, raw"),
            ]),
        ).toBe("Fish, tuna, light, raw");
        expect(
            top("walnuts", [
                food("Walnuts, honey roasted", { raw: { dataset: "survey" } }),
                food("Walnuts, raw"),
            ]),
        ).toBe("Walnuts, raw");
        expect(
            top("cooked broccoli", [
                food("Broccoli raab, cooked"),
                food("Broccoli, cooked"),
            ]),
        ).toBe("Broccoli, cooked");
    });
    test("demotes derived variants exposed by the USDA corpus", () => {
        expect(
            top("blueberries", [
                food("Blueberry juice", { raw: { dataset: "survey" } }),
                food("Blueberries, raw"),
            ]),
        ).toBe("Blueberries, raw");
        expect(top("bacon", [food("Bacon bits"), food("Bacon")])).toBe("Bacon");
        expect(
            top("spaghetti", [
                food("Spaghetti, spinach, cooked"),
                food("Spaghetti, cooked"),
            ]),
        ).toBe("Spaghetti, cooked");
        expect(
            top("macaroni", [
                food("Macaroni with tuna, Puerto Rican style", {
                    raw: { dataset: "survey" },
                }),
                food("Macaroni, cooked"),
            ]),
        ).toBe("Macaroni, cooked");
        expect(
            top("walnuts", [
                food("Nuts, walnuts, glazed"),
                food("Nuts, walnuts, raw"),
            ]),
        ).toBe("Nuts, walnuts, raw");
        expect(
            top("cooked broccoli", [
                food("Broccoli, Chinese, cooked"),
                food("Broccoli, cooked"),
            ]),
        ).toBe("Broccoli, cooked");
    });
});
