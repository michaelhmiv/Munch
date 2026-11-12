import { describe, expect, test } from "bun:test";
import {
    buildGoalsContext,
    goalsContextForModel,
    goalsIntakePatch,
    normalizeGoalsIntake,
    textMatchesAllergy,
    type GoalsIntake,
} from "./goals-context.js";
import type { GuidancePreferences } from "./guidance/contracts.js";

const ANSWERED: GoalsIntake = {
    stated_goal: "Lower my fat intake at dinner",
    activity_band: "30_to_60",
    eating_pattern: "mix",
    hardest_meal: "dinner",
    never_suggest: ["cilantro"],
    allergies: ["peanuts"],
};

function preferences(partial: Record<string, unknown>): GuidancePreferences {
    return partial as unknown as GuidancePreferences;
}

describe("goals intake normalization", () => {
    test("junk and missing values normalize to fully unset", () => {
        for (const value of [null, undefined, 42, "nope", []]) {
            const intake = normalizeGoalsIntake(value);
            expect(intake.stated_goal).toBeNull();
            expect(intake.activity_band).toBeNull();
            expect(intake.allergies).toEqual([]);
        }
    });

    test("valid answers survive; unknown enum values become unset", () => {
        const intake = normalizeGoalsIntake({
            stated_goal: "  Eat more protein at breakfast  ",
            activity_band: "30_to_60",
            eating_pattern: "sometimes",
            hardest_meal: "dinner",
            never_suggest: [" Cilantro ", "cilantro", "", "olives"],
            allergies: ["peanuts"],
        });
        expect(intake.stated_goal).toBe("Eat more protein at breakfast");
        expect(intake.activity_band).toBe("30_to_60");
        expect(intake.eating_pattern).toBeNull();
        expect(intake.hardest_meal).toBe("dinner");
        expect(intake.never_suggest).toEqual(["Cilantro", "olives"]);
        expect(intake.allergies).toEqual(["peanuts"]);
    });

    test("a patch replaces present fields and keeps absent ones", () => {
        const next = goalsIntakePatch(ANSWERED, {
            hardest_meal: "breakfast",
        });
        expect(next?.hardest_meal).toBe("breakfast");
        expect(next?.stated_goal).toBe(ANSWERED.stated_goal);
        expect(next?.allergies).toEqual(["peanuts"]);
    });

    test("an explicit null or empty list clears a field", () => {
        const next = goalsIntakePatch(ANSWERED, {
            stated_goal: null,
            allergies: [],
        });
        expect(next?.stated_goal).toBeNull();
        expect(next?.allergies).toEqual([]);
    });

    test("a patch with no intake field is rejected", () => {
        expect(goalsIntakePatch(ANSWERED, { unrelated: true })).toBeNull();
        expect(goalsIntakePatch(ANSWERED, null)).toBeNull();
    });
});

describe("goals context assembly", () => {
    test("an unanswered intake assembles to no context for the model", () => {
        const context = buildGoalsContext({});
        expect(context.has_intake).toBe(false);
        expect(goalsContextForModel(context)).toBeNull();
    });

    test("answered intake fields reach the assembled context", () => {
        const context = buildGoalsContext({ intake: ANSWERED });
        expect(context.has_intake).toBe(true);
        expect(context.stated_goal).toBe(ANSWERED.stated_goal);
        expect(context.activity_band).toBe("30_to_60");
        const model = goalsContextForModel(context);
        expect(model?.hardest_meal).toBe("dinner");
        expect(model?.never_suggest).toEqual(["cilantro"]);
    });

    test("guidance-preference allergies and exclusions merge into the effective lists", () => {
        const context = buildGoalsContext({
            intake: ANSWERED,
            guidancePreferences: preferences({
                allergies: ["milk"],
                excluded_ingredients: ["olives"],
            }),
        });
        // Rule 5: an allergen stated in either place is a hard filter.
        expect(context.allergies).toEqual(["peanuts", "milk"]);
        expect(context.never_suggest).toEqual(["cilantro", "olives"]);
    });

    test("numeric targets ride along in the five-field shape", () => {
        const context = buildGoalsContext({
            targets: {
                daily_calories: 2100,
                daily_protein_g: 140,
                daily_carbs_g: null,
                daily_fat_g: 70,
                daily_fiber_g: 30,
                daily_sugar_g: 50,
                daily_alcohol_g: null,
                daily_water_ml: null,
                target_weight_g: null,
            },
        });
        expect(context.targets).toEqual({
            daily_calories: 2100,
            daily_protein_g: 140,
            daily_carbs_g: null,
            daily_fat_g: 70,
            daily_fiber_g: 30,
        });
    });
});

describe("allergy matching (rule 5 hard filter)", () => {
    test("alias-table matches: ingredient names implicate stated categories", () => {
        expect(textMatchesAllergy("garlic shrimp pasta", ["shellfish"])).toBe(
            true,
        );
        expect(textMatchesAllergy("cheddar omelette", ["milk"])).toBe(true);
        expect(textMatchesAllergy("walnut salad", ["tree nuts"])).toBe(true);
        expect(textMatchesAllergy("peanut sauce noodles", ["peanut"])).toBe(
            true,
        );
    });

    test("a stated ingredient name implicates its category too", () => {
        expect(textMatchesAllergy("shrimp cocktail", ["shrimp"])).toBe(true);
        expect(textMatchesAllergy("prawn curry", ["shrimp"])).toBe(true);
    });

    test("non-catalog allergens match on the stated term itself", () => {
        expect(textMatchesAllergy("mushroom risotto", ["mushroom"])).toBe(true);
    });

    test("unrelated food does not match, and no allergies means no match", () => {
        expect(textMatchesAllergy("grilled chicken", ["peanut"])).toBe(false);
        expect(textMatchesAllergy("peanut sauce", [])).toBe(false);
    });
});
