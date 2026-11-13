import { describe, expect, test } from "bun:test";
import { inventoryVisionConfig, previewInventoryImage } from "./vision.js";

const config = {
    apiKey: "test",
    model: "test-model",
    baseUrl: "https://example.test/v1",
    timeoutMs: 1000,
};

describe("inventory vision", () => {
    test("requires both an API key and explicit feature enablement", () => {
        expect(inventoryVisionConfig({})).toBeNull();
        expect(
            inventoryVisionConfig({ OPENROUTER_API_KEY: "test" }),
        ).toBeNull();
        expect(
            inventoryVisionConfig({
                OPENROUTER_API_KEY: "test",
                MUNCH_PANTRY_VISION_ENABLED: "true",
            })?.apiKey,
        ).toBe("test");
    });

    test("defaults to Ember and lets the shared model variable override it", () => {
        expect(
            inventoryVisionConfig({
                OPENROUTER_API_KEY: "test",
                MUNCH_PANTRY_VISION_ENABLED: "true",
            })?.model,
        ).toBe("meta/muse-ember");
        expect(
            inventoryVisionConfig({
                OPENROUTER_API_KEY: "test",
                MUNCH_PANTRY_VISION_ENABLED: "true",
                MUNCH_AI_MODEL: "custom/model",
            })?.model,
        ).toBe("custom/model");
    });

    test("sends the structured schema, healing plugin, and token cap", async () => {
        let requestBody: Record<string, any> = {};
        await previewInventoryImage(
            {
                mode: "receipt",
                mimeType: "image/jpeg",
                bytes: new Uint8Array([1]),
            },
            config,
            {
                fetcher: async (_url, init) => {
                    requestBody = JSON.parse(String(init?.body ?? "{}"));
                    return new Response(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        content: JSON.stringify({
                                            lines: [],
                                            notes: [],
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
        expect(requestBody.response_format?.type).toBe("json_schema");
        expect(requestBody.response_format?.json_schema?.strict).toBe(true);
        expect(requestBody.plugins).toEqual([{ id: "response-healing" }]);
        expect(requestBody.temperature).toBe(0);
        expect(requestBody.max_tokens).toBe(4000);
    });

    test("retries once on unparseable output, then succeeds", async () => {
        let calls = 0;
        const preview = await previewInventoryImage(
            {
                mode: "receipt",
                mimeType: "image/jpeg",
                bytes: new Uint8Array([1]),
            },
            config,
            {
                fetcher: async () => {
                    calls += 1;
                    const content =
                        calls === 1
                            ? "not json at all"
                            : JSON.stringify({ lines: [], notes: [] });
                    return new Response(
                        JSON.stringify({
                            choices: [{ message: { content } }],
                        }),
                        {
                            status: 200,
                            headers: { "content-type": "application/json" },
                        },
                    );
                },
            },
        );
        expect(calls).toBe(2);
        expect(preview.lines).toEqual([]);
    });

    test("fails after the single retry when output stays unparseable", async () => {
        let calls = 0;
        await expect(
            previewInventoryImage(
                {
                    mode: "receipt",
                    mimeType: "image/jpeg",
                    bytes: new Uint8Array([1]),
                },
                config,
                {
                    fetcher: async () => {
                        calls += 1;
                        return new Response(
                            JSON.stringify({
                                choices: [
                                    { message: { content: "still not json" } },
                                ],
                            }),
                            {
                                status: 200,
                                headers: {
                                    "content-type": "application/json",
                                },
                            },
                        );
                    },
                },
            ),
        ).rejects.toThrow("invalid JSON");
        expect(calls).toBe(2);
    });

    test("parses a receipt preview without persisting raw media", async () => {
        let requestBody = "";
        const preview = await previewInventoryImage(
            {
                mode: "receipt",
                mimeType: "image/jpeg",
                bytes: new Uint8Array([1, 2, 3]),
            },
            config,
            {
                fetcher: async (_url, init) => {
                    requestBody = String(init?.body ?? "");
                    return new Response(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        content: JSON.stringify({
                                            lines: [
                                                {
                                                    raw_label: "SUGAR 4LB",
                                                    name: "Granulated sugar",
                                                    quantity: 4,
                                                    unit: "lb",
                                                    is_food: true,
                                                    confidence: 0.98,
                                                    location: "pantry",
                                                },
                                                {
                                                    raw_label: "PAPER TOWEL",
                                                    name: "Paper towels",
                                                    quantity: 1,
                                                    unit: "count",
                                                    is_food: false,
                                                    confidence: 0.99,
                                                    location: "unspecified",
                                                },
                                            ],
                                            notes: [],
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
        expect(preview.lines).toHaveLength(2);
        expect(preview.lines[0]?.name).toBe("Granulated sugar");
        expect(preview.lines[1]?.is_food).toBe(false);
        expect(requestBody).toContain("data:image/jpeg;base64,AQID");
        const provider = JSON.parse(requestBody).provider;
        expect(provider).toEqual({ data_collection: "deny" });
        expect(JSON.parse(requestBody).reasoning).toEqual({ enabled: false });
    });

    test("normalizes common provider location synonyms", async () => {
        const preview = await previewInventoryImage(
            {
                mode: "pantry_photo",
                mimeType: "image/png",
                bytes: new Uint8Array([1]),
            },
            config,
            {
                fetcher: async () =>
                    new Response(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        content: JSON.stringify({
                                            lines: [
                                                {
                                                    raw_label: "COTTAGE CHEESE",
                                                    name: "Cottage cheese",
                                                    quantity: null,
                                                    unit: null,
                                                    is_food: true,
                                                    confidence: 0.96,
                                                    location: "refrigerator",
                                                },
                                                {
                                                    raw_label: "FROZEN PEAS",
                                                    name: "Frozen peas",
                                                    quantity: null,
                                                    unit: null,
                                                    is_food: true,
                                                    confidence: 0.94,
                                                    location: "frozen storage",
                                                },
                                            ],
                                            notes: [],
                                        }),
                                    },
                                },
                            ],
                        }),
                    ),
            },
        );
        expect(preview.lines[0]?.location).toBe("fridge");
        expect(preview.lines[1]?.location).toBe("freezer");
    });

    test("normalizes a single provider note string before strict validation", async () => {
        const preview = await previewInventoryImage(
            {
                mode: "pantry_photo",
                mimeType: "image/png",
                bytes: new Uint8Array([1]),
            },
            config,
            {
                fetcher: async () =>
                    new Response(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        content: JSON.stringify({
                                            lines: [],
                                            notes: "Shelf labels were partially obscured.",
                                        }),
                                    },
                                },
                            ],
                        }),
                    ),
            },
        );
        expect(preview.notes).toEqual([
            "Shelf labels were partially obscured.",
        ]);
    });

    test("rejects unsupported media before provider calls", async () => {
        await expect(
            previewInventoryImage(
                {
                    mode: "receipt",
                    mimeType: "application/pdf",
                    bytes: new Uint8Array([1]),
                },
                config,
                { fetcher: async () => new Response("{}") },
            ),
        ).rejects.toThrow("JPEG, PNG, or WebP");
    });
});

describe("fallback drill: receipt ScaleDown labels-only fallback", () => {
    const fallbackConfig = {
        ...config,
        extractionsUrl: "https://example.test/extractions",
        receiptFallbackModel: "scaledown/extract",
    };
    const receiptInput = {
        mode: "receipt" as const,
        mimeType: "image/jpeg",
        bytes: new Uint8Array([1]),
    };

    function extractionsPayload(labels: string[]) {
        return new Response(
            JSON.stringify({
                answers: { raw_labels: { value: labels } },
                usage: { cost: 0.00006 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }

    test("drill: Ember HTTP 500 engages ScaleDown; every line lands in review", async () => {
        let chatCalls = 0;
        let extractionsBody: Record<string, any> = {};
        const preview = await previewInventoryImage(
            receiptInput,
            fallbackConfig,
            {
                fetcher: async (url, init) => {
                    if (String(url).includes("extractions")) {
                        extractionsBody = JSON.parse(
                            String(init?.body ?? "{}"),
                        );
                        return extractionsPayload(["EGGS 12CT", "MLK GL 1GAL"]);
                    }
                    chatCalls += 1;
                    return new Response("down", { status: 500 });
                },
            },
        );
        expect(chatCalls).toBe(1);
        expect(extractionsBody.model).toBe("scaledown/extract");
        expect(Object.keys(extractionsBody.fields ?? {})).toEqual([
            "raw_labels",
        ]);
        expect(preview.lines).toEqual([
            {
                raw_label: "EGGS 12CT",
                name: "EGGS 12CT",
                quantity: null,
                unit: null,
                is_food: true,
                confidence: 0,
                location: "unspecified",
            },
            {
                raw_label: "MLK GL 1GAL",
                name: "MLK GL 1GAL",
                quantity: null,
                unit: null,
                is_food: true,
                confidence: 0,
                location: "unspecified",
            },
        ]);
        expect(preview.notes.join(" ")).toContain("labels-only fallback");
    });

    test("drill: healthy Ember never touches the fallback", async () => {
        let extractionsCalls = 0;
        const preview = await previewInventoryImage(
            receiptInput,
            fallbackConfig,
            {
                fetcher: async (url) => {
                    if (String(url).includes("extractions")) {
                        extractionsCalls += 1;
                        return extractionsPayload(["SHOULD NOT BE USED"]);
                    }
                    return new Response(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        content: JSON.stringify({
                                            lines: [],
                                            notes: [],
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
        expect(preview.lines).toEqual([]);
        expect(extractionsCalls).toBe(0);
    });

    test("drill: pantry-photo mode has no fallback", async () => {
        let extractionsCalls = 0;
        await expect(
            previewInventoryImage(
                { ...receiptInput, mode: "pantry_photo" as const },
                fallbackConfig,
                {
                    fetcher: async (url) => {
                        if (String(url).includes("extractions")) {
                            extractionsCalls += 1;
                            return extractionsPayload(["X"]);
                        }
                        return new Response("down", { status: 500 });
                    },
                },
            ),
        ).rejects.toThrow("HTTP 500");
        expect(extractionsCalls).toBe(0);
    });

    test("drill: fallback down too surfaces the primary's error", async () => {
        await expect(
            previewInventoryImage(receiptInput, fallbackConfig, {
                fetcher: async () => new Response("down", { status: 500 }),
            }),
        ).rejects.toThrow("Pantry vision provider returned HTTP 500");
    });

    test("drill: request validation never engages the fallback", async () => {
        let calls = 0;
        await expect(
            previewInventoryImage(
                { ...receiptInput, mimeType: "image/gif" },
                fallbackConfig,
                {
                    fetcher: async () => {
                        calls += 1;
                        return extractionsPayload(["X"]);
                    },
                },
            ),
        ).rejects.toThrow("JPEG, PNG, or WebP");
        expect(calls).toBe(0);
    });

    test("config pin: designated default, env override, opt-out", () => {
        const built = inventoryVisionConfig({
            OPENROUTER_API_KEY: "test",
            MUNCH_PANTRY_VISION_ENABLED: "true",
        });
        expect(built?.receiptFallbackModel).toBe("scaledown/extract");
        expect(built?.extractionsUrl).toBe(
            "https://openrouter.ai/api/alpha/extractions",
        );
        expect(
            inventoryVisionConfig({
                OPENROUTER_API_KEY: "test",
                MUNCH_PANTRY_VISION_ENABLED: "true",
                MUNCH_RECEIPT_FALLBACK_MODEL: "",
            })?.receiptFallbackModel,
        ).toBeNull();
    });
});
