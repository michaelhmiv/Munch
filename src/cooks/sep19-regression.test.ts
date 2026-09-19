import { describe, expect, test } from "bun:test";
import { COOK_EVENT_TYPES, normalizeCookEventType } from "./event-contract.js";
import { parseNaturalCookUpdate } from "./repository.js";

const submitted = "2026-09-19T22:36:16.000Z";
const timezone = "America/New_York";

describe("Cooks canonical type contract", () => {
    test("canonical types and aliases are never silently passed to PostgreSQL", () => {
        for (const type of COOK_EVENT_TYPES)
            expect(normalizeCookEventType(type)).toBe(type);
        expect(normalizeCookEventType("spritzing")).toBe("spritz");
        expect(normalizeCookEventType("seasoning")).toBe("season");
        expect(normalizeCookEventType("glazing")).toBe("sauce");
        expect(normalizeCookEventType("food_off")).toBe("remove");
        expect(normalizeCookEventType("temperature measurement")).toBe(
            "temperature_change",
        );
        expect(() => normalizeCookEventType("teleport")).toThrow(
            "Unsupported cook event type",
        );
    });
});

describe("September 19 cooking-session inference safeguards", () => {
    const noCompletedActions = [
        "I haven't wrapped it yet.",
        "I might spray it later.",
        "Should I raise the temperature?",
        "The exact time is unknown.",
        "No post-cook rest has been confirmed.",
        "The exact time it was put on smoker is NOT confirmed.",
        "Recommended post-cook rest 10–15 min, not yet confirmed completed.",
        "Wrap/glaze/finish times planned, not yet confirmed.",
        "The 275°F increase was suggested, not completed.",
    ];

    for (const message of noCompletedActions) {
        test(`does not fabricate an event: ${message}`, () => {
            const actual = parseNaturalCookUpdate(message, submitted, timezone);
            expect(actual.events.filter((e) => e.eventType !== "note")).toEqual(
                [],
            );
        });
    }

    test("a retrospective recap does not create new current-time actions", () => {
        const summary =
            "PREPARATION / REST HISTORY: Saturday September 19: seasoned/marinated two baby back rib racks at approximately 2:00 PM EDT; rested in seasoning approximately 90 minutes before putting on smoker at 3:30 PM EDT. No post-cook rest has been confirmed.";
        const events = parseNaturalCookUpdate(
            summary,
            submitted,
            timezone,
        ).events;
        expect(
            events.filter(
                (e) => e.eventType === "rest" || e.eventType === "food_on",
            ),
        ).toEqual([]);
    });

    test("records a contemporaneous completed spritz but not a hypothetical one", () => {
        const completed = parseNaturalCookUpdate(
            "I just spritzed both with Bragg honey apple cider vinegar.",
            submitted,
            timezone,
        );
        expect(completed.events.map((event) => event.eventType)).toEqual([
            "spritz",
        ]);
        expect(completed.events[0]?.eventAt).toBe(submitted);
        expect(completed.events[0]?.timePrecision).toBe("approximate");
        expect(
            parseNaturalCookUpdate(
                "I might spritz both later.",
                submitted,
                timezone,
            ).events,
        ).toEqual([]);
    });

    test("unresolved times are not silently replaced with submission time", () => {
        const parsed = parseNaturalCookUpdate(
            "I wrapped the ribs.",
            submitted,
            timezone,
        );
        expect(parsed.events[0]?.eventType).toBe("wrap");
        expect(parsed.events[0]?.eventAt).toBeUndefined();
        expect(parsed.events[0]?.timePrecision).toBe("unknown");
    });

    test("a Friday rub note does not infer a new Saturday preparation", () => {
        const events = parseNaturalCookUpdate(
            "Actually, I put the dry rub on the loin Friday around 5:00 p.m.",
            submitted,
            timezone,
        ).events;
        expect(events.some((event) => event.eventType === "food_on")).toBe(
            false,
        );
        expect(events.some((event) => event.eventAt === submitted)).toBe(false);
    });
});
