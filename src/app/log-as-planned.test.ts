import { describe, expect, test } from "bun:test";
import { selectPlannedPrompts } from "./repository.js";

// Log as planned (connection option #1): the evening prompt rule.
// A planned meal earns a Log it / Skip it / Swap row on Today only
// when the viewed day is today, the day part is evening, and the
// meal is still unlogged.

const unlogged = {
    planned_meal_id: "planned-1",
    recipe_id: "recipe-1",
    recipe_revision_id: "revision-1",
    recipe_name: "Salmon and rice",
    meal_slot: "dinner",
    servings: 2,
    logged: false,
};
const logged = { ...unlogged, planned_meal_id: "planned-2", logged: true };

describe("selectPlannedPrompts", () => {
    test("prompts for today's unlogged planned meals in the evening", () => {
        const prompts = selectPlannedPrompts({
            isToday: true,
            dayPart: "evening",
            plannedMeals: [unlogged, logged],
        });
        expect(prompts).toEqual([
            {
                planned_meal_id: "planned-1",
                recipe_id: "recipe-1",
                recipe_revision_id: "revision-1",
                recipe_name: "Salmon and rice",
                meal_slot: "dinner",
                servings: 2,
            },
        ]);
    });

    test("never prompts in the morning or at midday", () => {
        for (const dayPart of ["morning", "midday"] as const) {
            expect(
                selectPlannedPrompts({
                    isToday: true,
                    dayPart,
                    plannedMeals: [unlogged],
                }),
            ).toEqual([]);
        }
    });

    test("never prompts for a past or future day, even in the evening", () => {
        // getTodayWorkspace passes isToday=false (and dayPart=null)
        // for any viewed date other than today in the user's
        // timezone — a past unlogged plan is history, a future one
        // has not come due.
        expect(
            selectPlannedPrompts({
                isToday: false,
                dayPart: null,
                plannedMeals: [unlogged],
            }),
        ).toEqual([]);
        expect(
            selectPlannedPrompts({
                isToday: false,
                dayPart: "evening",
                plannedMeals: [unlogged],
            }),
        ).toEqual([]);
    });

    test("never prompts for a meal that is already logged", () => {
        expect(
            selectPlannedPrompts({
                isToday: true,
                dayPart: "evening",
                plannedMeals: [logged],
            }),
        ).toEqual([]);
    });

    test("prompts for nothing when nothing is planned", () => {
        expect(
            selectPlannedPrompts({
                isToday: true,
                dayPart: "evening",
                plannedMeals: [],
            }),
        ).toEqual([]);
    });
});
