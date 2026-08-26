import { describe, expect, test } from "bun:test";
import { deduplicateCandidates, rankCandidates } from "./ranking.js";
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
        ...overrides,
    };
}

describe("food candidate ranking", () => {
    test("prioritizes exact text and brand matches without food-specific rules", () => {
        const ranked = rankCandidates(
            { query: "Simply Nature Creamy Peanut Butter" },
            [
                food("Peanut butter"),
                food("Creamy Peanut Butter", {
                    provider: "open_food_facts",
                    providerFoodId: "4099100316896",
                    dataKind: "packaged",
                    brand: "Simply Nature",
                    barcode: "4099100316896",
                    confidence: 0.96,
                }),
            ],
        );
        expect(ranked[0]?.name).toBe("Creamy Peanut Butter");
    });

    test("keeps ambiguous semantic alternatives available for the model", () => {
        const ranked = rankCandidates({ query: "bacon" }, [
            food("Bacon bits"),
            food("Bacon, cooked"),
            food("Canadian bacon"),
        ]);
        expect(ranked.map((candidate) => candidate.name)).toEqual([
            "Bacon bits",
            "Bacon, cooked",
            "Canadian bacon",
        ]);
    });

    test("deduplicates identical provider identities and keeps higher confidence", () => {
        const candidates = deduplicateCandidates([
            food("Milk", { providerFoodId: "milk", confidence: 0.7 }),
            food("Milk", { providerFoodId: "milk", confidence: 0.95 }),
        ]);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.confidence).toBe(0.95);
    });
});
