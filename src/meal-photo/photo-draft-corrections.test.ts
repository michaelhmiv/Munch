import { describe, expect, test } from "bun:test";
import type { FoodCandidate } from "../food-providers/types.js";
import type { MealDraft } from "../meal-drafts/types.js";
import {
    parseDraftAddTextWithModel,
    type DraftAddModelParse,
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
 * End-to-end behavior tests for the 2026-11-22 photo-draft revision
 * (model-first architecture: Ember interprets, code guarantees).
 *
 * Every note flows through the REAL `parseDraftAddTextWithModel`
 * (strict JSON schema + zod validation + full draft-item context) with
 * a scripted fake OpenRouter `fetcher`, then through `resolveDraftAdd`
 * / `addTextToPhotoDraft` and `groundMealPhotoItems`.
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

const fixtureSearch: DraftAddDeps["search"] = async (query) => {
    const q = query.toLowerCase();
    if (q.includes("bratwurst")) {
        return { candidates: [bratwurstCandidate], failures: [] };
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
    return { candidates: [], failures: [] };
};

const visionConfig: MealPhotoVisionConfig = {
    apiKey: "test-key",
    model: "meta/muse-ember",
    baseUrl: "https://example.test/v1",
    timeoutMs: 1_000,
};

function emberInterpreter(
    reply: DraftAddModelParse,
    onRequest?: (body: Record<string, any>) => void,
): DraftAddDeps["parseWithModel"] {
    return (text, context) =>
        parseDraftAddTextWithModel(
            text,
            visionConfig,
            {
                fetcher: async (_url, init) => {
                    const body = JSON.parse(String(init?.body ?? "{}"));
                    onRequest?.(body);
                    return new Response(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        content: JSON.stringify(reply),
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
            context,
        );
}

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
        provider?: "usda" | "open_food_facts";
        providerFoodId?: string;
        candidateId?: string;
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
                sourceType: entry.provider ?? "usda",
                provider: entry.provider ?? "usda",
                ...(entry.providerFoodId
                    ? { providerFoodId: entry.providerFoodId }
                    : {}),
                confidence: 0.85,
                assumptions: [],
                sourceSnapshot: {
                    resolution_layer: "meal_photo_grounding",
                    vision_name: entry.visionName ?? entry.name,
                    cooking_method: entry.cookingMethod ?? null,
                    ...(entry.candidateId
                        ? { candidate_id: entry.candidateId }
                        : {}),
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
                visionName: "hot dog",
                quantity: 2,
                portionLabel: "2 piece",
                calories: 700,
                cookingMethod: "grilled",
                providerFoodId: "174589",
                candidateId: "usda:174589",
            },
            {
                id: "item-mustard",
                name: "mustard sauce",
                visionName: "mustard sauce",
                quantity: 1,
                portionLabel: "1 tbsp",
                calories: 45,
                providerFoodId: "172234",
                candidateId: "usda:172234",
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

describe("Incident replay (2026-11-22) — model interprets, code guarantees", () => {
    for (const phrasing of [
        "actually bratwurst, not hot dog",
        "those are bratwurst",
        "it was bratwurst",
        "turns out they were brats",
        "my bad, the sausages were bratwurst",
    ]) {
        test(`"${phrasing}" flows through Ember with full draft context, replaces hot dog IN PLACE with bratwurst ×2, cascades old question, and recomputes totals`, async () => {
            const { store } = createMemoryDraftStore(incidentDraft());
            let capturedBody: Record<string, any> = {};
            const outcome = await addTextToPhotoDraft({
                userId: "user-1",
                draft: incidentDraft(),
                text: phrasing,
                deps: {
                    search: fixtureSearch,
                    store,
                    parseWithModel: emberInterpreter(
                        {
                            action: "replace",
                            target_item_id: "item-hotdog",
                            items: [
                                {
                                    name: "bratwurst",
                                    quantity: null,
                                    unit: null,
                                    assumptions: [],
                                },
                            ],
                            preparation: null,
                            question_prompt: null,
                        },
                        (body) => {
                            capturedBody = body;
                        },
                    ),
                },
            });

            // Every note hits Ember with every draft item's id, name, vision_name, quantity, portion_label.
            const promptPayload = String(
                capturedBody.messages?.[1]?.content ?? "",
            );
            expect(promptPayload).toContain('"id":"item-hotdog"');
            expect(promptPayload).toContain('"id":"item-mustard"');
            expect(promptPayload).toContain('"portion_label":"2 piece"');

            expect(outcome.status).toBe("added");
            if (outcome.status !== "added") return;
            expect(outcome.parseSource).toBe("model");
            expect(outcome.replacedItemName).toBe("hot dog");
            expect(outcome.message).toBe(
                "Replaced hot dog with Bratwurst, pork, cooked.",
            );
            // Final draft: bratwurst ×2 in position 0, mustard in position 1; NO hot dog.
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

    test("add still adds: 'I added a good bit of butter' appends butter with stated assumption, touching nothing else", async () => {
        const { store } = createMemoryDraftStore(incidentDraft());
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: incidentDraft(),
            text: "I added a good bit of butter",
            deps: {
                search: fixtureSearch,
                store,
                parseWithModel: emberInterpreter({
                    action: "add",
                    target_item_id: null,
                    items: [
                        {
                            name: "butter",
                            quantity: 1,
                            unit: "tbsp",
                            assumptions: ['"a good bit" interpreted as 1 tbsp'],
                        },
                    ],
                    preparation: null,
                    question_prompt: null,
                }),
            },
        });
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

    test("remove action: 'skip the mustard' removes the addressed item and recomputes totals", async () => {
        const { store } = createMemoryDraftStore(incidentDraft());
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: incidentDraft(),
            text: "skip the mustard",
            deps: {
                search: fixtureSearch,
                store,
                parseWithModel: emberInterpreter({
                    action: "remove",
                    target_item_id: "item-mustard",
                    items: [],
                    preparation: null,
                    question_prompt: null,
                }),
            },
        });
        expect(outcome.status).toBe("updated");
        if (outcome.status !== "updated") return;
        expect(outcome.removedItemName).toBe("mustard sauce");
        expect(outcome.message).toBe("Removed mustard sauce from the draft.");
        expect(outcome.draft.items.map((r) => r.item.name)).toEqual([
            "hot dog",
        ]);
        expect(totalCalories(outcome.draft)).toBe(700);
    });
});

describe("Code guarantees — target ID validation, ambiguity, duplicate guard, fail-open", () => {
    test("model-declared ambiguity (action='question') persists a draft question with zero mutation", async () => {
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
                parseWithModel: emberInterpreter({
                    action: "question",
                    target_item_id: null,
                    items: [],
                    preparation: null,
                    question_prompt:
                        "Did you mean to replace the chicken breast or the turkey breast with pork?",
                }),
            },
        });
        expect(outcome.status).toBe("question");
        expect(outcome.draft.items.map((r) => r.item.name)).toEqual([
            "chicken breast",
            "turkey breast",
        ]);
        expect(outcome.draft.questions).toHaveLength(1);
        expect(outcome.draft.questions[0]?.prompt).toContain("chicken breast");
    });

    test("unresolvable or invented target_item_id on replace or remove becomes a draft question — never guesses, never appends, never deletes", async () => {
        const { store: replaceStore } = createMemoryDraftStore(incidentDraft());
        const badReplace = await addTextToPhotoDraft({
            userId: "user-1",
            draft: incidentDraft(),
            text: "actually bratwurst, not pizza",
            deps: {
                search: fixtureSearch,
                store: replaceStore,
                parseWithModel: emberInterpreter({
                    action: "replace",
                    target_item_id: "item-hallucinated-id",
                    items: [
                        {
                            name: "bratwurst",
                            quantity: null,
                            unit: null,
                            assumptions: [],
                        },
                    ],
                    preparation: null,
                    question_prompt: null,
                }),
            },
        });
        expect(badReplace.status).toBe("question");
        expect(badReplace.draft.items.map((r) => r.item.name)).toEqual([
            "hot dog",
            "mustard sauce",
        ]);

        const { store: removeStore } = createMemoryDraftStore(incidentDraft());
        const badRemove = await addTextToPhotoDraft({
            userId: "user-1",
            draft: incidentDraft(),
            text: "drop the fries",
            deps: {
                search: fixtureSearch,
                store: removeStore,
                parseWithModel: emberInterpreter({
                    action: "remove",
                    target_item_id: "item-does-not-exist",
                    items: [],
                    preparation: null,
                    question_prompt: null,
                }),
            },
        });
        expect(badRemove.status).toBe("question");
        expect(badRemove.draft.items.map((r) => r.item.name)).toEqual([
            "hot dog",
            "mustard sauce",
        ]);
    });

    test("fail-open: HTTP failure or invalid model output leaves the draft byte-for-byte untouched", async () => {
        const initial = incidentDraft();
        const { store } = createMemoryDraftStore(initial);
        const httpOutage = await addTextToPhotoDraft({
            userId: "user-1",
            draft: initial,
            text: "it was bratwurst",
            deps: {
                search: fixtureSearch,
                store,
                parseWithModel: (text, context) =>
                    parseDraftAddTextWithModel(
                        text,
                        visionConfig,
                        {
                            fetcher: async () =>
                                new Response("service unavailable", {
                                    status: 503,
                                }),
                        },
                        context,
                    ),
            },
        });
        expect(httpOutage.status).toBe("no_add");
        expect(httpOutage.draft).toEqual(initial);

        const invalidJson = await addTextToPhotoDraft({
            userId: "user-1",
            draft: initial,
            text: "it was bratwurst",
            deps: {
                search: fixtureSearch,
                store,
                parseWithModel: (text, context) =>
                    parseDraftAddTextWithModel(
                        text,
                        visionConfig,
                        {
                            fetcher: async () =>
                                new Response(
                                    JSON.stringify({
                                        choices: [
                                            {
                                                message: {
                                                    content: "not valid json",
                                                },
                                            },
                                        ],
                                    }),
                                    { status: 200 },
                                ),
                        },
                        context,
                    ),
            },
        });
        expect(invalidJson.status).toBe("no_add");
        expect(invalidJson.draft).toEqual(initial);
    });

    test("grounded-identity duplicate guard: an add that resolves to the same grounded food already in the draft asks instead of appending", async () => {
        const existingBrat = makePhotoDraft([
            {
                id: "item-brat",
                name: "Bratwurst, pork, cooked",
                quantity: 2,
                portionLabel: "2 piece",
                calories: 566,
                provider: "usda",
                providerFoodId: "174591",
                candidateId: "usda:174591",
            },
            {
                id: "item-mustard",
                name: "mustard sauce",
                quantity: 1,
                portionLabel: "1 tbsp",
                calories: 45,
                provider: "usda",
                providerFoodId: "172234",
                candidateId: "usda:172234",
            },
        ]);
        const { store } = createMemoryDraftStore(existingBrat);
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: existingBrat,
            text: "bratwurst",
            deps: {
                search: fixtureSearch,
                store,
                parseWithModel: emberInterpreter({
                    action: "add",
                    target_item_id: null,
                    items: [
                        {
                            name: "bratwurst",
                            quantity: null,
                            unit: null,
                            assumptions: [],
                        },
                    ],
                    preparation: null,
                    question_prompt: null,
                }),
            },
        });
        expect(outcome.status).toBe("question");
        expect(outcome.draft.items).toHaveLength(2);
        expect(outcome.draft.questions).toHaveLength(1);
        expect(outcome.draft.questions[0]?.prompt).toContain(
            "Bratwurst, pork, cooked",
        );
    });

    test("grounded-identity duplicate guard does not false-positive on distinct foods like peanut butter vs butter", async () => {
        const pbDraft = makePhotoDraft([
            {
                id: "item-pb",
                name: "Peanut butter, smooth",
                quantity: 2,
                portionLabel: "2 tbsp",
                calories: 190,
                provider: "usda",
                providerFoodId: "172470",
                candidateId: "usda:172470",
            },
        ]);
        const { store } = createMemoryDraftStore(pbDraft);
        const outcome = await addTextToPhotoDraft({
            userId: "user-1",
            draft: pbDraft,
            text: "I added butter",
            deps: {
                search: fixtureSearch,
                store,
                parseWithModel: emberInterpreter({
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
            },
        });
        expect(outcome.status).toBe("added");
        expect(outcome.draft.items).toHaveLength(2);
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

describe("Defect 3 — quantity carries over a correction (and stated override wins)", () => {
    const incidentContext = [
        {
            id: "item-hotdog",
            name: "hot dog",
            visionName: "hot dog",
            cookingMethod: "grilled",
            quantity: 2,
            portionLabel: "2 piece",
        },
        {
            id: "item-mustard",
            name: "mustard sauce",
            visionName: "mustard sauce",
            cookingMethod: null,
            quantity: 1,
            portionLabel: "1 tbsp",
        },
    ];

    test("unstated quantity on replace carries over target's 2 piece", async () => {
        const resolution = await resolveDraftAdd(
            "those are bratwurst",
            {
                search: fixtureSearch,
                parseWithModel: emberInterpreter({
                    action: "replace",
                    target_item_id: "item-hotdog",
                    items: [
                        {
                            name: "bratwurst",
                            quantity: null,
                            unit: null,
                            assumptions: [],
                        },
                    ],
                    preparation: null,
                    question_prompt: null,
                }),
            },
            incidentContext,
        );
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        expect(resolution.targetItemId).toBe("item-hotdog");
        const [brat] = resolution.grounded;
        expect(brat?.grounded).toBe(true);
        expect(brat?.draftItem.quantity).toBe(2);
        expect(brat?.draftItem.portionLabel).toBe("2 piece");
        expect(brat?.draftItem.gramWeight).toBe(170);
        expect(brat?.draftItem.nutrients.calories).toBe(566);
    });

    test("user-edited quantity (edited from 2 to 3) survives a correction", async () => {
        const resolution = await resolveDraftAdd(
            "actually bratwurst",
            {
                search: fixtureSearch,
                parseWithModel: emberInterpreter({
                    action: "replace",
                    target_item_id: "item-hotdog",
                    items: [
                        {
                            name: "bratwurst",
                            quantity: null,
                            unit: null,
                            assumptions: [],
                        },
                    ],
                    preparation: null,
                    question_prompt: null,
                }),
            },
            [
                {
                    ...incidentContext[0]!,
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

    test("stated bare count ('just one bratwurst') wins over 2 piece and preserves count unit", async () => {
        const resolution = await resolveDraftAdd(
            "just one bratwurst",
            {
                search: fixtureSearch,
                parseWithModel: emberInterpreter({
                    action: "replace",
                    target_item_id: "item-hotdog",
                    items: [
                        {
                            name: "bratwurst",
                            quantity: 1,
                            unit: null,
                            assumptions: [],
                        },
                    ],
                    preparation: null,
                    question_prompt: null,
                }),
            },
            incidentContext,
        );
        expect(resolution.kind).toBe("ready");
        if (resolution.kind !== "ready") return;
        const [brat] = resolution.grounded;
        expect(brat?.grounded).toBe(true);
        expect(brat?.draftItem.quantity).toBe(1);
        expect(brat?.draftItem.portionLabel).toBe("1 piece");
        expect(brat?.draftItem.gramWeight).toBe(85);
        expect(brat?.draftItem.nutrients.calories).toBe(283);
    });

    test("stated explicit quantity + unit ('200 g bratwurst') wins completely", async () => {
        const resolution = await resolveDraftAdd(
            "200 g bratwurst instead",
            {
                search: fixtureSearch,
                parseWithModel: emberInterpreter({
                    action: "replace",
                    target_item_id: "item-hotdog",
                    items: [
                        {
                            name: "bratwurst",
                            quantity: 200,
                            unit: "g",
                            assumptions: [],
                        },
                    ],
                    preparation: null,
                    question_prompt: null,
                }),
            },
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
