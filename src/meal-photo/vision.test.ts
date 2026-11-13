import { describe, expect, test } from "bun:test";
import {
    chooseMealPhotoCandidates,
    identifyMealPhoto,
    identifyMealPhotoFromImages,
    mealPhotoVisionConfig,
    MealPhotoNoFoodError,
    MULTI_PHOTO_DEDUPE_INSTRUCTION,
    type MealPhotoVisionConfig,
} from "./vision.js";

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

const oneItem = JSON.stringify({
    items: [
        {
            name: "grilled chicken breast",
            cooking_method: "grilled",
            quantity: 160,
            unit: "g",
            portion_confidence: 0.85,
            assumptions: ["assumed skinless breast"],
        },
    ],
});

describe("meal photo vision config", () => {
    test("requires an OpenRouter key and honours the kill switch", () => {
        expect(mealPhotoVisionConfig({})).toBeNull();
        expect(
            mealPhotoVisionConfig({
                OPENROUTER_API_KEY: "k",
                MUNCH_MEAL_PHOTO_ENABLED: "false",
            }),
        ).toBeNull();
        expect(mealPhotoVisionConfig({ OPENROUTER_API_KEY: "k" })?.model).toBe(
            "meta/muse-ember",
        );
    });
});

describe("identifyMealPhoto", () => {
    test("sends the strict schema, healing plugin, temp 0, and no-nutrition instruction", async () => {
        let body: Record<string, any> = {};
        const result = await identifyMealPhoto(
            { mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) },
            config,
            {
                fetcher: async (_url, init) => {
                    body = JSON.parse(String(init?.body ?? "{}"));
                    return envelope(oneItem);
                },
            },
        );
        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.name).toBe("grilled chicken breast");
        expect(body.temperature).toBe(0);
        expect(body.response_format?.json_schema?.strict).toBe(true);
        expect(body.plugins).toEqual([{ id: "response-healing" }]);
        expect(body.provider).toEqual({ data_collection: "deny" });
        expect(JSON.stringify(body.response_format)).not.toMatch(/calories/);
    });

    test("rejects a response carrying nutrition numbers (strict schema)", async () => {
        const withNutrition = JSON.stringify({
            items: [
                {
                    name: "rice",
                    cooking_method: null,
                    quantity: 1,
                    unit: "cup",
                    portion_confidence: 0.8,
                    assumptions: [],
                    calories: 200,
                },
            ],
        });
        let calls = 0;
        await expect(
            identifyMealPhoto(
                { mimeType: "image/jpeg", bytes: new Uint8Array([1]) },
                config,
                {
                    fetcher: async () => {
                        calls += 1;
                        return envelope(withNutrition);
                    },
                },
            ),
        ).rejects.toThrow();
        expect(calls).toBe(2);
    });

    test("retries once on unparseable output, then succeeds", async () => {
        let calls = 0;
        const result = await identifyMealPhoto(
            { mimeType: "image/png", bytes: new Uint8Array([1]) },
            config,
            {
                fetcher: async () => {
                    calls += 1;
                    return envelope(calls === 1 ? "not json" : oneItem);
                },
            },
        );
        expect(calls).toBe(2);
        expect(result.items).toHaveLength(1);
    });

    test("empty items means no food (no draft, no charge upstream)", async () => {
        await expect(
            identifyMealPhoto(
                { mimeType: "image/jpeg", bytes: new Uint8Array([1]) },
                config,
                {
                    fetcher: async () =>
                        envelope(JSON.stringify({ items: [] })),
                },
            ),
        ).rejects.toBeInstanceOf(MealPhotoNoFoodError);
    });

    test("does not retry HTTP failures", async () => {
        let calls = 0;
        await expect(
            identifyMealPhoto(
                { mimeType: "image/jpeg", bytes: new Uint8Array([1]) },
                config,
                {
                    fetcher: async () => {
                        calls += 1;
                        return new Response("nope", { status: 401 });
                    },
                },
            ),
        ).rejects.toThrow("HTTP 401");
        expect(calls).toBe(1);
    });
});

