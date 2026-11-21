import { describe, expect, test } from "bun:test";
import type { StructuredMealRecord } from "../structured-meals/types.js";
import { createAppMeal, type WebMealItemSelection } from "./meal-entry.js";
import { copyMeal, type CopyMealDeps } from "./meal-mutations.js";
import { copyMealInputFromBody } from "./routes.js";

/**
 * Finding 6 (W2 logging math): the meal composer minted a fresh
 * random idempotency key inside the submit handler on every attempt,
 * and the duplicate-meal flow sent no key at all (copyMeal minted a
 * fresh UUID server-side per call) — so any retry after a lost
 * response created a duplicate meal (and a duplicate pantry
 * draw-down). The composer now keeps one session key per meal, and
 * copyMeal accepts the dialog's per-opening key.
 */

function structuredSource(items: StructuredMealRecord["items"]) {
    return {
        id: "meal-1",
        userId: "user-1",
        loggedAt: "2026-11-20T12:00:00.000Z",
        mealType: "lunch",
        description: "Apple lunch",
        calories: 95,
        proteinG: 0.5,
        carbsG: 25,
        fatG: 0.3,
        fiberG: null,
        sugarG: null,
        alcoholG: null,
        notes: null,
        idempotencyKey: "original-key",
        sourceRecipeId: null,
        sourceRecipeRevisionId: null,
        sourcePlannedMealId: null,
        items,
    } satisfies StructuredMealRecord;
}

const oneItem: StructuredMealRecord["items"] = [
    {
        id: "item-1",
        name: "Apples, raw, with skin",
        quantity: 1,
        portionLabel: "1 medium apple",
        gramWeight: 182,
        nutrients: { calories: 95, protein_g: 0.5, carbs_g: 25, fat_g: 0.3 },
        sourceType: "usda",
        provider: "usda",
        providerFoodId: "171688",
        providerRevision: null,
        sourceUrl: null,
        sourceUpdatedAt: null,
        confidence: 0.95,
        assumptions: [],
        sourceSnapshot: { resolution_layer: "food_search" },
    } as StructuredMealRecord["items"][number],
];

/** In-memory (user_id, idempotency_key) uniqueness for both insert paths. */
function createCopyDeps(source: StructuredMealRecord) {
    const structured = new Map<string, { id: string }>();
    const legacy = new Map<string, { id: string }>();
    let sequence = 0;
    const deps: CopyMealDeps = {
        getMeal: async () => source,
        insertStructured: async (userId, input) => {
            const key = `${userId}:${input.idempotencyKey}`;
            const existing = structured.get(key);
            if (existing)
                return { meal: existing as never, deduplicated: true };
            sequence += 1;
            const meal = { id: `copy-${sequence}` };
            structured.set(key, meal);
            return { meal: meal as never, deduplicated: false };
        },
        insertLegacy: async (userId, input) => {
            const key = `${userId}:${input.idempotency_key}`;
            const existing = legacy.get(key);
            if (existing)
                return { meal: existing as never, deduplicated: true };
            sequence += 1;
            const meal = { id: `copy-${sequence}` };
            legacy.set(key, meal);
            return { meal: meal as never, deduplicated: false };
        },
    };
    return { deps, structured, legacy };
}

