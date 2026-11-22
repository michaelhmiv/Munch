import { describe, expect, test } from "bun:test";
import type { FoodCandidate } from "../food-providers/types.js";
import {
    parsedItemsFromModelParse,
    type DraftAddModelParse,
} from "./draft-add-parse.js";
import {
    planPreparationUpdate,
    resolveDraftAdd,
    type DraftAddDeps,
} from "./draft-add.js";
import { mealPhotoItemIsComplete } from "./grounding.js";

/**
 * Recorded-fixture tests for the model-first interpret → validate →
 * ground → gate chain. Every dependency is a stub replaying fixed
 * data — no live model calls, no database.
 */

function candidate(overrides: Partial<FoodCandidate> = {}): FoodCandidate {
    return {
        provider: "usda",
        providerFoodId: "173430",
        name: "Butter, salted",
        dataKind: "generic",
        nutrientsPer100g: {
            calories: 717,
            protein_g: 0.85,
            carbs_g: 0.06,
            fat_g: 81.1,
        },
        portions: [
            {
                id: "tbsp",
                amount: 1,
                unit: "tbsp",
                label: "1 tbsp",
                gramWeight: 14.2,
                nutrients: {
                    calories: 102,
                    protein_g: 0.12,
                    carbs_g: 0.01,
                    fat_g: 11.5,
                },
            },
            {
                id: "100g",
                amount: 100,
                unit: "g",
                label: "100 g",
                gramWeight: 100,
                nutrients: {
                    calories: 717,
                    protein_g: 0.85,
                    carbs_g: 0.06,
                    fat_g: 81.1,
                },
            },
        ],
        attribution: {
            label: "USDA FoodData Central",
            url: "https://fdc.nal.usda.gov/food/173430",
        },
        confidence: 0.95,
        ...overrides,
    };
}

function stubModel(reply: DraftAddModelParse): DraftAddDeps["parseWithModel"] {
    return async () => parsedItemsFromModelParse(reply);
}

// The photo draft Michael's flow starts from: chicken + broccoli,
// provider-grounded at 264 + 35 kcal.
const EXISTING_DRAFT_CALORIES = 264 + 35;

const butterSearch: DraftAddDeps["search"] = async (query) => {
    if (query.includes("butter")) {
        return { candidates: [candidate()], failures: [] };
    }
    return { candidates: [], failures: [] };
};

describe("resolveDraftAdd — (a) 'I added a good bit of butter' on a chicken/broccoli photo draft", () => {
    test("butter is interpreted by Ember, provider-grounded, assumption shown, totals recompute", async () => {
        let modelParseCalls = 0;
        const resolution = await resolveDraftAdd(
            "I added a good bit of butter",
            {
                search: butterSearch,
                parseWithModel: async () => {
                    modelParseCalls += 1;
                    return parsedItemsFromModelParse({
                        action: "add",
                        target_item_id: null,
                        items: [
                            {
                                name: "butter",
                                quantity: 1,
                                unit: "tbsp",
                                assumptions: [
                                    'Quantity assumed: "a good bit" interpreted as 1 tbsp.',
                                ],
                            },
                        ],
                        preparation: null,
                        question_prompt: null,
                    });
                },
            },
        );
        expect(modelParseCalls).toBe(1);
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        expect(resolution.parseSource).toBe("model");
        const [added] = resolution.grounded;
        expect(added?.grounded).toBe(true);
        expect(added?.groundingSource).toBe("USDA");
        expect(added?.draftItem.sourceType).toBe("usda");
        expect(added?.draftItem.providerFoodId).toBe("173430");
        expect(added?.draftItem.nutrients.calories).toBe(102);
        expect(
            added?.draftItem.assumptions.some(
                (assumption) =>
                    assumption.includes("a good bit") &&
                    assumption.includes("1 tbsp"),
            ),
        ).toBe(true);
        expect(added?.draftItem.assumptions[0]).toBe(
            'Added by you: "I added a good bit of butter"',
        );
        expect(added?.draftItem.sourceSnapshot?.draft_add_parse_source).toBe(
            "model",
        );
        expect(
            added?.draftItem.sourceSnapshot?.draft_add_quantity_assumed,
        ).toBe(true);
        const total =
            EXISTING_DRAFT_CALORIES +
            resolution.grounded.reduce(
                (sum, entry) => sum + (entry.draftItem.nutrients.calories ?? 0),
                0,
            );
        expect(total).toBe(264 + 35 + 102);
        expect(mealPhotoItemIsComplete(added!)).toBe(true);
    });
});