describe("chooseMealPhotoCandidates", () => {
    test("discards hallucinated candidate IDs", async () => {
        const choices = await chooseMealPhotoCandidates(
            [
                {
                    key: "item:0",
                    itemName: "rice",
                    cookingMethod: null,
                    candidates: [
                        {
                            candidateId: "usda:1",
                            name: "Rice, cooked",
                            brand: null,
                            provider: "usda",
                        },
                    ],
                },
                {
                    key: "item:1",
                    itemName: "beans",
                    cookingMethod: null,
                    candidates: [
                        {
                            candidateId: "usda:2",
                            name: "Beans",
                            brand: null,
                            provider: "usda",
                        },
                    ],
                },
            ],
            config,
            {
                fetcher: async () =>
                    envelope(
                        JSON.stringify({
                            selections: [
                                {
                                    key: "item:0",
                                    candidate_id: "usda:999-invented",
                                    confidence: 0.9,
                                    rationale: null,
                                },
                                {
                                    key: "item:1",
                                    candidate_id: "usda:2",
                                    confidence: 0.9,
                                    rationale: "exact",
                                },
                            ],
                        }),
                    ),
            },
        );
        expect(choices.has("item:0")).toBe(false);
        expect(choices.get("item:1")?.candidateId).toBe("usda:2");
    });
});

describe("identifyMealPhotoFromImages (multi-photo, 2026-11-12)", () => {
    const photo = (byte: number) => ({
        mimeType: "image/jpeg",
        bytes: new Uint8Array([byte]),
    });

    test("one call carries every photo as its own image part, with the light dedupe instruction", async () => {
        let body: Record<string, any> = {};
        let calls = 0;
        const result = await identifyMealPhotoFromImages(
            [photo(1), photo(2), photo(3)],
            config,
            {
                fetcher: async (_url, init) => {
                    calls += 1;
                    body = JSON.parse(String(init?.body ?? "{}"));
                    return envelope(oneItem);
                },
            },
        );
        expect(result.items).toHaveLength(1);
        expect(calls).toBe(1);
        const content = body.messages?.[1]?.content as any[];
        expect(content[0]?.type).toBe("text");
        expect(content[0]?.text).toContain(MULTI_PHOTO_DEDUPE_INSTRUCTION);
        const images = content.filter((part) => part.type === "image_url");
        expect(images).toHaveLength(3);
        expect(String(images[0]?.image_url?.url)).toStartWith(
            "data:image/jpeg;base64,",
        );
    });

    test("a single photo keeps the un-steered prompt and one image part", async () => {
        let body: Record<string, any> = {};
        await identifyMealPhotoFromImages([photo(9)], config, {
            fetcher: async (_url, init) => {
                body = JSON.parse(String(init?.body ?? "{}"));
                return envelope(oneItem);
            },
        });
        const content = body.messages?.[1]?.content as any[];
        expect(content[0]?.text).not.toContain(MULTI_PHOTO_DEDUPE_INSTRUCTION);
        expect(
            content.filter((part) => part.type === "image_url"),
        ).toHaveLength(1);
    });

    test("the cap is enforced before any provider call", async () => {
        let calls = 0;
        await expect(
            identifyMealPhotoFromImages(
                [photo(1), photo(2), photo(3), photo(4)],
                config,
                {
                    fetcher: async () => {
                        calls += 1;
                        return envelope(oneItem);
                    },
                },
            ),
        ).rejects.toThrow("between 1 and 3");
        expect(calls).toBe(0);
        await expect(
            identifyMealPhotoFromImages([], config, {
                fetcher: async () => envelope(oneItem),
            }),
        ).rejects.toThrow("between 1 and 3");
    });
});

