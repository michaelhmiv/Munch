import { describe, expect, test } from "bun:test";
import {
    ADEQUATE_DATABASE_CONFIDENCE,
    fallbackGuidance,
} from "./canonical-food-search.js";

describe("canonical food search fallback guidance", () => {
    test("recommends external fallback when Munch has no database result", () => {
        const result = fallbackGuidance({
            structuredContent: { candidates: [] },
        });
        expect(result.externalFallbackRecommended).toBe(true);
        expect(result.reason).toBe("no_database_candidate");
    });

    test("recommends external fallback below the confidence threshold", () => {
        const result = fallbackGuidance({
            structuredContent: {
                candidates: [
                    {
                        confidence: ADEQUATE_DATABASE_CONFIDENCE - 0.01,
                    },
                ],
            },
        });
        expect(result.externalFallbackRecommended).toBe(true);
        expect(result.reason).toBe("low_database_confidence");
    });

    test("stops at an adequate database result", () => {
        const result = fallbackGuidance({
            structuredContent: {
                candidates: [
                    {
                        confidence: ADEQUATE_DATABASE_CONFIDENCE,
                    },
                ],
            },
        });
        expect(result.externalFallbackRecommended).toBe(false);
        expect(result.reason).toBe("adequate_database_candidate");
    });
});