describe("resolveDraftAdd — (b) an ungrounded add gets labelled Model estimate values", () => {
    test("strong parse + no candidate → estimate step values, source model_estimate, no provider fields", async () => {
        const resolution = await resolveDraftAdd(
            "I added a good bit of durian",
            {
                search: async () => ({ candidates: [], failures: [] }),
                parseWithModel: stubModel({
                    action: "add",
                    target_item_id: null,
                    items: [
                        {
                            name: "durian",
                            quantity: 1,
                            unit: "serving",
                            assumptions: [
                                '"a good bit" interpreted as 1 serving',
                            ],
                        },
                    ],
                    preparation: null,
                    question_prompt: null,
                }),
                estimateNutrients: async (requests) => {
                    expect(requests).toHaveLength(1);
                    expect(requests[0]?.name).toBe("durian");
                    return new Map([
                        [
                            "item:0",
                            {
                                nutrients: {
                                    calories: 21,
                                    protein_g: 0.2,
                                    carbs_g: 3.3,
                                    fat_g: 0.8,
                                },
                            },
                        ],
                    ]);
                },
            },
        );
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        const [added] = resolution.grounded;
        expect(added?.grounded).toBe(false);
        expect(added?.estimated).toBe(true);
        expect(added?.groundingSource).toBe("model_estimate");
        expect(added?.draftItem.sourceType).toBe("model_estimate");
        expect(added?.draftItem.nutrients.calories).toBe(21);
        expect(added?.draftItem.providerFoodId).toBeUndefined();
        expect(added?.draftItem.provider).toBeUndefined();
        expect(added?.draftItem.sourceSnapshot?.estimate_origin).toBe(
            "model_estimate",
        );
    });

    test("strong parse + no candidate + estimate failure → item with NO values and a BLOCKING question (invariant holds)", async () => {
        const resolution = await resolveDraftAdd("2 tbsp qwixle spread", {
            search: async () => ({ candidates: [], failures: [] }),
            parseWithModel: stubModel({
                action: "add",
                target_item_id: null,
                items: [
                    {
                        name: "qwixle spread",
                        quantity: 2,
                        unit: "tbsp",
                        assumptions: [],
                    },
                ],
                preparation: null,
                question_prompt: null,
            }),
            estimateNutrients: async () => {
                throw new Error("estimate unavailable");
            },
        });
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        const [added] = resolution.grounded;
        expect(added?.draftItem.nutrients).toEqual({});
        expect(added?.question?.blocking).toBe(true);
        expect(mealPhotoItemIsComplete(added!)).toBe(true);
    });
});

