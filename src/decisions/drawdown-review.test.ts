import { describe, expect, test } from "bun:test";
import {
    drawdownAnomalyFlagged,
    reviewDrawdownAnomaly,
} from "./drawdown-review.js";
import { decisionsConfig, type DecisionsConfig } from "./config.js";
import type { DecisionsFetcher } from "./client.js";
import {
    applyPantryDrawdown,
    type DrawdownAnomaly,
} from "../inventory/drawdown.js";
import type { PantryItem } from "../inventory/repository.js";

function seatConfig(overrides: Partial<DecisionsConfig> = {}): DecisionsConfig {
    const base = decisionsConfig({
        OPENROUTER_API_KEY: "test" + "-key",
        MUNCH_JEV_DRAWDOWN_ENABLED: "true",
    })!;
    return { ...base, ...overrides };
}

function answeringFetcher(
    pMatch: number,
    pQty: number,
    counter = { calls: 0 },
): DecisionsFetcher {
    return async () => {
        counter.calls += 1;
        return new Response(
            JSON.stringify({
                answers: {
                    match_correct: { type: "noul", noul: pMatch },
                    quantity_plausible: { type: "noul", noul: pQty },
                },
                usage: { cost: 0.00003 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    };
}

const anomaly: DrawdownAnomaly = {
    index: 0,
    kind: "draw_exceeds_stock",
    ingredient: "Rice",
    ingredientQuantity: 8,
    ingredientUnit: "cup",
    requestedQuantity: 8,
    requestedUnit: "cup",
    pantryItemId: "id-rice",
    pantryName: "Rice",
    recordedQuantity: 6,
    recordedUnit: "cup",
    quantityMode: "exact",
    identityScore: 0.95,
};

describe("reviewDrawdownAnomaly (production call shape)", () => {
    test("returns probabilities, model, and API-reported cost", async () => {
        const review = await reviewDrawdownAnomaly(anomaly, seatConfig(), {
            fetcher: answeringFetcher(0.9, 0.2),
        });
        expect(review.pMatchCorrect).toBe(0.9);
        expect(review.pQuantityPlausible).toBe(0.2);
        expect(review.model).toBe("typesafe/jev-1.14");
        expect(review.reportedCostUsd).toBe(0.00003);
        expect(drawdownAnomalyFlagged(review)).toBe(true);
    });

    test("confident match + plausible quantity is not flagged", async () => {
        const review = await reviewDrawdownAnomaly(anomaly, seatConfig(), {
            fetcher: answeringFetcher(0.95, 0.9),
        });
        expect(drawdownAnomalyFlagged(review)).toBe(false);
    });
});

function pantryItem(partial: Partial<PantryItem> & { name: string }): PantryItem {
    const name = partial.name;
    return {
        id: partial.id ?? `id-${name.toLowerCase().replaceAll(" ", "-")}`,
        normalized_name: name.toLowerCase(),
        quantity: 0,
        unit: null,
        quantity_mode: "exact",
        stock_state: "available",
        location: "pantry",
        food_provider: null,
        provider_food_id: null,
        barcode: null,
        note: null,
        version: 1,
        updated_at: "2026-11-11T00:00:00.000Z",
        ...partial,
    };
}

const RICE = pantryItem({ name: "Rice", quantity: 6, unit: "cup" });

describe("applyPantryDrawdown — seat B4 wiring", () => {
    const baseInput = {
        userId: "user-1",
        scope: { type: "personal" } as const,
        sourceType: "recipe_preparation" as const,
        mealId: "meal-1",
        mealIdempotencyKey: "meal-key-1",
        requirements: [{ name: "Rice", quantity: 8, unit: "cup" }],
    };
    const deps = (extra: Record<string, unknown>) => ({
        aiConfig: null,
        getPantryFn: async () => ({
            enabled: true,
            inventorySpaceId: "space-1",
            items: [RICE],
        }),
        reconcileFn: async () => ({
            enabled: true,
            inventorySpaceId: "space-1",
            operations: [],
        }),
        ...extra,
    });

    test("an anomalous draw is reviewed and flagged; the draw itself stands (fail-open)", async () => {
        const summary = await applyPantryDrawdown(
            baseInput,
            deps({
                jevConfig: seatConfig(),
                jevFetcher: answeringFetcher(0.05, 0.9),
            }) as never,
        );
        expect(summary.status).toBe("applied");
        if (summary.status === "applied") {
            expect(summary.lines[0]).toMatchObject({
                status: "applied",
                used_quantity: 6,
                jev_review: {
                    status: "flagged",
                    anomaly: "draw_exceeds_stock",
                    model: "typesafe/jev-1.14",
                    p_match_correct: 0.05,
                },
            });
        }
    });

    test("a benign draw never engages the seat (anomaly-only)", async () => {
        const counter = { calls: 0 };
        const summary = await applyPantryDrawdown(
            { ...baseInput, requirements: [{ name: "Rice", quantity: 2, unit: "cup" }] },
            deps({
                jevConfig: seatConfig(),
                jevFetcher: answeringFetcher(0.01, 0.01, counter),
            }) as never,
        );
        expect(summary.status).toBe("applied");
        expect(counter.calls).toBe(0);
        if (summary.status === "applied") {
            expect(summary.lines[0]!.jev_review).toBeUndefined();
        }
    });

    test("flag off: anomaly draws exactly as today, zero calls, no annotation", async () => {
        const counter = { calls: 0 };
        const summary = await applyPantryDrawdown(
            baseInput,
            deps({
                jevConfig: seatConfig({ drawdownReviewEnabled: false }),
                jevFetcher: answeringFetcher(0.01, 0.01, counter),
            }) as never,
        );
        expect(summary.status).toBe("applied");
        expect(counter.calls).toBe(0);
        if (summary.status === "applied") {
            expect(summary.lines[0]).toMatchObject({
                status: "applied",
                used_quantity: 6,
            });
            expect(summary.lines[0]!.jev_review).toBeUndefined();
        }
    });

    test("chain down annotates unchecked and the draw still applies", async () => {
        const failing: DecisionsFetcher = async () =>
            new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
        const summary = await applyPantryDrawdown(
            baseInput,
            deps({ jevConfig: seatConfig(), jevFetcher: failing }) as never,
        );
        expect(summary.status).toBe("applied");
        if (summary.status === "applied") {
            expect(summary.lines[0]).toMatchObject({
                status: "applied",
                used_quantity: 6,
                jev_review: { status: "unchecked", model: null },
            });
        }
    });
});
