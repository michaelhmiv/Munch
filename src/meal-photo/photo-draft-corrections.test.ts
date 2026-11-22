import { describe, expect, test } from "bun:test";
import type { FoodCandidate } from "../food-providers/types.js";
import type { MealDraft } from "../meal-drafts/types.js";
import { parseDraftAddTextDeterministic } from "./draft-add-text.js";
import {
    draftAddParseJsonSchema,
    parseDraftAddTextWithModel,
    parsedItemsFromModelParse,
} from "./draft-add-parse.js";
import {
    addTextToPhotoDraft,
    resolveDraftAdd,
    type DraftAddDeps,
    type DraftAddStore,
} from "./draft-add.js";
import { groundMealPhotoItems, mealPhotoItemIsComplete } from "./grounding.js";
import {
    identifyMealPhoto,
    type MealPhotoVisionConfig,
    type MealPhotoVisionItem,
} from "./vision.js";

/**
 * Incident replay + regression suite for the 2026-11-22 photo-draft
 * audit (Defects 1, 2, and 3):
 * - Defect 1: corrections appended duplicates instead of replacing in place.
 * - Defect 2: visible buns were silently omitted (vision prompt + count
 *   units for bun/roll/link).
 * - Defect 3: quantity did not carry over across a correction.
 */

const bratwurstCandidate: FoodCandidate = {
    provider: "usda",
    providerFoodId: "174591",
    name: "Bratwurst, pork, cooked",
    dataKind: "generic",
    nutrientsPer100g: {
        calories: 333,
        protein_g: 14.1,
        carbs_g: 2.7,
        fat_g: 29.4,
    },
    portions: [
        {
            id: "100g",
            amount: 100,
            unit: "g",
            label: "100 g",
            gramWeight: 100,
            nutrients: {
                calories: 333,
                protein_g: 14.1,
                carbs_g: 2.7,
                fat_g: 29.4,
            },
        },
        {
            id: "link",
            amount: 1,
            unit: "link",
            label: "1 link",
            gramWeight: 85,
            nutrients: {
                calories: 283,
                protein_g: 12,
                carbs_g: 2.3,
                fat_g: 25,
            },
        },
    ],
    attribution: {
        label: "USDA FoodData Central",
        url: "https://fdc.nal.usda.gov/food/174591",
    },
    confidence: 0.95,
};

const hotDogCandidate: FoodCandidate = {
    provider: "usda",
    providerFoodId: "174589",
    name: "Hot dog, beef",
    dataKind: "generic",
    nutrientsPer100g: {
        calories: 315,
        protein_g: 11.7,
        carbs_g: 2.2,
        fat_g: 28.5,
    },
    portions: [
        {
            id: "frank",
            amount: 1,
            unit: "frank",
            label: "1 frank",
            gramWeight: 57,
            nutrients: {
                calories: 180,
                protein_g: 6.7,
                carbs_g: 1.3,
                fat_g: 16.2,
            },
        },
    ],
    attribution: {
        label: "USDA FoodData Central",
        url: "https://fdc.nal.usda.gov/food/174589",
    },
    confidence: 0.95,
};

const hotDogBunCandidate: FoodCandidate = {
    provider: "usda",
    providerFoodId: "172686",
    name: "Hot dog bun, plain",
    dataKind: "generic",
    nutrientsPer100g: {
        calories: 279,
        protein_g: 8.9,
        carbs_g: 50.3,
        fat_g: 4.4,
    },
    portions: [
        {
            id: "100g",
            amount: 100,
            unit: "g",
            label: "100 g",
            gramWeight: 100,
            nutrients: {
                calories: 279,
                protein_g: 8.9,
                carbs_g: 50.3,
                fat_g: 4.4,
            },
        },
        {
            id: "bun",
            amount: 1,
            unit: "bun",
            label: "1 bun",
            gramWeight: 43,
            nutrients: {
                calories: 120,
                protein_g: 3.8,
                carbs_g: 21.6,
                fat_g: 1.9,
            },
        },
    ],
    attribution: {
        label: "USDA FoodData Central",
        url: "https://fdc.nal.usda.gov/food/172686",
    },
    confidence: 0.95,
};

const mustardCandidate: FoodCandidate = {
    provider: "usda",
    providerFoodId: "172234",
    name: "Mustard, prepared, yellow",
    dataKind: "generic",
    nutrientsPer100g: {
        calories: 66,
        protein_g: 3.7,
        carbs_g: 5.8,
        fat_g: 3.3,
    },
    portions: [
        {
            id: "tbsp",
            amount: 1,
            unit: "tbsp",
            label: "1 tbsp",
            gramWeight: 15,
            nutrients: {
                calories: 10,
                protein_g: 0.6,
                carbs_g: 0.9,
                fat_g: 0.5,
            },
        },
    ],
    attribution: {
        label: "USDA FoodData Central",
        url: "https://fdc.nal.usda.gov/food/172234",
    },
    confidence: 0.95,
};

