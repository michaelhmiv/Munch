import { describe, expect, test } from "bun:test";
import type { FoodCandidate } from "../food-providers/types.js";
import {
    readRecipePhoto,
    recipePhotoVisionConfig,
    RecipePhotoNoRecipeError,
    type RecipePhotoVisionConfig,
} from "./photo-vision.js";
import { previewRecipePhoto } from "./service.js";
import type { PhotoExtractedRecipe } from "./types.js";

// Cross-work slice 3 — photo recipe import. The vision tests pin the
// production Ember call shape (the pattern every generative call in
// the codebase follows); the preview tests run the extraction through
// the shared enrichment pipeline with a stubbed food search.

const config: RecipePhotoVisionConfig = {
    apiKey: "test-key",
    baseUrl: "https://openrouter.example/api/v1",
    model: "meta/muse-ember",
    timeoutMs: 5_000,
    maxTokens: 4_000,
    maxCallsPerImport: 2,
    responseFormat: "json_schema",
    responseHealing: true,
};

function envelope(content: string) {
    return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

const legible = JSON.stringify({
    is_recipe: true,
    title: "Overnight Oats",
    servings: 2,
    description: "A make-ahead breakfast jar.",
    preparation_minutes: 10,
    cooking_minutes: null,
    source_title: "Family Recipe Cards",
    ingredients: [
        {
            raw_text: "1 1/2 cups rolled oats",
            name: "rolled oats",
            quantity: 1.5,
            unit: "cup",
            preparation: null,
            optional: false,
            confidence: 0.96,
        },
        {
            raw_text: "1/2 cup milk",
            name: "milk",
            quantity: 0.5,
            unit: "cup",
            preparation: null,
            optional: false,
            confidence: 0.95,
        },
    ],
    instructions: ["Mix everything in a jar.", "Chill overnight."],
    warnings: [],
});

describe("recipe photo vision config", () => {
    test("reuses the recipe-import model setting (shared website AI model) and disables cleanly", () => {
        expect(recipePhotoVisionConfig({})).toBeNull();
        expect(
            recipePhotoVisionConfig({
                OPENROUTER_API_KEY: "k",
                MUNCH_RECIPE_IMPORT_AI_ENABLED: "false",
            }),
        ).toBeNull();
        expect(
            recipePhotoVisionConfig({ OPENROUTER_API_KEY: "k" })?.model,
        ).toBe("meta/muse-ember");
        expect(
            recipePhotoVisionConfig({
                OPENROUTER_API_KEY: "k",
                MUNCH_AI_MODEL: "google/gemini-test",
            })?.model,
        ).toBe("google/gemini-test");
    });
});

describe("readRecipePhoto request shape", () => {
    test("pins reasoning param, data_collection deny, strict schema, healing, and the inline image", async () => {
        let body: Record<string, any> = {};
        let url = "";
        const extraction = await readRecipePhoto(
            { mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) },
            config,
            {
                fetcher: async (input, init) => {
                    url = String(input);
                    body = JSON.parse(String(init?.body ?? "{}"));
                    return envelope(legible);
                },
            },
        );
        expect(url).toBe("https://openrouter.example/api/v1/chat/completions");
        expect(extraction.name).toBe("Overnight Oats");
        expect(extraction.servings).toBe(2);
        expect(extraction.ingredients[0]).toMatchObject({
            rawText: "1 1/2 cups rolled oats",
            name: "rolled oats",
            quantity: 1.5,
            unit: "cup",
        });
        // The pinned production call shape.
        expect(body.model).toBe("meta/muse-ember");
        expect(body.temperature).toBe(0);
        expect(body.reasoning).toEqual({ effort: "minimal" });
        expect(body.provider).toEqual({ data_collection: "deny" });
        expect(body.plugins).toEqual([{ id: "response-healing" }]);
        expect(body.response_format?.type).toBe("json_schema");
        expect(body.response_format?.json_schema?.strict).toBe(true);
        expect(body.response_format?.json_schema?.name).toBe(
            "munch_recipe_photo_read",
        );
        const userContent = body.messages?.[1]?.content ?? [];
        const imagePart = userContent.find(
            (part: any) => part.type === "image_url",
        );
        expect(imagePart?.image_url?.url).toStartWith(
            "data:image/jpeg;base64,",
        );
        const promptText = userContent.find(
            (part: any) => part.type === "text",
        )?.text;
        expect(promptText).toContain("Never invent");
        expect(JSON.stringify(body.response_format)).not.toMatch(/calories/);
    });

    test("a non-Ember model gets the explicit reasoning disable", async () => {
        let body: Record<string, any> = {};
        await readRecipePhoto(
            { mimeType: "image/png", bytes: new Uint8Array([1]) },
            { ...config, model: "openai/gpt-test" },
            {
                fetcher: async (_input, init) => {
                    body = JSON.parse(String(init?.body ?? "{}"));
                    return envelope(legible);
                },
            },
        );
        expect(body.reasoning).toEqual({ enabled: false });
        expect(body.provider).toEqual({ data_collection: "deny" });
    });

    test("retries once on unparseable output, then succeeds", async () => {
        let calls = 0;
        const extraction = await readRecipePhoto(
            { mimeType: "image/jpeg", bytes: new Uint8Array([1]) },
            config,
            {
                fetcher: async () => {
                    calls += 1;
                    return envelope(calls === 1 ? "not json" : legible);
                },
            },
        );
        expect(calls).toBe(2);
        expect(extraction.name).toBe("Overnight Oats");
    });

    test("does not retry HTTP failures", async () => {
        let calls = 0;
        await expect(
            readRecipePhoto(
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

    test("rejects a response carrying nutrition numbers (strict schema)", async () => {
        const withNutrition = JSON.stringify({
            ...JSON.parse(legible),
            calories: 400,
        });
        let calls = 0;
        await expect(
            readRecipePhoto(
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

    test("a photo with no legible recipe fails honestly — no invented recipe", async () => {
        const garbage = JSON.stringify({
            is_recipe: false,
            title: null,
            servings: null,
            description: null,
            preparation_minutes: null,
            cooking_minutes: null,
            source_title: null,
            ingredients: [],
            instructions: [],
            warnings: [],
        });
        await expect(
            readRecipePhoto(
                { mimeType: "image/jpeg", bytes: new Uint8Array([1]) },
                config,
                { fetcher: async () => envelope(garbage) },
            ),
        ).rejects.toBeInstanceOf(RecipePhotoNoRecipeError);
    });

    test("partly illegible readings surface as warnings, never filled gaps", async () => {
        const partly = JSON.stringify({
            is_recipe: true,
            title: "Tomato Soup",
            servings: null,
            description: null,
            preparation_minutes: null,
            cooking_minutes: 30,
            source_title: null,
            ingredients: [
                {
                    raw_text: "1 onion, diced",
                    name: "onion",
                    quantity: 1,
                    unit: null,
                    preparation: "diced",
                    optional: false,
                    confidence: 0.55,
                },
            ],
            instructions: ["Simmer everything for 30 minutes."],
            warnings: ["The servings line is cut off in the photo."],
        });
        const extraction = await readRecipePhoto(
            { mimeType: "image/jpeg", bytes: new Uint8Array([1]) },
            config,
            { fetcher: async () => envelope(partly) },
        );
        expect(extraction.servings).toBeUndefined();
        const messages = extraction.warnings.map((w) => w.message);
        expect(messages).toContain(
            "The servings line is cut off in the photo.",
        );
        expect(messages.some((m) => m.includes("check the servings"))).toBe(
            true,
        );
        expect(messages.some((m) => m.includes("1 onion, diced"))).toBe(true);
        expect(
            extraction.warnings.every((w) => w.code === "photo_text_uncertain"),
        ).toBe(true);
    });
});

const oatsCandidate: FoodCandidate = {
    provider: "usda",
    providerFoodId: "200",
    name: "rolled oats",
    dataKind: "generic",
    portions: [
        {
            id: "cup",
            amount: 1,
            unit: "cup",
            label: "1 cup",
            gramWeight: 80,
            nutrients: {
                calories: 300,
                protein_g: 10,
                carbs_g: 54,
                fat_g: 5,
            },
        },
    ],
    nutrientsPer100g: {
        calories: 375,
        protein_g: 12.5,
        carbs_g: 67.5,
        fat_g: 6.25,
    },
    attribution: {
        label: "USDA FoodData Central",
        url: "https://fdc.nal.usda.gov/food/200",
    },
    confidence: 0.97,
};

const legibleExtraction: PhotoExtractedRecipe = {
    name: "Overnight Oats",
    description: "A make-ahead breakfast jar.",
    servings: 2,
    instructions: ["Mix everything in a jar.", "Chill overnight."],
    preparationMinutes: 10,
    sourceTitle: "Family Recipe Cards",
    ingredients: [
        {
            rawText: "1 1/2 cups rolled oats",
            name: "rolled oats",
            quantity: 1.5,
            unit: "cup",
            sourcePosition: 0,
            semanticConfidence: 0.96,
        },
        {
            rawText: "1/2 cup milk",
            name: "milk",
            quantity: 0.5,
            unit: "cup",
            sourcePosition: 1,
            semanticConfidence: 0.95,
        },
    ],
    warnings: [],
};

describe("previewRecipePhoto (shared enrichment pipeline)", () => {
    test("builds the same draft shape as URL import, with photo provenance and no invented URL", async () => {
        const draft = await previewRecipePhoto(legibleExtraction, {
            foodSearch: {
                search: async (query: string) => ({
                    candidates: /oats/i.test(query) ? [oatsCandidate] : [],
                    failures: [],
                }),
            },
        });
        expect(draft.parser.strategy).toBe("photo_vision");
        expect(draft.source).toEqual({
            submitted_url: null,
            final_url: null,
            canonical_url: null,
            title: "Family Recipe Cards",
            site_name: null,
            author: null,
        });
        expect(draft.recipe.name).toBe("Overnight Oats");
        expect(draft.recipe.servings).toBe(2);
        expect(draft.recipe.source_url).toBeUndefined();
        expect(draft.recipe.source_title).toBe("Family Recipe Cards");
        expect(draft.recipe.instructions).toEqual([
            "Mix everything in a jar.",
            "Chill overnight.",
        ]);
        // The oats line resolved through the provider pipeline.
        const oats = draft.recipe.ingredients[0]!;
        expect(oats.provider).toBe("usda");
        expect(oats.nutrients?.calories).toBe(450);
        expect(draft.ingredient_review[0]?.resolution).toBe("matched");
        expect(draft.nutrition.per_serving.calories).toBeGreaterThan(0);
    });

    test("photo warnings land in the draft warnings and force review", async () => {
        const draft = await previewRecipePhoto(
            {
                ...legibleExtraction,
                servings: undefined,
                warnings: [
                    {
                        code: "photo_text_uncertain",
                        message: "The servings line is cut off in the photo.",
                        severity: "warning",
                    },
                ],
            },
            {
                foodSearch: {
                    search: async () => ({ candidates: [], failures: [] }),
                },
            },
        );
        expect(draft.recipe.servings).toBe(1);
        expect(draft.requires_review).toBe(true);
        expect(
            draft.warnings.some(
                (w) =>
                    w.message === "The servings line is cut off in the photo.",
            ),
        ).toBe(true);
    });

    test("an extraction with no ingredients fails instead of drafting an empty recipe", async () => {
        await expect(
            previewRecipePhoto(
                { ...legibleExtraction, ingredients: [] },
                {
                    foodSearch: {
                        search: async () => ({ candidates: [], failures: [] }),
                    },
                },
            ),
        ).rejects.toThrow("no legible recipe");
    });
});
