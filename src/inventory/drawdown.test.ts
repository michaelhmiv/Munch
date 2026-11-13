import { describe, expect, test } from "bun:test";
import {
    applyPantryDrawdown,
    detectDrawdownAnomalies,
    drawdownAiConfig,
    estimateRemainder,
    finalizeDrawdownPlan,
    mealItemRequirements,
    mergeAiDrawdownMatches,
    planDeterministicDrawdown,
    reconcileDrawdownWithAi,
    scaleRecipeRequirements,
    type AiDrawdownMatch,
} from "./drawdown.js";
import type { PantryItem } from "./repository.js";

function item(partial: Partial<PantryItem> & { name: string }): PantryItem {
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

const RICE = item({ name: "Rice", quantity: 6, unit: "cup" });
const CHICKEN = item({
    name: "Chicken",
    quantity: 2,
    unit: "lb",
    quantity_mode: "approximate",
});
const CHICKEN_THIGHS = item({
    name: "Chicken thighs",
    quantity: 2,
    unit: "lb",
    quantity_mode: "approximate",
});
const SALT = item({
    name: "Salt",
    quantity: null,
    unit: null,
    quantity_mode: "presence_only",
});

describe("scaleRecipeRequirements", () => {
    test("scales by servings cooked, not servings eaten", () => {
        const reqs = scaleRecipeRequirements(
            [
                { name: "Rice", quantity: 4, unit: "cup" },
                { name: "Chicken", quantity: 2, unit: "lb" },
                { name: "Herbs", quantity: null, unit: null },
            ],
            2, // cooked 2 of a 4-serving recipe
            4,
        );
        expect(reqs[0]).toMatchObject({ quantity: 2, unit: "cup" });
        expect(reqs[1]).toMatchObject({ quantity: 1, unit: "lb" });
        expect(reqs[2]!.quantity).toBeNull();
    });

    test("cooked more than the recipe scales up", () => {
        const reqs = scaleRecipeRequirements(
            [{ name: "Rice", quantity: 4, unit: "cup" }],
            8,
            4,
        );
        expect(reqs[0]!.quantity).toBe(8);
    });

    test("rejects non-positive servings", () => {
        expect(() => scaleRecipeRequirements([], 0, 4)).toThrow();
        expect(() => scaleRecipeRequirements([], 2, 0)).toThrow();
    });
});

describe("mealItemRequirements", () => {
    test("gram weight wins as the used amount", () => {
        const [req] = mealItemRequirements([
            {
                name: "Rice",
                quantity: 2,
                portionLabel: "1 cup",
                gramWeight: 360,
            },
        ]);
        expect(req).toMatchObject({ quantity: 360, unit: "g" });
    });

    test("portion label quantity scales by the logged quantity", () => {
        const [req] = mealItemRequirements([
            {
                name: "Oats",
                quantity: 2,
                portionLabel: "1 cup rolled",
                gramWeight: null,
            },
        ]);
        expect(req).toMatchObject({ quantity: 2, unit: "cup" });
    });

    test("bare items fall back to the logged count", () => {
        const [req] = mealItemRequirements([
            { name: "Egg", quantity: 3, portionLabel: null, gramWeight: null },
        ]);
        expect(req).toMatchObject({ quantity: 3, unit: null });
    });
});

describe("estimateRemainder", () => {
    test("exact stock reports the numeric remainder", () => {
        expect(
            estimateRemainder(
                { quantity: 6, unit: "cup", quantity_mode: "exact" },
                2,
            ),
        ).toEqual({ remainderQuantity: 4, remainderText: "4 cup left" });
    });

    test("exact stock fully used reads used the last of it", () => {
        expect(
            estimateRemainder(
                { quantity: 2, unit: "cup", quantity_mode: "exact" },
                2,
            ).remainderText,
        ).toBe("used the last of it");
    });

    test("overuse clamps at zero and reads used the last of it", () => {
        const result = estimateRemainder(
            { quantity: 1, unit: "cup", quantity_mode: "exact" },
            5,
        );
        expect(result.remainderQuantity).toBe(0);
        expect(result.remainderText).toBe("used the last of it");
    });

    test("approximate stock reads in categories", () => {
        const approx = {
            quantity: 2,
            unit: "lb",
            quantity_mode: "approximate" as const,
        };
        expect(estimateRemainder(approx, 0.5).remainderText).toBe("most left");
        expect(estimateRemainder(approx, 1).remainderText).toBe(
            "about half left",
        );
        expect(estimateRemainder(approx, 1.8).remainderText).toBe(
            "a little left",
        );
        expect(estimateRemainder(approx, 2).remainderText).toBe("likely gone");
        expect(estimateRemainder(approx, 3).remainderText).toBe(
            "used the last of it",
        );
    });

    test("presence-only stock reads some left", () => {
        expect(
            estimateRemainder(
                { quantity: null, unit: null, quantity_mode: "presence_only" },
                1,
            ).remainderText,
        ).toBe("some left");
    });
});

describe("planDeterministicDrawdown", () => {
    test("cooked servings drive the draw; the plan clamps to stock", () => {
        const reqs = scaleRecipeRequirements(
            [{ name: "Rice", quantity: 4, unit: "cup" }],
            2,
            4,
        );
        const plan = planDeterministicDrawdown(reqs, [RICE]);
        expect(plan.unresolved).toHaveLength(0);
        expect(plan.lines[0]).toMatchObject({
            status: "applied",
            used_quantity: 2,
            used_unit: "cup",
            remainder_text: "4 cup left",
            via: "deterministic",
        });
        expect(plan.operations[0]!.operation).toMatchObject({
            action: "consume",
            quantity: 2,
        });
    });

    test("never plans a negative draw when the recipe overuses stock", () => {
        const plan = planDeterministicDrawdown(
            [{ name: "Rice", quantity: 10, unit: "cup" }],
            [RICE],
        );
        expect(plan.operations[0]!.operation).toMatchObject({
            action: "consume",
            quantity: 6,
        });
        expect(plan.lines[0]!.remainder_text).toBe("used the last of it");
        expect(plan.lines[0]!.remainder_quantity).toBe(0);
    });

    test("two ingredients sharing one item split the stock", () => {
        const plan = planDeterministicDrawdown(
            [
                { name: "Rice", quantity: 4, unit: "cup" },
                { name: "Rice", quantity: 4, unit: "cup" },
            ],
            [RICE],
        );
        const quantities = plan.operations.map((entry) =>
            entry.operation.action === "consume" ? entry.operation.quantity : 0,
        );
        expect(quantities).toEqual([4, 2]);
    });

    test("unit conversion happens before the draw (ounces into grams)", () => {
        const gramRice = item({ name: "Rice", quantity: 1000, unit: "g" });
        const plan = planDeterministicDrawdown(
            [{ name: "Rice", quantity: 8, unit: "oz" }],
            [gramRice],
        );
        expect(plan.lines[0]!.status).toBe("applied");
        expect(plan.lines[0]!.used_unit).toBe("g");
        expect(plan.lines[0]!.used_quantity).toBeCloseTo(226.796, 2);
    });

    test("a volume requirement against mass stock is a unit mismatch, not a guess", () => {
        const gramRice = item({ name: "Rice", quantity: 1000, unit: "g" });
        const plan = planDeterministicDrawdown(
            [{ name: "Rice", quantity: 1, unit: "cup" }],
            [gramRice],
        );
        expect(plan.lines[0]).toBeNull();
        expect(plan.unresolved[0]!.reason).toBe("not in pantry");
    });

    test("unmatched and amount-less ingredients are listed as skipped, never invented", () => {
        const plan = planDeterministicDrawdown(
            [
                { name: "Saffron", quantity: 1, unit: "g" },
                { name: "Herbs", quantity: null, unit: null },
            ],
            [RICE],
        );
        const { lines, operations } = finalizeDrawdownPlan(plan, [
            { name: "Saffron", quantity: 1, unit: "g" },
            { name: "Herbs", quantity: null, unit: null },
        ]);
        expect(operations).toHaveLength(0);
        expect(lines[0]).toMatchObject({
            status: "skipped",
            reason: "not in pantry",
        });
        expect(lines[1]).toMatchObject({
            status: "skipped",
            reason: "no amount recorded",
        });
    });

    test("presence-only stock records the usage without a counted remainder", () => {
        const plan = planDeterministicDrawdown(
            [{ name: "Salt", quantity: 1, unit: "tsp" }],
            [SALT],
        );
        expect(plan.lines[0]).toMatchObject({
            status: "applied",
            remainder_text: "some left",
            remainder_quantity: null,
        });
    });
});

describe("AI reconciliation", () => {
    const config = {
        apiKey: "test-key",
        model: "meta/muse-ember",
        baseUrl: "https://openrouter.example/api/v1",
        timeoutMs: 5_000,
    };

    function jsonResponse(body: unknown): Response {
        return new Response(
            JSON.stringify({
                choices: [{ message: { content: JSON.stringify(body) } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }

    test("request shape pins the production AI contract (reasoning + data_collection deny)", async () => {
        let requestBody = "";
        let requestUrl = "";
        await reconcileDrawdownWithAi(
            [
                {
                    index: 0,
                    requirement: {
                        name: "chicken breast",
                        quantity: 1.5,
                        unit: "lb",
                    },
                },
            ],
            [CHICKEN],
            config,
            {
                fetcher: async (url, init) => {
                    requestUrl = String(url);
                    requestBody = String(init?.body ?? "");
                    return jsonResponse({ matches: [] });
                },
            },
        );
        const body = JSON.parse(requestBody);
        expect(requestUrl).toBe(
            "https://openrouter.example/api/v1/chat/completions",
        );
        expect(body.model).toBe("meta/muse-ember");
        expect(body.provider).toEqual({ data_collection: "deny" });
        expect(body.reasoning).toEqual({ effort: "minimal" });
        expect(body.response_format.json_schema.name).toBe(
            "munch_pantry_drawdown_reconcile",
        );
        expect(body.response_format.json_schema.strict).toBe(true);
    });

    test("non-Ember models keep reasoning disabled in the pinned shape", async () => {
        let requestBody = "";
        await reconcileDrawdownWithAi(
            [
                {
                    index: 0,
                    requirement: {
                        name: "chicken breast",
                        quantity: 1,
                        unit: "lb",
                    },
                },
            ],
            [CHICKEN],
            { ...config, model: "some/other-model" },
            {
                fetcher: async (_url, init) => {
                    requestBody = String(init?.body ?? "");
                    return jsonResponse({ matches: [] });
                },
            },
        );
        expect(JSON.parse(requestBody).reasoning).toEqual({ enabled: false });
    });

    test("a name mismatch resolves through AI and draws the approximate item down", async () => {
        const reqs = [{ name: "chicken breast", quantity: 1.5, unit: "lb" }];
        const plan = planDeterministicDrawdown(reqs, [CHICKEN_THIGHS]);
        // "chicken breast" vs "Chicken thighs" shares one token of
        // three (0.33) — under the deterministic threshold, so the
        // seam belongs to AI.
        expect(plan.unresolved).toHaveLength(1);
        const matches = await reconcileDrawdownWithAi(
            [{ index: 0, requirement: reqs[0]! }],
            [CHICKEN_THIGHS],
            config,
            {
                fetcher: async () =>
                    jsonResponse({
                        matches: [
                            {
                                ingredient_index: 0,
                                inventory_item_id: CHICKEN_THIGHS.id,
                                quantity: 1.5,
                                unit: "lb",
                                remainder: "a_little_left",
                                confidence: 0.8,
                            },
                        ],
                    }),
            },
        );
        const merged = mergeAiDrawdownMatches(
            plan,
            reqs,
            [CHICKEN_THIGHS],
            matches,
        );
        const { lines, operations } = finalizeDrawdownPlan(merged, reqs);
        expect(operations).toHaveLength(1);
        expect(lines[0]).toMatchObject({
            status: "applied",
            pantry_name: "Chicken thighs",
            used_quantity: 1.5,
            remainder_text: "a little left",
            via: "ai",
        });
    });

    test("a hallucinated pantry ID is discarded, never honoured", async () => {
        const matches = await reconcileDrawdownWithAi(
            [
                {
                    index: 0,
                    requirement: {
                        name: "chicken breast",
                        quantity: 1,
                        unit: "lb",
                    },
                },
            ],
            [CHICKEN],
            config,
            {
                fetcher: async () =>
                    jsonResponse({
                        matches: [
                            {
                                ingredient_index: 0,
                                inventory_item_id: "invented-id",
                                quantity: 1,
                                unit: "lb",
                                remainder: null,
                                confidence: 0.9,
                            },
                        ],
                    }),
            },
        );
        expect(matches.size).toBe(0);
    });

    test("AI clamps to the stock left after deterministic draws", () => {
        const reqs = [
            { name: "Rice", quantity: 5, unit: "cup" },
            { name: "rice pilaf mix", quantity: 5, unit: "cup" },
        ];
        const plan = planDeterministicDrawdown(reqs.slice(0, 1), [RICE]);
        // Simulate the second requirement arriving unresolved against
        // the same item with only 1 cup left after the first draw.
        const withUnresolved = {
            ...plan,
            lines: [...plan.lines, null],
            unresolved: [{ index: 1, reason: "not in pantry" }],
        };
        const ai = new Map<number, AiDrawdownMatch>([
            [
                1,
                {
                    inventoryItemId: RICE.id,
                    quantity: 5,
                    unit: "cup",
                    remainder: null,
                    confidence: 0.7,
                },
            ],
        ]);
        const merged = mergeAiDrawdownMatches(withUnresolved, reqs, [RICE], ai);
        const second = merged.operations.find((entry) => entry.index === 1);
        expect(second?.operation).toMatchObject({
            action: "consume",
            quantity: 1,
        });
    });

    test("the requested quantity governs when the model states a smaller amount", () => {
        const reqs = [{ name: "rice pilaf mix", quantity: 2, unit: "cup" }];
        const plan = planDeterministicDrawdown(reqs, []);
        expect(plan.unresolved).toHaveLength(1);
        const ai = new Map<number, AiDrawdownMatch>([
            [
                0,
                {
                    inventoryItemId: RICE.id,
                    quantity: 0.25,
                    unit: "cup",
                    remainder: null,
                    confidence: 0.9,
                },
            ],
        ]);
        const merged = mergeAiDrawdownMatches(plan, reqs, [RICE], ai);
        const { lines, operations } = finalizeDrawdownPlan(merged, reqs);
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            action: "consume",
            inventoryItemId: RICE.id,
            quantity: 2,
            unit: "cup",
        });
        expect(lines[0]).toMatchObject({
            status: "applied",
            used_quantity: 2,
            via: "ai",
        });
    });

    test("the requested quantity governs when the model states a larger amount", () => {
        const reqs = [{ name: "rice pilaf mix", quantity: 1, unit: "cup" }];
        const plan = planDeterministicDrawdown(reqs, []);
        expect(plan.unresolved).toHaveLength(1);
        const ai = new Map<number, AiDrawdownMatch>([
            [
                0,
                {
                    inventoryItemId: RICE.id,
                    quantity: 99,
                    unit: "cup",
                    remainder: null,
                    confidence: 0.9,
                },
            ],
        ]);
        const merged = mergeAiDrawdownMatches(plan, reqs, [RICE], ai);
        const { operations } = finalizeDrawdownPlan(merged, reqs);
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            action: "consume",
            inventoryItemId: RICE.id,
            quantity: 1,
            unit: "cup",
        });
    });

    test("presence-only stock the AI calls likely gone is depleted", () => {
        const reqs = [{ name: "Salt", quantity: null, unit: null }];
        const plan = planDeterministicDrawdown(reqs, [SALT]);
        const ai = new Map<number, AiDrawdownMatch>([
            [
                0,
                {
                    inventoryItemId: SALT.id,
                    quantity: null,
                    unit: null,
                    remainder: "likely_gone",
                    confidence: 0.6,
                },
            ],
        ]);
        const merged = mergeAiDrawdownMatches(plan, reqs, [SALT], ai);
        expect(merged.operations[0]!.operation).toMatchObject({
            action: "consume_all",
        });
        expect(merged.lines[0]).toMatchObject({
            status: "applied",
            remainder_text: "likely gone",
        });
    });
});

describe("applyPantryDrawdown", () => {
    const baseInput = {
        userId: "user-1",
        scope: { type: "personal" } as const,
        sourceType: "recipe_preparation" as const,
        mealId: "meal-1",
        mealIdempotencyKey: "meal-key-1",
        requirements: [{ name: "Rice", quantity: 2, unit: "cup" }],
    };

    test("commits the draw as inventory events fed by the meal", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const summary = await applyPantryDrawdown(baseInput, {
            aiConfig: null,
            getPantryFn: async () => ({
                enabled: true,
                inventorySpaceId: "space-1",
                items: [RICE],
            }),
            reconcileFn: async (input) => {
                calls.push(input as unknown as Record<string, unknown>);
                return {
                    enabled: true,
                    inventorySpaceId: "space-1",
                    operations: [],
                };
            },
        });
        expect(summary.status).toBe("applied");
        if (summary.status === "applied") {
            expect(summary.lines[0]).toMatchObject({
                status: "applied",
                remainder_text: "4 cup left",
            });
        }
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            sourceType: "recipe_preparation",
            sourceEntityId: "meal-1",
            idempotencyKey: "drawdown:meal-key-1",
        });
    });

    test("pantry workspace off reports not_applied and reconciles nothing", async () => {
        let reconciled = false;
        const summary = await applyPantryDrawdown(baseInput, {
            aiConfig: null,
            getPantryFn: async () => ({
                enabled: false,
                inventorySpaceId: null,
                items: [],
            }),
            reconcileFn: async () => {
                reconciled = true;
                throw new Error("must not be called");
            },
        });
        expect(summary).toMatchObject({
            status: "not_applied",
            reason: "pantry_not_enabled",
        });
        expect(reconciled).toBe(false);
    });

    test("garbage AI output degrades to deterministic-only, never blocks", async () => {
        const summary = await applyPantryDrawdown(
            {
                ...baseInput,
                requirements: [
                    { name: "Rice", quantity: 2, unit: "cup" },
                    { name: "chicken breast", quantity: 1.5, unit: "lb" },
                ],
            },
            {
                aiConfig: {
                    apiKey: "k",
                    model: "meta/muse-ember",
                    baseUrl: "https://openrouter.example/api/v1",
                    timeoutMs: 5_000,
                },
                fetcher: async () =>
                    new Response(
                        JSON.stringify({
                            choices: [
                                { message: { content: "not json at all" } },
                            ],
                        }),
                        { status: 200 },
                    ),
                getPantryFn: async () => ({
                    enabled: true,
                    inventorySpaceId: "space-1",
                    items: [RICE, CHICKEN_THIGHS],
                }),
                reconcileFn: async () => ({
                    enabled: true,
                    inventorySpaceId: "space-1",
                    operations: [],
                }),
            },
        );
        expect(summary.status).toBe("applied");
        if (summary.status === "applied") {
            expect(summary.lines[0]).toMatchObject({ status: "applied" });
            expect(summary.lines[1]).toMatchObject({
                status: "skipped",
                reason: "not in pantry",
            });
        }
    });

    test("a reconcile failure reports not_applied instead of throwing", async () => {
        const summary = await applyPantryDrawdown(baseInput, {
            aiConfig: null,
            getPantryFn: async () => ({
                enabled: true,
                inventorySpaceId: "space-1",
                items: [RICE],
            }),
            reconcileFn: async () => {
                throw new Error("Pantry changed during draw-down");
            },
        });
        expect(summary).toMatchObject({ status: "not_applied" });
    });

    test("drawdownAiConfig stays off without an API key", () => {
        expect(drawdownAiConfig({})).toBeNull();
        expect(
            drawdownAiConfig({
                OPENROUTER_API_KEY: "k",
                MUNCH_DRAWDOWN_AI_ENABLED: "false",
            }),
        ).toBeNull();
        expect(drawdownAiConfig({ OPENROUTER_API_KEY: "k" })?.model).toBe(
            "meta/muse-ember",
        );
    });
});