const butterCandidate: FoodCandidate = {
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
    ],
    attribution: {
        label: "USDA FoodData Central",
        url: "https://fdc.nal.usda.gov/food/173430",
    },
    confidence: 0.95,
};

const porkCandidate: FoodCandidate = {
    provider: "usda",
    providerFoodId: "167820",
    name: "Pork tenderloin, roasted",
    dataKind: "generic",
    nutrientsPer100g: {
        calories: 143,
        protein_g: 26,
        carbs_g: 0,
        fat_g: 3.5,
    },
    portions: [
        {
            id: "100g",
            amount: 100,
            unit: "g",
            label: "100 g",
            gramWeight: 100,
            nutrients: {
                calories: 143,
                protein_g: 26,
                carbs_g: 0,
                fat_g: 3.5,
            },
        },
    ],
    attribution: {
        label: "USDA FoodData Central",
        url: "https://fdc.nal.usda.gov/food/167820",
    },
    confidence: 0.95,
};

const fixtureSearch: DraftAddDeps["search"] = async (query) => {
    const q = query.toLowerCase();
    if (q.includes("bratwurst")) {
        return { candidates: [bratwurstCandidate], failures: [] };
    }
    if (q.includes("hot dog") && !q.includes("bun")) {
        return { candidates: [hotDogCandidate], failures: [] };
    }
    if (q.includes("bun")) {
        return { candidates: [hotDogBunCandidate], failures: [] };
    }
    if (q.includes("mustard")) {
        return { candidates: [mustardCandidate], failures: [] };
    }
    if (q.includes("butter")) {
        return { candidates: [butterCandidate], failures: [] };
    }
    if (q.includes("pork")) {
        return { candidates: [porkCandidate], failures: [] };
    }
    return { candidates: [], failures: [] };
};

const visionConfig: MealPhotoVisionConfig = {
    apiKey: "test-key",
    model: "meta/muse-ember",
    baseUrl: "https://example.test/v1",
    timeoutMs: 1_000,
};

/** In-memory mirror of the Postgres draft store so end-to-end
 * `addTextToPhotoDraft` tests assert exact item ordering, question
 * cascading, version threading, and recomputed totals without a DB. */
function createMemoryDraftStore(initial: MealDraft): {
    draft: () => MealDraft;
    store: DraftAddStore;
} {
    let state: MealDraft = structuredClone(initial);
    let seq = 100;
    const assertVersion = (expectedVersion: number) => {
        if (state.version !== expectedVersion) {
            throw new Error(
                `Meal draft changed: expected version ${expectedVersion}, current version ${state.version}`,
            );
        }
    };
    const refreshStatus = () => {
        const openCount = state.questions.filter(
            (q) => q.status === "open",
        ).length;
        state.status =
            openCount > 0
                ? "awaiting_answers"
                : state.items.length > 0
                  ? "awaiting_confirmation"
                  : "open";
    };
    const store: DraftAddStore = {
        async addMealDraftQuestion(input) {
            assertVersion(input.expectedVersion);
            const now = new Date().toISOString();
            const existingIdx = state.questions.findIndex(
                (q) => q.questionKey === input.questionKey,
            );
            const nextQuestion = {
                id: `q-${++seq}`,
                itemId: input.itemId ?? null,
                questionKey: input.questionKey,
                prompt: input.prompt,
                impactScore: input.impactScore ?? 50,
                status: "open" as const,
                answer: null,
                createdAt: now,
                answeredAt: null,
            };
            if (existingIdx >= 0) {
                state.questions[existingIdx] = nextQuestion;
            } else {
                state.questions.push(nextQuestion);
            }
            state.version += 1;
            refreshStatus();
            return structuredClone(state);
        },
        async deleteMealDraftItem(input) {
            assertVersion(input.expectedVersion);
            const target = state.items.find((i) => i.id === input.itemId);
            if (!target) throw new Error("Meal draft item not found");
            state.items = state.items
                .filter((i) => i.id !== input.itemId)
                .map((i) =>
                    i.position > target.position
                        ? { ...i, position: i.position - 1 }
                        : i,
                );
            state.questions = state.questions.filter(
                (q) => q.itemId !== input.itemId,
            );
            state.version += 1;
            refreshStatus();
            return structuredClone(state);
        },
        async upsertMealDraftItem(input) {
            assertVersion(input.expectedVersion);
            const now = new Date().toISOString();
            const existingIdx = state.items.findIndex(
                (i) => i.position === input.position,
            );
            if (existingIdx >= 0) {
                state.items[existingIdx] = {
                    ...state.items[existingIdx]!,
                    item: structuredClone(input.item),
                    updatedAt: now,
                };
            } else {
                state.items.push({
                    id: `item-${++seq}`,
                    position: input.position,
                    item: structuredClone(input.item),
                    createdAt: now,
                    updatedAt: now,
                });
                state.items.sort((a, b) => a.position - b.position);
            }
            state.version += 1;
            refreshStatus();
            return structuredClone(state);
        },
        async replaceMealDraftItem(input) {
            assertVersion(input.expectedVersion);
            const target = state.items.find((i) => i.id === input.itemId);
            if (!target) throw new Error("Meal draft item not found");
            const now = new Date().toISOString();
            const shift = input.items.length - 1;
            const remaining = state.items
                .filter((i) => i.id !== input.itemId)
                .map((i) =>
                    i.position > target.position
                        ? { ...i, position: i.position + shift }
                        : i,
                );
            const inserted = input.items.map((item, offset) => ({
                id: `item-${++seq}`,
                position: target.position + offset,
                item: structuredClone(item),
                createdAt: now,
                updatedAt: now,
            }));
            state.items = [...remaining, ...inserted].sort(
                (a, b) => a.position - b.position,
            );
            // Cascade item-linked questions, matching ON DELETE CASCADE.
            state.questions = state.questions.filter(
                (q) => q.itemId !== input.itemId,
            );
            state.version += 1;
            refreshStatus();
            return structuredClone(state);
        },
    };
    return { draft: () => structuredClone(state), store };
}

