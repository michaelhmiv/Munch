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