describe("detectDrawdownAnomalies (seat B4 engagement)", () => {
    const plan = (
        reqs: Array<{ name: string; quantity?: number | null; unit?: string | null }>,
        items: PantryItem[],
    ) => {
        const planned = planDeterministicDrawdown(reqs, items);
        return finalizeDrawdownPlan(planned, reqs).lines;
    };

    test("a draw within exact stock is not an anomaly", () => {
        const reqs = [{ name: "Rice", quantity: 2, unit: "cup" }];
        expect(detectDrawdownAnomalies(reqs, [RICE], plan(reqs, [RICE]))).toEqual([]);
    });

    test("a draw exactly equal to stock is not an anomaly", () => {
        const reqs = [{ name: "Rice", quantity: 6, unit: "cup" }];
        expect(detectDrawdownAnomalies(reqs, [RICE], plan(reqs, [RICE]))).toEqual([]);
    });

    test("a requested draw above exact stock is an anomaly (the plan clamps, the request does not)", () => {
        const reqs = [{ name: "Rice", quantity: 8, unit: "cup" }];
        const anomalies = detectDrawdownAnomalies(reqs, [RICE], plan(reqs, [RICE]));
        expect(anomalies).toHaveLength(1);
        expect(anomalies[0]).toMatchObject({
            kind: "draw_exceeds_stock",
            requestedQuantity: 8,
            recordedQuantity: 6,
            quantityMode: "exact",
        });
    });

    test("draws from two lines aggregate against the one recorded stock", () => {
        const reqs = [
            { name: "Rice", quantity: 4, unit: "cup" },
            { name: "Rice", quantity: 4, unit: "cup" },
        ];
        const anomalies = detectDrawdownAnomalies(reqs, [RICE], plan(reqs, [RICE]));
        expect(anomalies).toHaveLength(1);
        expect(anomalies[0]!.requestedQuantity).toBe(8);
        expect(anomalies[0]!.index).toBe(0);
    });

    test("#283: presence-only stock can never prove a shortfall — never an anomaly", () => {
        const reqs = [{ name: "Salt", quantity: 2, unit: "tsp" }];
        expect(detectDrawdownAnomalies(reqs, [SALT], plan(reqs, [SALT]))).toEqual([]);
        const countedPresence = item({
            name: "Salt",
            quantity: 5,
            unit: "tsp",
            quantity_mode: "presence_only",
        });
        const bigReqs = [{ name: "Salt", quantity: 99, unit: "tsp" }];
        expect(
            detectDrawdownAnomalies(bigReqs, [countedPresence], plan(bigReqs, [countedPresence])),
        ).toEqual([]);
    });

    test("an approximate item flipped to nearly-gone is an anomaly; a moderate draw is not", () => {
        const flipReqs = [{ name: "Chicken", quantity: 1.8, unit: "lb" }];
        const flips = detectDrawdownAnomalies(flipReqs, [CHICKEN], plan(flipReqs, [CHICKEN]));
        expect(flips).toHaveLength(1);
        expect(flips[0]!.kind).toBe("approximate_remainder_flip");
        const okReqs = [{ name: "Chicken", quantity: 1, unit: "lb" }];
        expect(detectDrawdownAnomalies(okReqs, [CHICKEN], plan(okReqs, [CHICKEN]))).toEqual([]);
    });

    test("skipped lines never produce anomalies", () => {
        const reqs = [{ name: "Saffron", quantity: 50, unit: "g" }];
        expect(detectDrawdownAnomalies(reqs, [RICE], plan(reqs, [RICE]))).toEqual([]);
    });
});