function makePhotoDraft(
    items: Array<{
        id: string;
        name: string;
        quantity: number;
        portionLabel: string;
        calories: number;
        gramWeight?: number;
        cookingMethod?: string | null;
        visionName?: string;
    }>,
    questions: MealDraft["questions"] = [],
): MealDraft {
    const now = new Date().toISOString();
    return {
        id: "11111111-1111-4111-8111-111111111111",
        userId: "user-1",
        status:
            questions.length > 0 ? "awaiting_answers" : "awaiting_confirmation",
        sourceMode: "photo",
        mealType: "lunch",
        description: "Photo meal",
        loggedAt: now,
        notes: "Photo estimate — check portions.",
        version: 1,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        confirmedMealId: null,
        createdAt: now,
        updatedAt: now,
        items: items.map((entry, position) => ({
            id: entry.id,
            position,
            createdAt: now,
            updatedAt: now,
            item: {
                name: entry.name,
                quantity: entry.quantity,
                portionLabel: entry.portionLabel,
                ...(entry.gramWeight !== undefined
                    ? { gramWeight: entry.gramWeight }
                    : {}),
                nutrients: { calories: entry.calories },
                sourceType: "usda",
                provider: "usda",
                confidence: 0.85,
                assumptions: [],
                sourceSnapshot: {
                    resolution_layer: "meal_photo_grounding",
                    vision_name: entry.visionName ?? entry.name,
                    cooking_method: entry.cookingMethod ?? null,
                },
            },
        })),
        questions,
    };
}

function totalCalories(draft: MealDraft): number {
    return draft.items.reduce(
        (sum, record) => sum + (record.item.nutrients.calories ?? 0),
        0,
    );
}

/** The real 2026-11-22 incident draft: hot dog ×2 piece (700 kcal) +
 * mustard sauce ×1 tbsp (45 kcal). */
function incidentDraft(): MealDraft {
    return makePhotoDraft(
        [
            {
                id: "item-hotdog",
                name: "hot dog",
                quantity: 2,
                portionLabel: "2 piece",
                calories: 700,
                cookingMethod: "grilled",
            },
            {
                id: "item-mustard",
                name: "mustard sauce",
                quantity: 1,
                portionLabel: "1 tbsp",
                calories: 45,
            },
        ],
        [
            {
                id: "q-old-hotdog",
                itemId: "item-hotdog",
                questionKey: "photo_portion_0",
                prompt: "About how much hot dog — the photo estimate was 2 piece.",
                impactScore: 80,
                status: "open",
                answer: null,
                createdAt: new Date().toISOString(),
                answeredAt: null,
            },
        ],
    );
}

