import { describe, expect, test } from "bun:test";
import { parseNaturalCookUpdate } from "./repository.js";

describe("natural cook updates", () => {
    test("records multiple events and preserves approximate relative time", () => {
        const submittedAt = "2026-09-14T18:00:00.000Z";
        const parsed = parseNaturalCookUpdate(
            "I heated the grill to 250°F a couple minutes ago and put the wings on.",
            submittedAt,
            "America/New_York",
        );

        expect(parsed.isQuestion).toBe(false);
        expect(parsed.events.map((event) => event.eventType)).toEqual([
            "preheat",
            "food_on",
        ]);
        expect(parsed.events[0]?.timePrecision).toBe("approximate");
        expect(parsed.events[0]?.relativePhrase).toBe("a couple minutes ago");
        expect(parsed.events[0]?.setpointTemperature).toBe(250);
        expect(parsed.events[0]?.setpointUnit).toBe("F");
        expect(parsed.suggestions.dish).toBe("wings");
        expect(parsed.suggestions.equipment).toBe("grill");
    });

    test("does not turn advisory questions into factual events", () => {
        const parsed = parseNaturalCookUpdate(
            "Should I wrap these wings now?",
            "2026-09-14T18:00:00.000Z",
        );

        expect(parsed.isQuestion).toBe(true);
        expect(parsed.events).toHaveLength(0);
        expect(parsed.summary).toContain("no cooking event");
    });

    test("keeps factual events before a trailing advisory question", () => {
        const parsed = parseNaturalCookUpdate(
            "I heated the smoker to 250°F. Should I wrap these wings now?",
            "2026-09-14T18:00:00.000Z",
        );

        expect(parsed.isQuestion).toBe(true);
        expect(parsed.events.map((event) => event.eventType)).toEqual([
            "preheat",
        ]);
        expect(parsed.events[0]?.originalMessage).toContain("Should I wrap");
    });

    test("supports temperature channels and free-form observations", () => {
        const parsed = parseNaturalCookUpdate(
            "The smoker environment is 275°F; internal chicken temp is 155°F. I wrapped and sauced the wings.",
            "2026-09-14T18:00:00.000Z",
        );

        expect(parsed.events.map((event) => event.eventType)).toEqual([
            "wrap",
            "sauce",
            "temperature_change",
        ]);
        expect(parsed.events.at(-1)?.ambientTemperature).toBe(275);
        expect(parsed.events.at(-1)?.internalTemperature).toBe(155);
    });
});