describe("resolveDraftAdd — production replay 2026-11-13: 'I added butter' on an apple photo draft", () => {
    const per100gOnlyButterSearch: DraftAddDeps["search"] = async (query) => {
        if (query.includes("butter")) {
            return {
                candidates: [
                    candidate({
                        portions: [
                            {
                                id: "100g",
                                amount: 100,
                                unit: "g",
                                label: "100 g",
                                gramWeight: 100,
                                nutrients: {
                                    calories: 717,
                                    protein_g: 0.85,
                                    carbs_g: 0.06,
                                    fat_g: 81.1,
                                },
                            },
                        ],
                    }),
                ],
                failures: [],
            };
        }
        return { candidates: [], failures: [] };
    };
    const butterEstimate: DraftAddDeps["estimateNutrients"] = async (
        requests,
    ) => {
        expect(requests).toHaveLength(1);
        expect(requests[0]?.name).toBe("butter");
        expect(requests[0]?.quantity).toBe(1);
        expect(requests[0]?.unit).toBe("tbsp");
        return new Map([
            [
                "item:0",
                {
                    nutrients: {
                        calories: 102,
                        protein_g: 0.1,
                        carbs_g: 0,
                        fat_g: 11.5,
                    },
                },
            ],
        ]);
    };

    test("'I added butter' (no amount stated) → default-portion assumption + labelled estimate, totals move, no question", async () => {
        const resolution = await resolveDraftAdd("I added butter", {
            search: per100gOnlyButterSearch,
            estimateNutrients: butterEstimate,
            parseWithModel: stubModel({
                action: "add",
                target_item_id: null,
                items: [
                    {
                        name: "butter",
                        quantity: null,
                        unit: null,
                        assumptions: [],
                    },
                ],
                preparation: null,
                question_prompt: null,
            }),
        });
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        expect(resolution.parseSource).toBe("model");
        const [added] = resolution.grounded;
        expect(added?.grounded).toBe(false);
        expect(added?.estimated).toBe(true);
        expect(added?.draftItem.sourceType).toBe("model_estimate");
        expect(added?.draftItem.nutrients.calories).toBe(102);
        expect(added?.question).toBeNull();
        expect(
            added?.draftItem.assumptions.some(
                (assumption) =>
                    assumption.includes("Quantity assumed") &&
                    assumption.includes("1 tbsp"),
            ),
        ).toBe(true);
        expect(
            added?.draftItem.sourceSnapshot?.draft_add_quantity_assumed,
        ).toBe(true);
        const total =
            EXISTING_DRAFT_CALORIES +
            resolution.grounded.reduce(
                (sum, entry) => sum + (entry.draftItem.nutrients.calories ?? 0),
                0,
            );
        expect(total).toBe(264 + 35 + 102);
        expect(mealPhotoItemIsComplete(added!)).toBe(true);
    });
});