describe("fallback drill: meal-photo identify chain (model-integration brief)", () => {
    const chainConfig: MealPhotoVisionConfig = {
        ...config,
        models: [
            "meta/muse-ember",
            "openai/gpt-5.6-luna",
            "deepseek/deepseek-v4.1-flash-1017",
        ],
    };
    const photo = { mimeType: "image/jpeg", bytes: new Uint8Array([1]) };

    function modelOf(init?: RequestInit): string {
        return JSON.parse(String(init?.body ?? "{}")).model as string;
    }

    test("drill: primary HTTP 500s, retry also fails, Luna answers", async () => {
        const seen: string[] = [];
        const result = await identifyMealPhoto(photo, chainConfig, {
            fetcher: async (_url, init) => {
                const model = modelOf(init);
                seen.push(model);
                if (model === "meta/muse-ember") {
                    return new Response("down", { status: 500 });
                }
                return envelope(oneItem);
            },
        });
        expect(result.items).toHaveLength(1);
        expect(seen).toEqual([
            "meta/muse-ember",
            "meta/muse-ember",
            "openai/gpt-5.6-luna",
        ]);
    });

    test("drill: primary times out twice, Luna answers", async () => {
        const seen: string[] = [];
        const result = await identifyMealPhoto(photo, chainConfig, {
            fetcher: async (_url, init) => {
                const model = modelOf(init);
                seen.push(model);
                if (model === "meta/muse-ember") {
                    throw new Error("The operation was aborted");
                }
                return envelope(oneItem);
            },
        });
        expect(result.items).toHaveLength(1);
        expect(seen).toEqual([
            "meta/muse-ember",
            "meta/muse-ember",
            "openai/gpt-5.6-luna",
        ]);
    });

    test("drill: unparseable output walks the whole chain to DeepSeek", async () => {
        const seen: string[] = [];
        const result = await identifyMealPhoto(photo, chainConfig, {
            fetcher: async (_url, init) => {
                const model = modelOf(init);
                seen.push(model);
                if (model === "deepseek/deepseek-v4.1-flash-1017") {
                    return envelope(oneItem);
                }
                return envelope("not json at all");
            },
        });
        expect(result.items).toHaveLength(1);
        expect(seen).toEqual([
            "meta/muse-ember",
            "meta/muse-ember",
            "openai/gpt-5.6-luna",
            "openai/gpt-5.6-luna",
            "deepseek/deepseek-v4.1-flash-1017",
        ]);
    });

    test("drill: a parsed no-food answer never engages the chain", async () => {
        const seen: string[] = [];
        await expect(
            identifyMealPhoto(photo, chainConfig, {
                fetcher: async (_url, init) => {
                    seen.push(modelOf(init));
                    return envelope(JSON.stringify({ items: [] }));
                },
            }),
        ).rejects.toBeInstanceOf(MealPhotoNoFoodError);
        expect(seen).toEqual(["meta/muse-ember"]);
    });

    test("drill: whole chain down throws the exhausted-chain error", async () => {
        let calls = 0;
        await expect(
            identifyMealPhoto(photo, chainConfig, {
                fetcher: async () => {
                    calls += 1;
                    return new Response("down", { status: 503 });
                },
            }),
        ).rejects.toThrow("fallback chain");
        expect(calls).toBe(6);
    });

    test("config pin: designated chain order, env override, opt-out", () => {
        expect(
            mealPhotoVisionConfig({ OPENROUTER_API_KEY: "test" })?.models,
        ).toEqual([
            "meta/muse-ember",
            "openai/gpt-5.6-luna",
            "deepseek/deepseek-v4.1-flash-1017",
        ]);
        expect(
            mealPhotoVisionConfig({
                OPENROUTER_API_KEY: "test",
                MUNCH_MEAL_PHOTO_FALLBACK_MODELS: "custom/fallback",
            })?.models,
        ).toEqual(["meta/muse-ember", "custom/fallback"]);
        expect(
            mealPhotoVisionConfig({
                OPENROUTER_API_KEY: "test",
                MUNCH_MEAL_PHOTO_FALLBACK_MODELS: "",
            })?.models,
        ).toEqual(["meta/muse-ember"]);
        expect(
            mealPhotoVisionConfig({
                OPENROUTER_API_KEY: "test",
                MUNCH_AI_MODEL: "custom/primary",
            })?.models,
        ).toEqual([
            "custom/primary",
            "openai/gpt-5.6-luna",
            "deepseek/deepseek-v4.1-flash-1017",
        ]);
    });
});
