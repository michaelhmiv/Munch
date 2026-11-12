import { describe, expect, test } from "bun:test";
import {
    RECIPE_GROUNDING_AGGREGATE_FLOOR,
    RECIPE_GROUNDING_CORPUS,
    RECIPE_GROUNDING_PER_RECIPE_FLOOR,
} from "./recipe-grounding-corpus.js";

describe("recipe grounding corpus fixture", () => {
    test("stays small and covers all three parser strategies", () => {
        expect(RECIPE_GROUNDING_CORPUS.length).toBeGreaterThanOrEqual(5);
        expect(RECIPE_GROUNDING_CORPUS.length).toBeLessThanOrEqual(8);
        const strategies = new Set(
            RECIPE_GROUNDING_CORPUS.map((entry) => entry.expectedStrategy),
        );
        expect(strategies).toEqual(
            new Set(["schema_org_json_ld", "microdata", "recipe_card_html"]),
        );
    });

    test("has unique ids and https URLs", () => {
        const ids = RECIPE_GROUNDING_CORPUS.map((entry) => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const entry of RECIPE_GROUNDING_CORPUS) {
            expect(entry.recipeUrl.startsWith("https://")).toBe(true);
            expect(entry.notes.length).toBeGreaterThan(0);
        }
    });

    test("floors stay conservative relative to the measured rates", () => {
        // Measured 2026-11-11 (see fixture header): worst per-recipe
        // 37.5%, aggregate 52.3% warm / 46.1% cold. Floors must remain
        // regression tripwires, not aspirations.
        expect(RECIPE_GROUNDING_PER_RECIPE_FLOOR).toBeGreaterThan(0);
        expect(RECIPE_GROUNDING_PER_RECIPE_FLOOR).toBeLessThanOrEqual(0.25);
        expect(RECIPE_GROUNDING_AGGREGATE_FLOOR).toBeGreaterThan(
            RECIPE_GROUNDING_PER_RECIPE_FLOOR,
        );
        expect(RECIPE_GROUNDING_AGGREGATE_FLOOR).toBeLessThanOrEqual(0.4);
    });
});
