import { expect, test } from "bun:test";
import {
    DEFAULT_WEBSITE_AI_MODEL,
    websiteAiModel,
} from "./website-ai-config.js";

test("website AI uses one shared model variable", () => {
    expect(websiteAiModel({})).toBe(DEFAULT_WEBSITE_AI_MODEL);
    expect(DEFAULT_WEBSITE_AI_MODEL).toBe("qwen/qwen3.7-flash");
    expect(websiteAiModel({ MUNCH_AI_MODEL: "custom/model" })).toBe(
        "custom/model",
    );
    expect(
        websiteAiModel({
            MUNCH_RECIPE_IMPORT_AI_MODEL: "legacy/recipe",
            MUNCH_PANTRY_VISION_MODEL: "legacy/vision",
            MUNCH_PANTRY_PLANNING_MODEL: "legacy/planning",
        }),
    ).toBe(DEFAULT_WEBSITE_AI_MODEL);
});