describe("Incident replay (2026-11-22) — end-to-end addTextToPhotoDraft", () => {
    const modelBratwurstReply: DraftAddDeps["parseWithModel"] = async (
        _text,
        context,
    ) => {
        expect(context.items[0]).toMatchObject({
            name: "hot dog",
            quantity: 2,
            portionLabel: "2 piece",
        });
        return parsedItemsFromModelParse({
            items: [
                {
                    name: "bratwurst",
                    quantity: null,
                    unit: null,
                    assumptions: [],
                },
            ],
            replaces: "hot dog",
            is_replacement: true,
            preparation: null,
        });
    };

    for (const { phrasing, expectsModel } of [
        { phrasing: "actually bratwurst, not hot dog", expectsModel: false },
        { phrasing: "those are bratwurst not hot dogs", expectsModel: false },
        { phrasing: "the hot dog is a bratwurst", expectsModel: false },
        { phrasing: "those are bratwurst", expectsModel: true },
        { phrasing: "it was bratwurst", expectsModel: true },
    ]) {
        test(`"${phrasing}" replaces hot dog IN PLACE with bratwurst ×2, removes hot dog, cascades old question, and recomputes totals`, async () => {
            const { store } = createMemoryDraftStore(incidentDraft());
            let modelCalls = 0;
            const outcome = await addTextToPhotoDraft({
                userId: "user-1",
                draft: incidentDraft(),
                text: phrasing,
                deps: {
                    search: fixtureSearch,
                    store,
                    parseWithModel: async (text, context) => {
                        modelCalls += 1;
                        return modelBratwurstReply(text, context);
                    },
                },
            });
            expect(modelCalls).toBe(expectsModel ? 1 : 0);
            expect(outcome.status).toBe("added");
            if (outcome.status !== "added") return;
            expect(outcome.replacedItemName).toBe("hot dog");
            expect(outcome.message).toBe(
                "Replaced hot dog with Bratwurst, pork, cooked.",
            );
            // Final draft contains bratwurst ×2 in position 0 and mustard in position 1; NO hot dog.
            expect(outcome.draft.items).toHaveLength(2);
            expect(
                outcome.draft.items.some((r) =>
                    r.item.name.toLowerCase().includes("hot dog"),
                ),
            ).toBe(false);
            expect(outcome.draft.items[0]?.position).toBe(0);
            expect(outcome.draft.items[0]?.item.name).toBe(
                "Bratwurst, pork, cooked",
            );
            expect(outcome.draft.items[0]?.item.quantity).toBe(2);
            expect(outcome.draft.items[0]?.item.portionLabel).toBe("2 piece");
            expect(outcome.draft.items[0]?.item.gramWeight).toBe(170);
            expect(outcome.draft.items[0]?.item.nutrients.calories).toBe(566);
            expect(outcome.draft.items[1]?.position).toBe(1);
            expect(outcome.draft.items[1]?.item.name).toBe("mustard sauce");
            // Old question attached to hot dog cascaded on replacement.
            expect(outcome.draft.questions).toHaveLength(0);
            // Totals equal the corrected items' sum (566 + 45 = 611, NOT 995).
            expect(totalCalories(outcome.draft)).toBe(566 + 45);
        });
    }

    test("add still adds: 'I added a good bit of butter' appends butter with its stated assumption, touching nothing else", async () => {
        const { store } = createMemoryDraftStore(incidentDraft());
        let modelCalls = 0;
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: incidentDraft(),
            text: "I added a good bit of butter",
            deps: {
                search: fixtureSearch,
                store,
                parseWithModel: async () => {
                    modelCalls += 1;
                    throw new Error("fallback must not fire");
                },
            },
        });
        expect(modelCalls).toBe(0);
        expect(outcome.status).toBe("added");
        if (outcome.status !== "added") return;
        expect(outcome.replacedItemName).toBeNull();
        expect(outcome.message).toBe("Added Butter, salted to the draft.");
        expect(outcome.draft.items.map((r) => r.item.name)).toEqual([
            "hot dog",
            "mustard sauce",
            "Butter, salted",
        ]);
        expect(
            outcome.draft.items[2]?.item.assumptions.some(
                (a) => a.includes("a good bit") && a.includes("1 tbsp"),
            ),
        ).toBe(true);
        expect(totalCalories(outcome.draft)).toBe(700 + 45 + 102);
    });

    test("'actually, I added butter' keeps add semantics (explicit add cue)", async () => {
        const { store } = createMemoryDraftStore(incidentDraft());
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: incidentDraft(),
            text: "actually, I added butter",
            deps: { search: fixtureSearch, store },
        });
        expect(outcome.status).toBe("added");
        if (outcome.status !== "added") return;
        expect(outcome.replacedItemName).toBeNull();
        expect(outcome.draft.items).toHaveLength(3);
    });
});