describe("Finding 6 — copyMeal idempotency", () => {
    test("copyMeal twice with the same idempotencyKey creates one structured copy", async () => {
        const { deps, structured } = createCopyDeps(structuredSource(oneItem));
        const input = copyMealInputFromBody({
            logged_at: "2026-11-21T12:00:00.000Z",
            meal_type: "lunch",
            idempotency_key: "dup-dialog-1",
        });
        expect(input).toEqual({
            loggedAt: "2026-11-21T12:00:00.000Z",
            mealType: "lunch",
            idempotencyKey: "dup-dialog-1",
        });

        const first = await copyMeal("user-1", "meal-1", input, deps);
        const second = await copyMeal("user-1", "meal-1", input, deps);

        expect(first).toEqual({
            mealId: "copy-1",
            structured: true,
            deduplicated: false,
        });
        expect(second).toEqual({
            mealId: "copy-1",
            structured: true,
            deduplicated: true,
        });
        expect(structured.size).toBe(1);
    });

    test("copyMeal twice with the same idempotencyKey creates one legacy aggregate copy", async () => {
        const { deps, legacy } = createCopyDeps(structuredSource([]));
        const input = { idempotencyKey: "dup-dialog-1" };
        const first = await copyMeal("user-1", "meal-1", input, deps);
        const second = await copyMeal("user-1", "meal-1", input, deps);

        expect(first).toEqual({
            mealId: "copy-1",
            structured: false,
            deduplicated: false,
        });
        expect(second).toEqual({
            mealId: "copy-1",
            structured: false,
            deduplicated: true,
        });
        expect(legacy.size).toBe(1);
    });

    test("copyMeal with distinct idempotencyKeys (two separate dialog openings) creates two independent copies", async () => {
        const { deps, structured } = createCopyDeps(structuredSource(oneItem));
        const first = await copyMeal(
            "user-1",
            "meal-1",
            { idempotencyKey: "dup-dialog-1" },
            deps,
        );
        const second = await copyMeal(
            "user-1",
            "meal-1",
            { idempotencyKey: "dup-dialog-2" },
            deps,
        );
        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(false);
        expect(second.mealId).not.toBe(first.mealId);
        expect(structured.size).toBe(2);
    });

    test("copyMeal without an idempotencyKey still generates a unique key per call (backward compatible)", async () => {
        const { deps, structured } = createCopyDeps(structuredSource(oneItem));
        const first = await copyMeal("user-1", "meal-1", {}, deps);
        const second = await copyMeal("user-1", "meal-1", {}, deps);
        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(false);
        expect(second.mealId).not.toBe(first.mealId);
        expect(structured.size).toBe(2);
    });

    test("copyMeal rejects an invalid idempotencyKey", async () => {
        const { deps } = createCopyDeps(structuredSource(oneItem));
        await expect(
            copyMeal("user-1", "meal-1", { idempotencyKey: "   " }, deps),
        ).rejects.toThrow("Meal copy idempotency key is invalid");
        await expect(
            copyMeal(
                "user-1",
                "meal-1",
                { idempotencyKey: "x".repeat(256) },
                deps,
            ),
        ).rejects.toThrow("Meal copy idempotency key is invalid");
    });
});

describe("Finding 6 — composer server dedup via createAppMeal", () => {
    test("createAppMeal with the same composer session idempotencyKey creates one meal and marks saved food used once", async () => {
        const meals = new Map<string, { id: string }>();
        let sequence = 0;
        const markUsedCalls: Array<[string, string]> = [];
        const deps = {
            resolveItem: async (
                _userId: string,
                input: WebMealItemSelection,
            ) => ({
                name:
                    typeof input.name === "string" ? input.name : "Saved toast",
                quantity: 1,
                nutrients: { calories: 100 },
                sourceType: "saved_food" as const,
                assumptions: [],
                sourceSnapshot: { resolution_layer: "saved_food" },
            }),
            insertMeal: async (
                userId: string,
                input: { idempotencyKey: string },
            ) => {
                const key = `${userId}:${input.idempotencyKey}`;
                const existing = meals.get(key);
                if (existing)
                    return { meal: existing as never, deduplicated: true };
                sequence += 1;
                const meal = { id: `meal-${sequence}` };
                meals.set(key, meal);
                return { meal: meal as never, deduplicated: false };
            },
            markUsed: async (userId: string, savedFoodId: string) => {
                markUsedCalls.push([userId, savedFoodId]);
            },
        };

        const input = {
            description: "Saved toast",
            mealType: "breakfast",
            idempotencyKey: "composer-session-1",
            items: [
                { saved_food_id: "sf-1", quantity: 1 },
            ] as WebMealItemSelection[],
        };
        const first = await createAppMeal("user-1", input, deps);
        const second = await createAppMeal("user-1", input, deps);

        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(true);
        expect(second.meal).toBe(first.meal);
        expect(meals.size).toBe(1);
        expect(markUsedCalls).toEqual([["user-1", "sf-1"]]);
    });
});