describe("resolveDraftAdd — (c) ambiguous/unparseable adds never silently add", () => {
    test("weak parse (bare name) that cannot ground, but the estimate step prices it → added as a labelled Model estimate", async () => {
        const resolution = await resolveDraftAdd("added qwixle", {
            search: async () => ({ candidates: [], failures: [] }),
            parseWithModel: stubModel({
                action: "add",
                target_item_id: null,
                items: [
                    {
                        name: "qwixle",
                        quantity: null,
                        unit: null,
                        assumptions: [],
                    },
                ],
                preparation: null,
                question_prompt: null,
            }),
            estimateNutrients: async () =>
                new Map([
                    [
                        "item:0",
                        {
                            nutrients: {
                                calories: 50,
                                protein_g: 1,
                                carbs_g: 5,
                                fat_g: 3,
                            },
                        },
                    ],
                ]),
        });
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        const [added] = resolution.grounded;
        expect(added?.grounded).toBe(false);
        expect(added?.estimated).toBe(true);
        expect(added?.draftItem.sourceType).toBe("model_estimate");
        expect(added?.draftItem.nutrients.calories).toBe(50);
        expect(mealPhotoItemIsComplete(added!)).toBe(true);
    });

    test("weak parse (bare name) with NO usable nutrition — estimate fails → question outcome", async () => {
        const resolution = await resolveDraftAdd("added qwixle", {
            search: async () => ({ candidates: [], failures: [] }),
            parseWithModel: stubModel({
                action: "add",
                target_item_id: null,
                items: [
                    {
                        name: "qwixle",
                        quantity: null,
                        unit: null,
                        assumptions: [],
                    },
                ],
                preparation: null,
                question_prompt: null,
            }),
            estimateNutrients: async () => {
                throw new Error("estimate unavailable");
            },
        });
        expect(resolution.kind).toBe("question");
        if (resolution.kind !== "question") return;
        expect(resolution.unresolvedNames).toEqual(["qwixle"]);
    });

    test("a grounded pick sharing no name token with the interpreted food → question outcome", async () => {
        const resolution = await resolveDraftAdd("1 tbsp butter", {
            search: async () => ({
                candidates: [
                    candidate({
                        providerFoodId: "999",
                        name: "Chocolate hazelnut spread",
                    }),
                ],
                failures: [],
            }),
            parseWithModel: stubModel({
                action: "add",
                target_item_id: null,
                items: [
                    {
                        name: "butter",
                        quantity: 1,
                        unit: "tbsp",
                        assumptions: [],
                    },
                ],
                preparation: null,
                question_prompt: null,
            }),
        });
        expect(resolution.kind).toBe("question");
        if (resolution.kind !== "question") return;
        expect(resolution.unresolvedNames).toEqual(["butter"]);
    });

    test("action=none → none (no search spent)", async () => {
        let searchCalls = 0;
        const resolution = await resolveDraftAdd("the weather is nice today", {
            search: async () => {
                searchCalls += 1;
                return { candidates: [], failures: [] };
            },
            parseWithModel: stubModel({
                action: "none",
                target_item_id: null,
                items: [],
                preparation: null,
                question_prompt: null,
            }),
        });
        expect(searchCalls).toBe(0);
        expect(resolution.kind).toBe("none");
    });

    test("fail-open: model error or missing interpreter → no_parse, never throws and never adds", async () => {
        const failing = await resolveDraftAdd("the weather is nice today", {
            search: butterSearch,
            parseWithModel: async () => {
                throw new Error("provider down");
            },
        });
        expect(failing.kind).toBe("no_parse");

        const unconfigured = await resolveDraftAdd("1 tbsp butter", {
            search: butterSearch,
        });
        expect(unconfigured.kind).toBe("no_parse");
    });
});