describe("Defect 1 — natural correction phrasings, ambiguity, and duplicate guard", () => {
    test("deterministic parser classifies natural correction phrasings as replacements, not adds", () => {
        const actuallyNot = parseDraftAddTextDeterministic(
            "actually bratwurst, not hot dog",
        );
        expect(actuallyNot?.kind).toBe("replace");

        const thoseNot = parseDraftAddTextDeterministic(
            "those are bratwurst not hot dogs",
        );
        expect(thoseNot?.kind).toBe("replace");
        if (thoseNot?.kind === "replace") {
            expect(thoseNot.removeName).toBe("hot dogs");
            expect(thoseNot.items[0]?.name).toBe("bratwurst");
        }

        const itWas = parseDraftAddTextDeterministic("it was bratwurst");
        expect(itWas?.kind).toBe("replace");
        if (itWas?.kind === "replace") {
            expect(itWas.removeName).toBeNull();
            expect(itWas.items[0]?.name).toBe("bratwurst");
        }

        const thoseAre = parseDraftAddTextDeterministic("those are bratwurst");
        expect(thoseAre?.kind).toBe("replace");
        if (thoseAre?.kind === "replace") {
            expect(thoseAre.removeName).toBeNull();
            expect(thoseAre.items[0]?.name).toBe("bratwurst");
        }

        const actuallyOnly =
            parseDraftAddTextDeterministic("actually bratwurst");
        expect(actuallyOnly?.kind).toBe("replace");
        if (actuallyOnly?.kind === "replace") {
            expect(actuallyOnly.removeName).toBeNull();
            expect(actuallyOnly.items[0]?.name).toBe("bratwurst");
        }

        const commaNot = parseDraftAddTextDeterministic(
            "bratwurst, not hot dog",
        );
        expect(commaNot?.kind).toBe("replace");
        if (commaNot?.kind === "replace") {
            expect(commaNot.removeName).toBe("hot dog");
            expect(commaNot.items).toHaveLength(1);
            expect(commaNot.items[0]?.name).toBe("bratwurst");
        }

        // Preparation-only phrasing still returns null so P2 handles it.
        expect(parseDraftAddTextDeterministic("it was grilled")).toBeNull();
        // Arbitrary non-food prose still returns null for the model fallback.
        expect(
            parseDraftAddTextDeterministic("the weather is nice today"),
        ).toBeNull();
    });

    test("Ember fallback schema and prompt support explicit replacement intent, ambiguity, and draft portions", async () => {
        let body: Record<string, any> = {};
        const parsed = await parseDraftAddTextWithModel(
            "those are bratwurst",
            visionConfig,
            {
                fetcher: async (_url, init) => {
                    body = JSON.parse(String(init?.body ?? "{}"));
                    return new Response(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        content: JSON.stringify({
                                            items: [
                                                {
                                                    name: "bratwurst",
                                                    quantity: null,
                                                    unit: null,
                                                    assumptions: [],
                                                },
                                            ],
                                            replaces: "hot dog",
                                            is_replacement: true,
                                            preparation: null,
                                        }),
                                    },
                                },
                            ],
                        }),
                        {
                            status: 200,
                            headers: { "content-type": "application/json" },
                        },
                    );
                },
            },
            {
                items: [
                    {
                        name: "hot dog",
                        cookingMethod: "grilled",
                        quantity: 2,
                        portionLabel: "2 piece",
                    },
                    {
                        name: "mustard sauce",
                        cookingMethod: null,
                        quantity: 1,
                        portionLabel: "1 tbsp",
                    },
                ],
            },
        );
        expect(parsed.isReplacement).toBe(true);
        expect(parsed.replaces).toBe("hot dog");
        expect(JSON.stringify(draftAddParseJsonSchema)).toContain(
            "is_replacement",
        );
        const promptText = String(body.messages?.[1]?.content ?? "");
        expect(promptText.toLowerCase()).toContain("is_replacement");
        expect(promptText).toContain("2 piece");
    });

    test("ambiguous explicit target produces a draft question — no guess and no append", async () => {
        const twoHotDogs = makePhotoDraft([
            {
                id: "item-1",
                name: "beef hot dog",
                quantity: 1,
                portionLabel: "1 piece",
                calories: 180,
            },
            {
                id: "item-2",
                name: "chicken hot dog",
                quantity: 1,
                portionLabel: "1 piece",
                calories: 140,
            },
        ]);
        const { store } = createMemoryDraftStore(twoHotDogs);
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: twoHotDogs,
            text: "actually bratwurst, not hot dog",
            deps: { search: fixtureSearch, store },
        });
        expect(outcome.status).toBe("question");
        expect(outcome.draft.items.map((r) => r.item.name)).toEqual([
            "beef hot dog",
            "chicken hot dog",
        ]);
        expect(outcome.draft.questions).toHaveLength(1);
        expect(outcome.draft.questions[0]?.prompt).toContain("beef hot dog");
        expect(outcome.draft.questions[0]?.prompt).toContain("chicken hot dog");
    });

    test("ambiguous implicit target (model signals is_replacement=true, replaces=null) produces a draft question", async () => {
        const twoMeats = makePhotoDraft([
            {
                id: "item-1",
                name: "chicken breast",
                quantity: 150,
                portionLabel: "150 g",
                calories: 248,
                gramWeight: 150,
            },
            {
                id: "item-2",
                name: "turkey breast",
                quantity: 150,
                portionLabel: "150 g",
                calories: 210,
                gramWeight: 150,
            },
        ]);
        const { store } = createMemoryDraftStore(twoMeats);
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: twoMeats,
            text: "it was pork",
            deps: {
                search: fixtureSearch,
                store,
                parseWithModel: async () =>
                    parsedItemsFromModelParse({
                        items: [
                            {
                                name: "pork",
                                quantity: null,
                                unit: null,
                                assumptions: [],
                            },
                        ],
                        replaces: null,
                        is_replacement: true,
                        preparation: null,
                    }),
            },
        });
        expect(outcome.status).toBe("question");
        expect(outcome.draft.items).toHaveLength(2);
        expect(outcome.draft.questions).toHaveLength(1);
    });

    test("unmatched replacement target ('not pizza') asks a question instead of silently appending", async () => {
        const { store } = createMemoryDraftStore(incidentDraft());
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: incidentDraft(),
            text: "actually bratwurst, not pizza",
            deps: { search: fixtureSearch, store },
        });
        expect(outcome.status).toBe("question");
        expect(outcome.draft.items.map((r) => r.item.name)).toEqual([
            "hot dog",
            "mustard sauce",
        ]);
    });

    test("fail-open: if model fails on an implicit correction over multiple items, asks a question and never loses items", async () => {
        const { store } = createMemoryDraftStore(incidentDraft());
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: incidentDraft(),
            text: "it was bratwurst",
            deps: {
                search: fixtureSearch,
                store,
                parseWithModel: async () => {
                    throw new Error("provider outage");
                },
            },
        });
        expect(outcome.status).toBe("question");
        expect(outcome.draft.items.map((r) => r.item.name)).toEqual([
            "hot dog",
            "mustard sauce",
        ]);
    });

    test("generic token 'hot' in 'hot sauce' never steals a 'hot dog' replacement", async () => {
        const hotSauceFirst = makePhotoDraft([
            {
                id: "item-sauce",
                name: "hot sauce",
                quantity: 1,
                portionLabel: "1 tbsp",
                calories: 5,
            },
            {
                id: "item-dog",
                name: "hot dog",
                quantity: 2,
                portionLabel: "2 piece",
                calories: 700,
            },
        ]);
        const { store } = createMemoryDraftStore(hotSauceFirst);
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: hotSauceFirst,
            text: "actually bratwurst, not hot dog",
            deps: { search: fixtureSearch, store },
        });
        expect(outcome.status).toBe("added");
        if (outcome.status !== "added") return;
        expect(outcome.replacedItemName).toBe("hot dog");
        expect(outcome.draft.items.map((r) => r.item.name)).toEqual([
            "hot sauce",
            "Bratwurst, pork, cooked",
        ]);
    });

    test("duplicate guard: adding a food closely matching an existing draft item asks instead of appending", async () => {
        const existingBrat = makePhotoDraft([
            {
                id: "item-brat",
                name: "Bratwurst, pork, cooked",
                quantity: 2,
                portionLabel: "2 piece",
                calories: 566,
            },
            {
                id: "item-mustard",
                name: "mustard sauce",
                quantity: 1,
                portionLabel: "1 tbsp",
                calories: 45,
            },
        ]);
        const { store } = createMemoryDraftStore(existingBrat);
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: existingBrat,
            text: "bratwurst",
            deps: { search: fixtureSearch, store },
        });
        expect(outcome.status).toBe("question");
        expect(outcome.draft.items).toHaveLength(2);
        expect(outcome.draft.questions).toHaveLength(1);
        expect(outcome.draft.questions[0]?.prompt).toContain(
            "Bratwurst, pork, cooked",
        );
    });

    test("duplicate guard allows explicit 'another'/'more' adds and does not false-positive on peanut butter vs butter", async () => {
        const pbDraft = makePhotoDraft([
            {
                id: "item-pb",
                name: "peanut butter",
                quantity: 2,
                portionLabel: "2 tbsp",
                calories: 190,
            },
        ]);
        const { store: pbStore } = createMemoryDraftStore(pbDraft);
        const pbOutcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: pbDraft,
            text: "I added butter",
            deps: { search: fixtureSearch, store: pbStore },
        });
        expect(pbOutcome.status).toBe("added");
        expect(pbOutcome.draft.items).toHaveLength(2);

        const anotherDraft = makePhotoDraft([
            {
                id: "item-dog",
                name: "Hot dog, beef",
                quantity: 1,
                portionLabel: "1 piece",
                calories: 180,
            },
        ]);
        const { store: anotherStore } = createMemoryDraftStore(anotherDraft);
        const anotherOutcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: anotherDraft,
            text: "another hot dog",
            deps: { search: fixtureSearch, store: anotherStore },
        });
        expect(anotherOutcome.status).toBe("added");
        expect(anotherOutcome.draft.items).toHaveLength(2);
    });
});

