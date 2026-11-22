import { describe, expect, test } from "bun:test";
import {
    DRAFT_ADD_PARSE_PROMPT,
    draftAddParseJsonSchema,
    parseDraftAddTextWithModel,
    parsedItemsFromModelParse,
} from "./draft-add-parse.js";
import type { MealPhotoVisionConfig } from "./vision.js";

const config: MealPhotoVisionConfig = {
    apiKey: "test-key",
    model: "meta/muse-ember",
    baseUrl: "https://example.test/v1",
    timeoutMs: 1_000,
};

function envelope(content: string) {
    return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

const butterReply = JSON.stringify({
    action: "add",
    target_item_id: null,
    items: [
        {
            name: "butter",
            quantity: 1,
            unit: "tbsp",
            assumptions: ['"a decent knob" interpreted as 1 tbsp'],
        },
    ],
    preparation: null,
    question_prompt: null,
});

describe("parseDraftAddTextWithModel", () => {
    test("one call: temp 0, strict 5-key schema with NO nutrient fields, healing plugin, full draft context", async () => {
        let calls = 0;
        let body: Record<string, any> = {};
        const result = await parseDraftAddTextWithModel(
            "oh I totally forgot the butter, like a decent knob of it",
            config,
            {
                fetcher: async (_url, init) => {
                    calls += 1;
                    body = JSON.parse(String(init?.body ?? "{}"));
                    return envelope(butterReply);
                },
            },
            {
                items: [
                    {
                        id: "item-1",
                        name: "Chicken breast, grilled",
                        visionName: "grilled chicken breast",
                        cookingMethod: "grilled",
                        quantity: 160,
                        portionLabel: "160 g",
                    },
                ],
            },
        );
        expect(calls).toBe(1);
        expect(result.action).toBe("add");
        expect(result.targetItemId).toBeNull();
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
            name: "butter",
            quantity: 1,
            unit: "tbsp",
            strongSignal: true,
        });
        expect(body.temperature).toBe(0);
        expect(body.response_format?.json_schema?.strict).toBe(true);
        expect(body.response_format?.json_schema?.name).toBe(
            "munch_meal_photo_draft_add_parse",
        );
        expect(body.plugins).toEqual([{ id: "response-healing" }]);
        expect(body.provider).toEqual({ data_collection: "deny" });
        const schemaText = JSON.stringify(draftAddParseJsonSchema);
        expect(schemaText).not.toContain("calories");
        expect(schemaText).not.toContain("protein");
        expect(draftAddParseJsonSchema.required).toEqual([
            "action",
            "target_item_id",
            "items",
            "preparation",
            "question_prompt",
        ]);
        const userMessage = String(body.messages?.[1]?.content ?? "");
        expect(userMessage).toContain('"id":"item-1"');
        expect(userMessage).toContain('"vision_name":"grilled chicken breast"');
        expect(userMessage).toContain('"portion_label":"160 g"');
    });

    test("action=none with empty items is a valid honest answer (no food stated)", async () => {
        const result = await parseDraftAddTextWithModel(
            "the weather is nice today",
            config,
            {
                fetcher: async () =>
                    envelope(
                        JSON.stringify({
                            action: "none",
                            target_item_id: null,
                            items: [],
                            preparation: null,
                            question_prompt: null,
                        }),
                    ),
            },
        );
        expect(result.action).toBe("none");
        expect(result.items).toEqual([]);
        expect(result.targetItemId).toBeNull();
    });

    test("action=replace, action=remove, and action=question pass through validated fields", async () => {
        const replaceResult = await parseDraftAddTextWithModel(
            "turns out they were brats",
            config,
            {
                fetcher: async () =>
                    envelope(
                        JSON.stringify({
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
                    ),
            },
        );
        expect(replaceResult.action).toBe("replace");
        expect(replaceResult.targetItemId).toBe("item-hotdog");
        expect(replaceResult.items[0]?.name).toBe("bratwurst");
        expect(replaceResult.items[0]?.strongSignal).toBe(false);

        const removeResult = await parseDraftAddTextWithModel(
            "skip the mustard",
            config,
            {
                fetcher: async () =>
                    envelope(
                        JSON.stringify({
                            action: "remove",
                            target_item_id: "item-mustard",
                            items: [],
                            preparation: null,
                            question_prompt: null,
                        }),
                    ),
            },
        );
        expect(removeResult.action).toBe("remove");
        expect(removeResult.targetItemId).toBe("item-mustard");
        expect(removeResult.items).toEqual([]);

        const questionResult = await parseDraftAddTextWithModel(
            "it was pork",
            config,
            {
                fetcher: async () =>
                    envelope(
                        JSON.stringify({
                            action: "question",
                            target_item_id: null,
                            items: [],
                            preparation: null,
                            question_prompt:
                                "Did you mean to replace the chicken breast or the turkey breast with pork?",
                        }),
                    ),
            },
        );
        expect(questionResult.action).toBe("question");
        expect(questionResult.questionPrompt).toContain("chicken breast");
    });

    test("prompt discipline: teaches the task without enumerating correction phrasings", () => {
        const lower = DRAFT_ADD_PARSE_PROMPT.toLowerCase();
        expect(lower).toContain('"replace"');
        expect(lower).toContain('"remove"');
        expect(lower).toContain('"question"');
        expect(lower).toContain("target_item_id");
        // No hardcoded phrasing catalog for bratwurst/hot dog corrections.
        expect(lower).not.toContain("bratwurst");
        expect(lower).not.toContain("hot dog");
    });

    test("a response carrying nutrition fields fails the strict schema and is retried once, then throws", async () => {
        let calls = 0;
        await expect(
            parseDraftAddTextWithModel("2 eggs and stuff", config, {
                fetcher: async () => {
                    calls += 1;
                    return envelope(
                        JSON.stringify({
                            action: "add",
                            target_item_id: null,
                            items: [
                                {
                                    name: "egg",
                                    quantity: 2,
                                    unit: "piece",
                                    assumptions: [],
                                    calories: 140,
                                },
                            ],
                            preparation: null,
                            question_prompt: null,
                        }),
                    );
                },
            }),
        ).rejects.toThrow();
        expect(calls).toBe(2);
    });

    test("retries once on unparseable output, then succeeds; HTTP failures are not retried", async () => {
        let calls = 0;
        const result = await parseDraftAddTextWithModel("butter note", config, {
            fetcher: async () => {
                calls += 1;
                return envelope(calls === 1 ? "not json" : butterReply);
            },
        });
        expect(calls).toBe(2);
        expect(result.items[0]?.name).toBe("butter");

        let httpCalls = 0;
        await expect(
            parseDraftAddTextWithModel("butter note", config, {
                fetcher: async () => {
                    httpCalls += 1;
                    return new Response("nope", { status: 503 });
                },
            }),
        ).rejects.toThrow("HTTP 503");
        expect(httpCalls).toBe(1);
    });
});

describe("parseDraftAddTextWithModel — preparation statements (photo-flow P2)", () => {
    test("'i deep fried it' returns a preparation correction addressed by item id plus the implied oil", async () => {
        let body: Record<string, any> = {};
        const result = await parseDraftAddTextWithModel(
            "i deep fried it",
            config,
            {
                fetcher: async (_url, init) => {
                    body = JSON.parse(String(init?.body ?? "{}"));
                    return envelope(
                        JSON.stringify({
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
                        }),
                    );
                },
            },
            {
                items: [
                    {
                        id: "item-corn",
                        name: "Corn On The Cob",
                        cookingMethod: "steamed",
                    },
                ],
            },
        );
        expect(result.preparation).toEqual({
            targetItemId: "item-corn",
            cookingMethod: "deep fried",
        });
        expect(result.items[0]).toMatchObject({
            name: "vegetable oil",
            quantity: 1,
            unit: "tbsp",
            strongSignal: true,
        });
        expect(JSON.stringify(body.messages)).toContain("item-corn");
        expect(JSON.stringify(body.messages)).toContain("Corn On The Cob");
    });

    test("a pure method correction returns action=none, preparation, and empty items", async () => {
        const result = await parseDraftAddTextWithModel(
            "grilled instead",
            config,
            {
                fetcher: async () =>
                    envelope(
                        JSON.stringify({
                            action: "none",
                            target_item_id: null,
                            items: [],
                            preparation: {
                                target_item_id: "item-chicken",
                                cooking_method: "grilled",
                            },
                            question_prompt: null,
                        }),
                    ),
            },
            {
                items: [
                    {
                        id: "item-chicken",
                        name: "Chicken breast",
                        cookingMethod: "baked",
                    },
                ],
            },
        );
        expect(result.action).toBe("none");
        expect(result.items).toEqual([]);
        expect(result.preparation).toEqual({
            targetItemId: "item-chicken",
            cookingMethod: "grilled",
        });
    });
});

describe("parsedItemsFromModelParse", () => {
    test("quantity-less model items get the stated default-portion assumption", () => {
        const result = parsedItemsFromModelParse({
            action: "add",
            target_item_id: null,
            items: [
                { name: "butter", quantity: null, unit: null, assumptions: [] },
            ],
            preparation: null,
            question_prompt: null,
        });
        expect(result.items[0]).toMatchObject({
            name: "butter",
            quantity: 1,
            unit: "tbsp",
            quantityAssumed: true,
            strongSignal: false,
            unitAssumed: true,
        });
        expect(result.items[0]?.assumptions[0]).toContain("default portion");
    });

    test("normalizes extracted unit aliases ('tablespoons' → 'tbsp') and passes target_item_id trimmed", () => {
        const result = parsedItemsFromModelParse({
            action: "replace",
            target_item_id: " item-rice ",
            items: [
                {
                    name: "brown rice",
                    quantity: 2,
                    unit: "tablespoons",
                    assumptions: [],
                },
            ],
            preparation: null,
            question_prompt: null,
        });
        expect(result.targetItemId).toBe("item-rice");
        expect(result.items[0]?.unit).toBe("tbsp");
        expect(result.items[0]?.unitAssumed).toBe(false);
    });
});
