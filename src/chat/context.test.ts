import { describe, expect, test } from "bun:test";
import { summarizeChatContext, type ChatContextData } from "./context.js";
import { buildGoalsContext } from "../goals-context.js";

function data(partial: Partial<ChatContextData> = {}): ChatContextData {
    return {
        date: "2026-11-10",
        timezone: "America/New_York",
        goals: {
            daily_calories: 2100,
            daily_protein_g: 140,
            daily_carbs_g: null,
            daily_fat_g: null,
            daily_fiber_g: null,
        },
        today: {
            totals: {
                calories: 640.25,
                proteinG: 41,
                carbsG: 70,
                fatG: 18,
                fiberG: 6,
            },
        },
        ...partial,
    };
}

describe("chat v2 slim context summary", () => {
    test("carries goals and today's totals only — no meals, pantry, or history", () => {
        const summary = summarizeChatContext(data());
        expect(summary.sections).toEqual(["goals", "today_totals"]);
        expect(summary.today?.totals.calories).toBe(640.3);
        expect(summary.goals?.daily_calories).toBe(2100);
        // The slim shape is the v2 contract (brief decision 3): the
        // summary object must not grow detail sections back — the
        // agent fetches detail through tools instead.
        expect(Object.keys(summary).sort()).toEqual([
            "date",
            "goals",
            "sections",
            "timezone",
            "today",
        ]);
        expect(Object.keys(summary.today ?? {}).sort()).toEqual(["totals"]);
    });

    test("absent sections are omitted, never fabricated", () => {
        const summary = summarizeChatContext(
            data({ goals: null, today: null }),
        );
        expect(summary.sections).toEqual([]);
        expect(summary.goals).toBeNull();
        expect(summary.today).toBeNull();
    });

    test("the stated goal + intake ride along once the user answers the intake", () => {
        const summary = summarizeChatContext(
            data({
                goalsContext: buildGoalsContext({
                    intake: {
                        stated_goal: "Lower my fat intake at dinner",
                        activity_band: "30_to_60",
                        eating_pattern: null,
                        hardest_meal: "dinner",
                        never_suggest: ["cilantro"],
                        allergies: ["peanuts"],
                    },
                }),
            }),
        );
        expect(summary.sections).toEqual([
            "goals",
            "today_totals",
            "goals_context",
        ]);
        expect(summary.goals_context?.stated_goal).toBe(
            "Lower my fat intake at dinner",
        );
        expect(summary.goals_context?.activity_band).toBe("30_to_60");
        expect(summary.goals_context?.allergies).toEqual(["peanuts"]);
    });

    test("an unanswered intake adds no goals_context key at all", () => {
        const summary = summarizeChatContext(
            data({ goalsContext: buildGoalsContext({}) }),
        );
        expect("goals_context" in summary).toBe(false);
        expect(summary.sections).toEqual(["goals", "today_totals"]);
    });

    test("totals are rounded to one decimal", () => {
        const summary = summarizeChatContext(
            data({
                today: {
                    totals: {
                        calories: 640.25,
                        proteinG: 41.04,
                        carbsG: 70,
                        fatG: 18,
                        fiberG: 6,
                    },
                },
            }),
        );
        expect(summary.today?.totals.calories).toBe(640.3);
        expect(summary.today?.totals.proteinG).toBe(41);
    });
});