describe("Defect 2 — visible buns are accounted for in vision prompt and count grounding", () => {
    test("vision prompt explicitly instructs enumerating bread/buns/rolls and accompaniments separately", async () => {
        let promptText = "";
        await identifyMealPhoto(
            { mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) },
            visionConfig,
            {
                fetcher: async (_url, init) => {
                    const body = JSON.parse(String(init?.body ?? "{}"));
                    promptText = String(
                        body.messages?.[1]?.content?.[0]?.text ?? "",
                    );
                    return new Response(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        content: JSON.stringify({
                                            items: [
                                                {
                                                    name: "bratwurst",
                                                    cooking_method: "grilled",
                                                    quantity: 2,
                                                    unit: "piece",
                                                    portion_confidence: 0.85,
                                                    assumptions: [],
                                                },
                                                {
                                                    name: "hot dog bun",
                                                    cooking_method: null,
                                                    quantity: 2,
                                                    unit: "piece",
                                                    portion_confidence: 0.85,
                                                    assumptions: [],
                                                },
                                            ],
                                        }),
                                    },
                                },
                            ],
                        }),
                        {
                            status: 200,
                            headers: { "content-type": "application/json" },
                        },
                    );
                },
            },
        );
        expect(promptText.toLowerCase()).toMatch(/\bbuns?\b/);
        expect(promptText.toLowerCase()).toMatch(/\bbread\b/);
        expect(promptText.toLowerCase()).toContain("separate items");
    });

    test("sausage-in-bun grounding resolves both bratwurst (1 link) and hot dog bun (1 bun) at count=2", async () => {
        const visionItems: MealPhotoVisionItem[] = [
            {
                name: "bratwurst",
                cooking_method: "grilled",
                quantity: 2,
                unit: "piece",
                portion_confidence: 0.85,
                assumptions: [],
            },
            {
                name: "hot dog bun",
                cooking_method: null,
                quantity: 2,
                unit: "piece",
                portion_confidence: 0.85,
                assumptions: [],
            },
            {
                name: "mustard sauce",
                cooking_method: null,
                quantity: 1,
                unit: "tbsp",
                portion_confidence: 0.85,
                assumptions: [],
            },
        ];
        const grounded = await groundMealPhotoItems(visionItems, {
            search: fixtureSearch,
        });
        expect(grounded).toHaveLength(3);
        const [brat, bun, mustard] = grounded;
        expect(brat?.grounded).toBe(true);
        expect(brat?.draftItem.quantity).toBe(2);
        expect(brat?.draftItem.gramWeight).toBe(170);
        expect(brat?.draftItem.nutrients.calories).toBe(566);

        expect(bun?.grounded).toBe(true);
        expect(bun?.draftItem.quantity).toBe(2);
        expect(bun?.draftItem.gramWeight).toBe(86);
        expect(bun?.draftItem.nutrients.calories).toBe(240);

        expect(mustard?.grounded).toBe(true);
        expect(mustard?.draftItem.nutrients.calories).toBe(10);
        for (const item of grounded) {
            expect(mealPhotoItemIsComplete(item)).toBe(true);
        }
    });

    test("partially obscured bun with low portion_confidence lands in the draft WITH a draft question instead of vanishing", async () => {
        const visionItems: MealPhotoVisionItem[] = [
            {
                name: "bratwurst",
                cooking_method: "grilled",
                quantity: 2,
                unit: "piece",
                portion_confidence: 0.85,
                assumptions: [],
            },
            {
                name: "hot dog bun",
                cooking_method: null,
                quantity: 2,
                unit: "piece",
                portion_confidence: 0.55,
                assumptions: ["buns partially obscured under sausages"],
            },
        ];
        const grounded = await groundMealPhotoItems(visionItems, {
            search: fixtureSearch,
        });
        const bun = grounded[1]!;
        expect(bun.grounded).toBe(true);
        expect(bun.draftItem.nutrients.calories).toBe(240);
        expect(bun.needsQuestion).toBe(true);
        expect(bun.question?.prompt).toContain("hot dog bun");
    });
});