describe("resolveDraftAdd — preparation statements (photo-flow P2)", () => {
    const cornContext = [
        {
            id: "item-corn",
            name: "Corn On The Cob",
            cookingMethod: "steamed",
        },
    ];
    const oilSearch: DraftAddDeps["search"] = async (query) => {
        if (query.includes("oil")) {
            return {
                candidates: [
                    candidate({
                        providerFoodId: "171001",
                        name: "Oil, vegetable",
                        nutrientsPer100g: {
                            calories: 884,
                            protein_g: 0,
                            carbs_g: 0,
                            fat_g: 100,
                        },
                        portions: [
                            {
                                id: "tbsp",
                                amount: 1,
                                unit: "tbsp",
                                label: "1 tbsp",
                                gramWeight: 13.6,
                                nutrients: {
                                    calories: 120,
                                    protein_g: 0,
                                    carbs_g: 0,
                                    fat_g: 13.6,
                                },
                            },
                        ],
                    }),
                ],
                failures: [],
            };
        }
        return { candidates: [], failures: [] };
    };

    test("'i deep fried it' on a steamed item → method correction targeted by exact id + implied oil grounded", async () => {
        const resolution = await resolveDraftAdd(
            "i deep fried it",
            {
                search: oilSearch,
                parseWithModel: async (text, context) => {
                    expect(text).toBe("i deep fried it");
                    expect(context.items).toEqual(cornContext);
                    return parsedItemsFromModelParse({
                        action: "add",
                        target_item_id: null,
                        items: [
                            {
                                name: "vegetable oil",
                                quantity: 1,
                                unit: "tbsp",
                                assumptions: [
                                    "Oil absorbed in deep frying, assumed 1 tbsp",
                                ],
                            },
                        ],
                        preparation: {
                            target_item_id: "item-corn",
                            cooking_method: "deep fried",
                        },
                        question_prompt: null,
                    });
                },
            },
            cornContext,
        );
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        expect(resolution.preparation).toEqual({
            targetItemId: "item-corn",
            cookingMethod: "deep fried",
        });
        expect(resolution.preparationTargetId).toBe("item-corn");
        expect(resolution.preparationTargetName).toBe("Corn On The Cob");
        const [oil] = resolution.grounded;
        expect(oil?.grounded).toBe(true);
        expect(oil?.draftItem.name).toContain("Oil, vegetable");
        expect(oil?.draftItem.nutrients.calories).toBe(120);
        expect(oil?.draftItem.assumptions[0]).toBe(
            'Added by you: "i deep fried it"',
        );
        expect(mealPhotoItemIsComplete(oil!)).toBe(true);
    });

    test("'grilled instead' → method only: ready with no additions", async () => {
        const resolution = await resolveDraftAdd(
            "grilled instead",
            {
                search: oilSearch,
                parseWithModel: stubModel({
                    action: "none",
                    target_item_id: null,
                    items: [],
                    preparation: {
                        target_item_id: null,
                        cooking_method: "grilled",
                    },
                    question_prompt: null,
                }),
            },
            [
                {
                    id: "item-chicken",
                    name: "Chicken breast",
                    cookingMethod: "baked",
                },
            ],
        );
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        expect(resolution.grounded).toEqual([]);
        expect(resolution.preparation?.cookingMethod).toBe("grilled");
        expect(resolution.preparationTargetId).toBe("item-chicken");
        expect(resolution.preparationTargetName).toBe("Chicken breast");
    });

    test("an unnamed preparation target on a multi-item draft → preparation_question, nothing guessed", async () => {
        const resolution = await resolveDraftAdd(
            "i deep fried it",
            {
                search: oilSearch,
                parseWithModel: stubModel({
                    action: "none",
                    target_item_id: null,
                    items: [],
                    preparation: {
                        target_item_id: null,
                        cooking_method: "deep fried",
                    },
                    question_prompt: null,
                }),
            },
            [
                {
                    id: "item-corn",
                    name: "Corn On The Cob",
                    cookingMethod: "steamed",
                },
                {
                    id: "item-chicken",
                    name: "Chicken breast",
                    cookingMethod: "baked",
                },
            ],
        );
        expect(resolution.kind).toBe("preparation_question");
    });

    test("an unknown preparation target_item_id → preparation_question", async () => {
        const resolution = await resolveDraftAdd(
            "the tofu was deep fried",
            {
                search: oilSearch,
                parseWithModel: stubModel({
                    action: "none",
                    target_item_id: null,
                    items: [],
                    preparation: {
                        target_item_id: "item-does-not-exist",
                        cooking_method: "deep fried",
                    },
                    question_prompt: null,
                }),
            },
            cornContext,
        );
        expect(resolution.kind).toBe("preparation_question");
    });
});

describe("planPreparationUpdate (photo-flow P2)", () => {
    test("the corrected method lands in assumptions + snapshot, with the original preserved", () => {
        const planned = planPreparationUpdate(
            {
                name: "Corn On The Cob",
                quantity: 3,
                portionLabel: "3 piece",
                gramWeight: 270,
                nutrients: { calories: 232 },
                sourceType: "open_food_facts",
                assumptions: ["Counted 3 piece at about 90 g each."],
                sourceSnapshot: {
                    resolution_layer: "meal_photo_grounding",
                    cooking_method: "steamed",
                },
            } as never,
            { targetItemId: "item-corn", cookingMethod: "deep fried" },
        );
        expect(planned.previousMethod).toBe("steamed");
        expect(planned.item.assumptions[0]).toContain(
            'Cooking method corrected by you: "deep fried"',
        );
        expect(planned.item.assumptions[0]).toContain('"steamed"');
        expect(planned.item.sourceSnapshot?.cooking_method).toBe("deep fried");
        expect(planned.item.sourceSnapshot?.cooking_method_corrected_from).toBe(
            "steamed",
        );
        expect(planned.item.nutrients.calories).toBe(232);
        expect(planned.item.gramWeight).toBe(270);
    });
});
