import { describe, expect, test } from "bun:test";
import {
    runSweep,
    type SweepFinding,
    type SweepRecipeRecord,
    type SweepStore,
} from "./sweep.js";
import type { PlausibilityReview } from "../decisions/plausibility.js";
import type { StoredIngredientRecord } from "./prefilter.js";

const USER = "user-1";

function milkRecipe(): SweepRecipeRecord {
    const milk: StoredIngredientRecord = {
        name: "Whole Milk",
        quantity: 3,
        unit: "cup",
        gramWeight: 183,
        nutrients: { calories: 111.63 },
        sourceSnapshot: {
            automatic_nutrition: {
                resolution: "assumed_provider_match",
                implied_grams_per_unit: 61,
            },
        },
    };
    return {
        recipeId: "recipe-milk",
        userId: USER,
        scope: { type: "personal" },
        version: 3,
        revisionId: "rev-1",
        revisionNumber: 1,
        nutritionStatus: "complete",
        perServingBefore: { calories: 460 },
        ingredients: [milk],
        updatedAt: new Date("2026-11-01T00:00:00Z"),
    };
}

function cheddarRecipe(): SweepRecipeRecord {
    const cheddar: StoredIngredientRecord = {
        name: "Sharp Cheddar Cheese",
        quantity: 12,
        unit: "oz",
        gramWeight: 340,
        nutrients: { calories: 1370, sugar_g: 48.65 },
        sourceSnapshot: {
            automatic_nutrition: {
                resolution: "provider_match",
                provider_data_kind: "packaged",
                provider_food_name: "Sharp Cheddar Cheese",
            },
        },
    };
    return {
        recipeId: "recipe-cheddar",
        userId: USER,
        scope: { type: "personal" },
        version: 1,
        revisionId: "rev-c1",
        revisionNumber: 1,
        nutritionStatus: "complete",
        perServingBefore: { calories: 700 },
        ingredients: [cheddar],
        updatedAt: new Date("2026-11-01T00:00:00Z"),
    };
}

interface FakeStore extends SweepStore {
    calls: {
        heal: number;
        recordFindings: number;
        setWatermark: number;
    };
    recorded: SweepFinding[];
    watermark: Date | null;
    /** Simulated revision store: revisionId -> frozen snapshot string. */
    revisions: Map<string, string>;
}

function fakeStore(
    recipes: SweepRecipeRecord[],
    mealItems: SweepStore["listMealItems"] extends never
        ? never
        : Awaited<ReturnType<SweepStore["listMealItems"]>> = [],
): FakeStore {
    const revisions = new Map<string, string>();
    for (const recipe of recipes) {
        revisions.set(
            recipe.revisionId,
            JSON.stringify(recipe.ingredients, null, 2),
        );
    }
    const store: FakeStore = {
        calls: { heal: 0, recordFindings: 0, setWatermark: 0 },
        recorded: [],
        watermark: null,
        revisions,
        async listRecipes(since) {
            return recipes.filter(
                (recipe) => !since || recipe.updatedAt >= since,
            );
        },
        async listMealItems(since) {
            return mealItems.filter(
                (item) => !since || item.updatedAt >= since,
            );
        },
        async healRecipe({ recipe, idempotencyKey }) {
            store.calls.heal += 1;
            expect(idempotencyKey).toBe(
                `jev-sweep:${recipe.recipeId}:${recipe.revisionId}`,
            );
            // Simulate the Calculate path: a NEW revision is appended;
            // the old revision's stored bytes are never touched.
            const newRevisionId = `${recipe.revisionId}+healed`;
            revisions.set(newRevisionId, "[]");
            return {
                healed: true,
                newRevisionId,
                newRevisionNumber: recipe.revisionNumber + 1,
                nutritionStatus: "complete",
                perServingAfter: { calories: 497 },
            };
        },
        async recordFindings(findings) {
            store.calls.recordFindings += 1;
            store.recorded.push(...findings);
        },
        async getWatermark() {
            return store.watermark;
        },
        async setWatermark(at) {
            store.calls.setWatermark += 1;
            store.watermark = at;
        },
    };
    return store;
}

const confirmAll = async (
    ingredients: Array<{ name: string }>,
): Promise<PlausibilityReview> => ({
    status: "reviewed",
    model: "typesafe/jev-1.14",
    threshold: 0.5,
    reportedCostUsd: 0.00005,
    verdicts: ingredients.map((ingredient, index) => ({
        index,
        name: ingredient.name,
        pImplausible: 0.98,
        confirmedImplausible: true,
    })),
});

const clearAll = async (
    ingredients: Array<{ name: string }>,
): Promise<PlausibilityReview> => ({
    status: "reviewed",
    model: "typesafe/jev-1.14",
    threshold: 0.5,
    reportedCostUsd: 0.00005,
    verdicts: ingredients.map((ingredient, index) => ({
        index,
        name: ingredient.name,
        pImplausible: 0.02,
        confirmedImplausible: false,
    })),
});