describe("Defect 3 — quantity carries over a correction (and explicit override wins)", () => {
    const incidentContext = [
        {
            name: "hot dog",
            cookingMethod: "grilled",
            quantity: 2,
            portionLabel: "2 piece",
        },
        {
            name: "mustard sauce",
            cookingMethod: null,
            quantity: 1,
            portionLabel: "1 tbsp",
        },
    ];

    test("replacing hot dog × 2 piece with 'actually bratwurst, not hot dog' carries over 2 piece", async () => {
        const resolution = await resolveDraftAdd(
            "actually bratwurst, not hot dog",
            { search: fixtureSearch },
            incidentContext,
        );
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        expect(resolution.removeName).toBe("hot dog");
        const [brat] = resolution.grounded;
        expect(brat?.grounded).toBe(true);
        expect(brat?.draftItem.quantity).toBe(2);
        expect(brat?.draftItem.portionLabel).toBe("2 piece");
        expect(brat?.draftItem.gramWeight).toBe(170);
        expect(brat?.draftItem.nutrients.calories).toBe(566);
    });

    test("user-edited quantity (e.g. edited from 2 to 3) survives a correction", async () => {
        const resolution = await resolveDraftAdd(
            "actually bratwurst, not hot dog",
            { search: fixtureSearch },
            [
                {
                    name: "hot dog",
                    cookingMethod: "grilled",
                    quantity: 3,
                    portionLabel: "2 piece",
                },
                incidentContext[1]!,
            ],
        );
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        const [brat] = resolution.grounded;
        expect(brat?.draftItem.quantity).toBe(3);
        expect(brat?.draftItem.portionLabel).toBe("3 piece");
        expect(brat?.draftItem.gramWeight).toBe(255);
        expect(brat?.draftItem.nutrients.calories).toBe(849);
    });

    test("single-item draft implicit correction ('it was bratwurst') resolves deterministically and carries over 2 piece", async () => {
        let modelCalls = 0;
        const resolution = await resolveDraftAdd(
            "it was bratwurst",
            {
                search: fixtureSearch,
                parseWithModel: async () => {
                    modelCalls += 1;
                    throw new Error("single-item draft needs no model call");
                },
            },
            [incidentContext[0]!],
        );
        expect(modelCalls).toBe(0);
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        expect(resolution.removeName).toBe("hot dog");
        expect(resolution.grounded[0]?.draftItem.quantity).toBe(2);
        expect(resolution.grounded[0]?.draftItem.nutrients.calories).toBe(566);
    });

    test("explicit count in correction ('actually just one bratwurst, not hot dog') wins over 2 piece and keeps count unit", async () => {
        const resolution = await resolveDraftAdd(
            "actually just one bratwurst, not hot dog",
            { search: fixtureSearch },
            incidentContext,
        );
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        expect(resolution.removeName).toBe("hot dog");
        const [brat] = resolution.grounded;
        expect(brat?.grounded).toBe(true);
        expect(brat?.draftItem.quantity).toBe(1);
        expect(brat?.draftItem.portionLabel).toBe("1 piece");
        expect(brat?.draftItem.gramWeight).toBe(85);
        expect(brat?.draftItem.nutrients.calories).toBe(283);
    });

    test("explicit weight in correction ('200 g bratwurst instead of hot dog') wins over carried-over 2 piece", async () => {
        const resolution = await resolveDraftAdd(
            "200 g bratwurst instead of hot dog",
            { search: fixtureSearch },
            incidentContext,
        );
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        const [brat] = resolution.grounded;
        expect(brat?.grounded).toBe(true);
        expect(brat?.draftItem.quantity).toBe(200);
        expect(brat?.draftItem.portionLabel).toBe("200 g");
        expect(brat?.draftItem.gramWeight).toBe(200);
        expect(brat?.draftItem.nutrients.calories).toBe(666);
    });
});
