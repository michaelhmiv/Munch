import { describe, expect, test } from "bun:test";
import { parseAiContentReportBody } from "./ai-content-report.js";

describe("AI content report parsing", () => {
    test("accepts and normalizes a Pantry meal-idea report", () => {
        expect(
            parseAiContentReportBody({
                surface: "pantry_meal_idea",
                content_excerpt: "  Example AI suggestion  ",
                reason: "offensive",
                details: "  Unsafe wording  ",
            }),
        ).toEqual({
            surface: "pantry_meal_idea",
            contentExcerpt: "Example AI suggestion",
            reason: "offensive",
            details: "Unsafe wording",
        });
    });

    test("allows reports without optional details", () => {
        expect(
            parseAiContentReportBody({
                surface: "pantry_meal_idea",
                content_excerpt: "Generated suggestion",
                reason: "misleading",
            }),
        ).toEqual({
            surface: "pantry_meal_idea",
            contentExcerpt: "Generated suggestion",
            reason: "misleading",
            details: undefined,
        });
    });

    test("rejects unsupported surfaces and reasons", () => {
        expect(() =>
            parseAiContentReportBody({
                surface: "chat",
                content_excerpt: "Generated suggestion",
                reason: "offensive",
            }),
        ).toThrow("Unsupported AI content report surface");
        expect(() =>
            parseAiContentReportBody({
                surface: "pantry_meal_idea",
                content_excerpt: "Generated suggestion",
                reason: "spam",
            }),
        ).toThrow("Invalid AI content report reason");
    });

    test("rejects empty or oversized content", () => {
        expect(() =>
            parseAiContentReportBody({
                surface: "pantry_meal_idea",
                content_excerpt: "   ",
                reason: "other",
            }),
        ).toThrow("AI content report excerpt is invalid");
        expect(() =>
            parseAiContentReportBody({
                surface: "pantry_meal_idea",
                content_excerpt: "x".repeat(2001),
                reason: "unsafe",
            }),
        ).toThrow("AI content report excerpt is invalid");
    });
});