describe("sweep healing rules", () => {
    test("confirmed milk-class defect heals as a NEW revision; old revision byte-preserved", async () => {
        const recipe = milkRecipe();
        const before = JSON.stringify(recipe.ingredients, null, 2);
        const store = fakeStore([recipe]);
        const report = await runSweep({
            mode: "backfill",
            dryRun: false,
            store,
            review: confirmAll as never,
        });
        expect(report.healedRecipes).toBe(1);
        expect(store.calls.heal).toBe(1);
        // Old revision bytes untouched; a new revision exists.
        expect(store.revisions.get("rev-1")).toBe(before);
        expect(store.revisions.has("rev-1+healed")).toBe(true);
        const healed = report.findings.find(
            (finding) => finding.kind === "recipe_healed",
        );
        expect(healed).toBeDefined();
        if (healed?.kind === "recipe_healed") {
            expect(healed.perServingBefore.calories).toBe(460);
            expect(healed.perServingAfter.calories).toBe(497);
        }
    });

    test("Pass-2 clearing a suspect means NO heal (deterministic flags never accuse)", async () => {
        const store = fakeStore([milkRecipe()]);
        const report = await runSweep({
            mode: "backfill",
            dryRun: false,
            store,
            review: clearAll as never,
        });
        expect(report.suspectRecipes).toBe(1);
        expect(report.confirmedRecipes).toBe(0);
        expect(report.healedRecipes).toBe(0);
        expect(store.calls.heal).toBe(0);
    });

    test("cheddar class confirms but does NOT auto-heal (provider-data defect, reported instead)", async () => {
        const store = fakeStore([cheddarRecipe()]);
        const report = await runSweep({
            mode: "backfill",
            dryRun: false,
            store,
            review: confirmAll as never,
        });
        expect(report.confirmedRecipes).toBe(1);
        expect(report.healedRecipes).toBe(0);
        expect(store.calls.heal).toBe(0);
        expect(
            report.findings.some(
                (finding) => finding.kind === "recipe_flagged",
            ),
        ).toBe(true);
    });

    test("an unchecked review (chain down) heals nothing and accuses nothing", async () => {
        const store = fakeStore([milkRecipe()]);
        const report = await runSweep({
            mode: "backfill",
            dryRun: false,
            store,
            review: (async () => ({
                status: "unchecked",
                reason: "chain_exhausted",
            })) as never,
        });
        expect(report.uncheckedRecipes).toBe(1);
        expect(report.healedRecipes).toBe(0);
        expect(store.calls.heal).toBe(0);
    });
});

describe("logged meals are never rewritten", () => {
    test("a confirmed meal defect produces a meal_check finding and no write path fires", async () => {
        const store = fakeStore(
            [],
            [
                {
                    itemId: "item-1",
                    mealId: "meal-1",
                    userId: USER,
                    name: "Mystery Sauce",
                    quantity: 1,
                    portionLabel: null,
                    gramWeight: 50,
                    nutrients: { calories: 500 },
                    updatedAt: new Date("2026-11-02T00:00:00Z"),
                },
            ],
        );
        const report = await runSweep({
            mode: "backfill",
            dryRun: false,
            store,
            review: confirmAll as never,
        });
        expect(report.confirmedMealItems).toBe(1);
        expect(report.healedRecipes).toBe(0);
        expect(store.calls.heal).toBe(0);
        const checks = report.findings.filter(
            (finding) => finding.kind === "meal_check",
        );
        expect(checks).toHaveLength(1);
        // The store interface has no meal-write method at all; the only
        // persisted artifact is the finding the user acts on.
        expect(store.recorded).toEqual(checks);
    });
});

describe("dry-run and watermark discipline", () => {
    test("dry-run writes NOTHING: no heal, no findings, no watermark move", async () => {
        const store = fakeStore([milkRecipe()]);
        store.watermark = new Date("2026-11-01T00:00:00Z");
        const report = await runSweep({
            mode: "incremental",
            dryRun: true,
            store,
            review: confirmAll as never,
            now: new Date("2026-11-13T00:00:00Z"),
        });
        expect(report.projectedHeals).toBe(1);
        expect(report.healedRecipes).toBe(0);
        expect(store.calls).toEqual({
            heal: 0,
            recordFindings: 0,
            setWatermark: 0,
        });
        expect(store.watermark?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
        expect(report.watermarkAfter).toBe("2026-11-01T00:00:00.000Z");
    });

    test("incremental scans only records at/after the watermark and advances it once", async () => {
        const old = milkRecipe();
        old.updatedAt = new Date("2026-10-01T00:00:00Z");
        const fresh = milkRecipe();
        fresh.recipeId = "recipe-fresh";
        fresh.revisionId = "rev-fresh";
        fresh.updatedAt = new Date("2026-11-10T00:00:00Z");
        const store = fakeStore([old, fresh]);
        store.watermark = new Date("2026-11-05T00:00:00Z");
        const report = await runSweep({
            mode: "incremental",
            dryRun: false,
            store,
            review: confirmAll as never,
            now: new Date("2026-11-13T00:00:00Z"),
        });
        expect(report.scannedRecipes).toBe(1);
        expect(report.healedRecipes).toBe(1);
        expect(store.calls.setWatermark).toBe(1);
        expect(store.watermark?.toISOString()).toBe("2026-11-13T00:00:00.000Z");
    });

    test("backfill ignores the watermark entirely", async () => {
        const old = milkRecipe();
        old.updatedAt = new Date("2026-10-01T00:00:00Z");
        const store = fakeStore([old]);
        store.watermark = new Date("2026-11-05T00:00:00Z");
        const report = await runSweep({
            mode: "backfill",
            dryRun: false,
            store,
            review: confirmAll as never,
        });
        expect(report.scannedRecipes).toBe(1);
    });
});
