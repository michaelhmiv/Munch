import { describe, expect, test } from "bun:test";
import type { FoodCandidate } from "../food-providers/types.js";
import {
    classifyPantryFood,
    heuristicPlanningProfile,
    pantryPlanningEnabled,
    planningProfileFromCandidate,
} from "./planning-profile.js";

function candidate(overrides: Partial<FoodCandidate> = {}): FoodCandidate {
    return {
        provider: "usda",
        providerFoodId: "123",
        name: "Chicken breast, cooked",
        dataKind: "generic",
        nutrientsPer100g: {
            calories: 165,
            protein_g: 31,
            carbs_g: 0,
            fat_g: 3.6,
        },
        portions: [],
        attribution: { label: "USDA" },
        confidence: 0.96,
        ...overrides,
    };
}

describe("Pantry planning classification", () => {
    test("treats spices and flavor builders as first-class planning context", () => {
        expect(classifyPantryFood("smoked paprika")).toEqual({
            category: "spice",
            culinaryRoles: expect.arrayContaining([
                "flavor-builder",
                "seasoning",
                "smoky",
            ]),
        });
        expect(classifyPantryFood("soy sauce").culinaryRoles).toEqual(
            expect.arrayContaining(["sauce", "flavor-builder", "east-asian"]),
        );
        expect(classifyPantryFood("fresh garlic").culinaryRoles).toContain(
            "aromatic",
        );
    });

    test("gives protein-rich dairy both culinary and nutrition roles", () => {
        const profile = classifyPantryFood("low fat cottage cheese");
        expect(profile.category).toBe("dairy");
        expect(profile.culinaryRoles).toEqual(
            expect.arrayContaining(["creamy", "protein", "topping"]),
        );
    });

    test("does not pretend unknown foods are nutritionally resolved", () => {
        const profile = heuristicPlanningProfile(
            "11111111-1111-4111-8111-111111111111",
            "Grandma's mystery relish",
        );
        expect(profile.profile_status).toBe("unresolved");
        expect(profile.source_type).toBe("unresolved");
        expect(profile.nutrients.protein_g).toBeNull();
    });
});

describe("Pantry planning nutrition snapshot", () => {
    test("prefers a normalized per-100g provider basis", () => {
        const profile = planningProfileFromCandidate(
            "11111111-1111-4111-8111-111111111111",
            "chicken breast",
            candidate(),
        );
        expect(profile.profile_status).toBe("resolved");
        expect(profile.source_type).toBe("provider");
        expect(profile.basis_quantity).toBe(100);
        expect(profile.basis_unit).toBe("g");
        expect(profile.basis_grams).toBe(100);
        expect(profile.nutrients.protein_g).toBe(31);
    });

    test("falls back to a provider portion without inventing a gram basis", () => {
        const profile = planningProfileFromCandidate(
            "11111111-1111-4111-8111-111111111111",
            "Greek yogurt",
            candidate({
                name: "Greek yogurt",
                nutrientsPer100g: undefined,
                portions: [
                    {
                        id: "cup",
                        amount: 1,
                        unit: "cup",
                        label: "1 cup",
                        nutrients: {
                            calories: 130,
                            protein_g: 20,
                            carbs_g: 8,
                            fat_g: 0,
                        },
                    },
                ],
            }),
        );
        expect(profile.basis_quantity).toBe(1);
        expect(profile.basis_unit).toBe("cup");
        expect(profile.basis_grams).toBeNull();
        expect(profile.nutrients.protein_g).toBe(20);
    });
});

test("Pantry planning is explicitly feature-gated", () => {
    expect(pantryPlanningEnabled({ MUNCH_PANTRY_PLANNING_ENABLED: "true" })).toBe(
        true,
    );
    expect(pantryPlanningEnabled({ MUNCH_PANTRY_PLANNING_ENABLED: "false" })).toBe(
        false,
    );
    expect(pantryPlanningEnabled({})).toBe(false);
});
