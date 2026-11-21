import { afterAll, describe, expect, test } from "bun:test";
import {
    closePlatformDatabase,
    getPlatformDatabase,
} from "../platform/database.js";
import {
    addGroceryItems,
    getGroceryList,
    markGroceryItemPurchased,
} from "../planning/repository.js";
import { applyPantryDrawdown } from "./drawdown.js";
import { getPantry, reconcilePantry, reconcilePurchase } from "./repository.js";
import { purchaseLines } from "./routes.js";

/**
 * W2 Pantry regression coverage (stock model honesty):
 *
 * - Finding 1: consuming a presence-only Pantry item silently rewrote its
 *   quantity_mode to "approximate" (the consume UPDATE in reconcilePantry
 *   read the pre-update row, whose quantity is null for presence-only).
 * - Finding 2: an unchecked (confirmed: false) high-confidence receipt line
 *   was still added to the Pantry — `confirmed` was only an OR-term in
 *   reconcilePurchase, never a veto — and the HTTP route coerced an omitted
 *   `confirmed` to false, which would have vetoed every API caller that
 *   omits the field once the veto landed.
 * - Finding 8: grocery check-off stocked non-food household items into the
 *   food Pantry because the acquisition trigger had no food gate.
 * - Finding 3: draw-down's AI seam was starved by the candidateNames
 *   pre-filter, which dropped non-substring pantry matches in SQL before
 *   either matcher could see them.
 *
 * The database tests run wherever DATABASE_URL is set (the CI database
 * job, after `bun run db:migrate`) and skip in the no-database quality
 * job. The purchaseLines unit test runs everywhere.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());
const dbTest = hasDatabase ? test : test.skip;

const personalScope = { type: "personal" } as const;

async function createTestUser(label: string): Promise<string> {
    const userId = crypto.randomUUID();
    const database = getPlatformDatabase();
    await database`
        insert into munch.users (id, email, name, email_verified, status)
        values (
            ${userId},
            ${`pantry-honesty-${label}-${userId}@example.test`},
            ${`Pantry honesty ${label}`},
            true,
            'active'
        )
    `;
    return userId;
}

afterAll(async () => {
    await closePlatformDatabase();
});

describe("Finding 1: consume preserves quantity_mode", () => {
    dbTest(
        "consuming a presence-only item keeps quantity_mode as presence_only and quantity null",
        async () => {
            const userId = await createTestUser("f1-presence");
            const acquired = await reconcilePantry({
                userId,
                scope: personalScope,
                sourceType: "manual",
                idempotencyKey: `honesty-f1-presence-acquire-${userId}`,
                operations: [
                    {
                        action: "acquire",
                        name: "Olive oil spray",
                        quantityMode: "presence_only",
                    },
                ],
            });
            const item = acquired.operations[0]?.item;
            if (!item)
                throw new Error("Presence-only acquire returned no item");
            expect(item.quantity).toBeNull();
            expect(item.quantity_mode).toBe("presence_only");

            const consumed = await reconcilePantry({
                userId,
                scope: personalScope,
                sourceType: "meal_reconciliation",
                idempotencyKey: `honesty-f1-presence-consume-${userId}`,
                operations: [
                    {
                        action: "consume",
                        inventoryItemId: item.id,
                        quantity: 1,
                    },
                ],
            });
            const updated = consumed.operations[0]?.item;
            expect(updated?.quantity).toBeNull();
            expect(updated?.quantity_mode).toBe("presence_only");
            expect(updated?.stock_state).toBe("available");

            const pantry = await getPantry({
                userId,
                scope: personalScope,
                includeDepleted: true,
            });
            const row = pantry.items.find((entry) => entry.id === item.id);
            expect(row?.quantity).toBeNull();
            expect(row?.quantity_mode).toBe("presence_only");
            expect(row?.stock_state).toBe("available");
        },
    );

    dbTest(
        "consuming exact and approximate items preserves their mode and clamps at zero",
        async () => {
            const userId = await createTestUser("f1-modes");
            const acquired = await reconcilePantry({
                userId,
                scope: personalScope,
                sourceType: "manual",
                idempotencyKey: `honesty-f1-modes-acquire-${userId}`,
                operations: [
                    {
                        action: "acquire",
                        name: "Honesty exact flour",
                        quantity: 2,
                        unit: "cup",
                    },
                    {
                        action: "acquire",
                        name: "Honesty approximate rice",
                        quantity: 3,
                        unit: "cup",
                        quantityMode: "approximate",
                    },
                ],
            });
            const exact = acquired.operations[0]?.item;
            const approximate = acquired.operations[1]?.item;
            if (!exact || !approximate)
                throw new Error("Mode acquire returned missing items");

            const consumed = await reconcilePantry({
                userId,
                scope: personalScope,
                sourceType: "meal_reconciliation",
                idempotencyKey: `honesty-f1-modes-consume-${userId}`,
                operations: [
                    {
                        action: "consume",
                        inventoryItemId: exact.id,
                        quantity: 1,
                        unit: "cup",
                    },
                    {
                        action: "consume",
                        inventoryItemId: approximate.id,
                        quantity: 1,
                        unit: "cup",
                    },
                ],
            });
            expect(consumed.operations[0]?.item.quantity).toBe(1);
            expect(consumed.operations[0]?.item.quantity_mode).toBe("exact");
            expect(consumed.operations[1]?.item.quantity).toBe(2);
            expect(consumed.operations[1]?.item.quantity_mode).toBe(
                "approximate",
            );

            const drained = await reconcilePantry({
                userId,
                scope: personalScope,
                sourceType: "meal_reconciliation",
                idempotencyKey: `honesty-f1-modes-drain-${userId}`,
                operations: [
                    {
                        action: "consume",
                        inventoryItemId: exact.id,
                        quantity: 5,
                        unit: "cup",
                    },
                ],
            });
            expect(drained.operations[0]?.item.quantity).toBe(0);
            expect(drained.operations[0]?.item.quantity_mode).toBe("exact");
            expect(drained.operations[0]?.item.stock_state).toBe("depleted");
        },
    );
});

describe("Finding 2: receipt confirmed=false veto", () => {
    dbTest(
        "unchecked high-confidence receipt line (confirmed: false) is not added to Pantry and does not check off matching Grocery item",
        async () => {
            const userId = await createTestUser("f2-veto");
            await addGroceryItems({
                userId,
                scope: personalScope,
                items: [
                    {
                        name: "Salsa",
                        quantity: 1,
                        unit: "count",
                        idempotencyKey: `honesty-f2-salsa-${userId}`,
                    },
                ],
            });

            const result = await reconcilePurchase({
                userId,
                scope: personalScope,
                idempotencyKey: `honesty-f2-receipt-${userId}`,
                sourceLabel: "Pantry honesty Finding 2 receipt",
                lines: [
                    {
                        name: "Salsa",
                        quantity: 1,
                        unit: "count",
                        confidence: 0.96,
                        isFood: true,
                        confirmed: false,
                    },
                    {
                        name: "Unchecked Chips",
                        quantity: 1,
                        unit: "bag",
                        confidence: 0.95,
                        isFood: true,
                        confirmed: false,
                    },
                    {
                        name: "Unchecked No-Confidence Pasta",
                        isFood: true,
                        confirmed: false,
                    },
                    {
                        name: "Confirmed Oats",
                        quantity: 1,
                        unit: "bag",
                        confidence: 0.92,
                        isFood: true,
                        confirmed: true,
                    },
                    {
                        name: "Confirmed Low-Conf Herbs",
                        quantity: 1,
                        unit: "bunch",
                        confidence: 0.55,
                        isFood: true,
                        confirmed: true,
                    },
                ],
            });

            expect(result.summary).toEqual({
                groceryMatched: 0,
                inventoryAdded: 2,
                ignoredNonFood: 0,
                needsReview: 3,
            });
            for (const index of [0, 1, 2]) {
                expect(result.lines[index]?.action).toBe("needs_review");
                expect(result.lines[index]?.inventory_item_id).toBeNull();
                expect(result.lines[index]?.grocery_item_id).toBeNull();
            }

            const groceries = await getGroceryList({
                userId,
                scope: personalScope,
                includePurchased: true,
            });
            const salsa = groceries.items.find((item) => item.name === "Salsa");
            expect(salsa?.purchased_at).toBeNull();

            const pantry = await getPantry({
                userId,
                scope: personalScope,
                includeDepleted: true,
            });
            const names = pantry.items.map((item) => item.normalized_name);
            expect(names).toContain("confirmed oats");
            expect(names).toContain("confirmed low conf herbs");
            expect(names).not.toContain("salsa");
            expect(names).not.toContain("unchecked chips");
            expect(names).not.toContain("unchecked no-confidence pasta");
        },
    );

    dbTest(
        "omitted confirmed field (MCP caller) preserves high-confidence auto-apply and low-confidence needs_review",
        async () => {
            const userId = await createTestUser("f2-omitted");
            const result = await reconcilePurchase({
                userId,
                scope: personalScope,
                idempotencyKey: `honesty-f2-omitted-${userId}`,
                sourceLabel: "Pantry honesty Finding 2 MCP parity receipt",
                lines: [
                    {
                        name: "MCP High Conf Milk",
                        quantity: 1,
                        unit: "gal",
                        confidence: 0.95,
                        isFood: true,
                    },
                    {
                        name: "MCP No Conf Bread",
                        quantity: 1,
                        unit: "count",
                        isFood: true,
                    },
                    {
                        name: "MCP Low Conf Mystery",
                        confidence: 0.6,
                        isFood: true,
                    },
                ],
            });
            expect(result.lines[0]?.action).toBe("inventory_added");
            expect(result.lines[1]?.action).toBe("inventory_added");
            expect(result.lines[2]?.action).toBe("needs_review");

            const pantry = await getPantry({
                userId,
                scope: personalScope,
                includeDepleted: true,
            });
            const names = pantry.items.map((item) => item.normalized_name);
            expect(names).toContain("mcp high conf milk");
            expect(names).toContain("mcp no conf bread");
            expect(names).not.toContain("mcp low conf mystery");
        },
    );

    test("purchaseLines preserves true, false, and undefined for confirmed", () => {
        const lines = purchaseLines([
            { name: "A", confirmed: true },
            { name: "B", confirmed: false },
            { name: "C" },
        ]);
        expect(lines.map((line) => line.confirmed)).toEqual([
            true,
            false,
            undefined,
        ]);
    });
});

describe("Finding 8: grocery check-off food gate", () => {
    dbTest(
        "checking off non-food grocery items creates no Pantry item while food items still stock",
        async () => {
            const userId = await createTestUser("f8-gate");
            const nonFood = [
                "Hand sanitizer",
                "Butt paste",
                "Gallon size clear bags",
                "Paper towels",
                "Laundry detergent",
            ];
            const food: Array<{
                name: string;
                quantity?: number;
                unit?: string;
            }> = [
                { name: "Granulated sugar", quantity: 2, unit: "lb" },
                { name: "Tomato paste" },
                { name: "Sponge cake" },
                { name: "Unbleached flour" },
                { name: "Cooking spray" },
                { name: "Sour cream" },
                { name: "Chicken wrap" },
                { name: "Tea bags" },
            ];
            const added = await addGroceryItems({
                userId,
                scope: personalScope,
                items: [
                    ...nonFood.map((name) => ({
                        name,
                        idempotencyKey: `honesty-f8-${userId}-${name}`,
                    })),
                    ...food.map((entry) => ({
                        ...entry,
                        idempotencyKey: `honesty-f8-${userId}-${entry.name}`,
                    })),
                ],
            });
            expect(added.items).toHaveLength(nonFood.length + food.length);
            for (const item of added.items) {
                await markGroceryItemPurchased({
                    userId,
                    scope: personalScope,
                    groceryItemId: String(item.id),
                    purchased: true,
                    expectedVersion: Number(item.version),
                });
            }

            const groceries = await getGroceryList({
                userId,
                scope: personalScope,
                includePurchased: true,
            });
            for (const name of [
                ...nonFood,
                ...food.map((entry) => entry.name),
            ]) {
                const row = groceries.items.find((item) => item.name === name);
                expect(row?.purchased_at).not.toBeNull();
            }

            const pantry = await getPantry({
                userId,
                scope: personalScope,
                includeDepleted: true,
            });
            const names = pantry.items.map((item) => item.normalized_name);
            for (const name of nonFood) {
                expect(names).not.toContain(name.toLowerCase());
            }
            for (const entry of food) {
                expect(names).toContain(entry.name.toLowerCase());
            }
            const sugar = pantry.items.find(
                (item) => item.normalized_name === "granulated sugar",
            );
            expect(sugar?.quantity).toBe(2);
            expect(sugar?.unit).toBe("lb");
        },
    );

    dbTest(
        "explicit isFood: false vetoes Pantry stocking even for unrecognized names",
        async () => {
            const userId = await createTestUser("f8-veto");
            const added = await addGroceryItems({
                userId,
                scope: personalScope,
                items: [
                    {
                        name: "Stainless steel widget polish",
                        isFood: false,
                        idempotencyKey: `honesty-f8-veto-${userId}`,
                    },
                ],
            });
            const item = added.items[0];
            if (!item) throw new Error("Explicit-veto grocery add failed");
            await markGroceryItemPurchased({
                userId,
                scope: personalScope,
                groceryItemId: String(item.id),
                purchased: true,
                expectedVersion: Number(item.version),
            });
            const pantry = await getPantry({
                userId,
                scope: personalScope,
                includeDepleted: true,
            });
            expect(
                pantry.items.map((entry) => entry.normalized_name),
            ).not.toContain("stainless steel widget polish");
        },
    );

    dbTest(
        "grocery item with verified providerFoodId still stocks Pantry",
        async () => {
            const userId = await createTestUser("f8-provenance");
            const added = await addGroceryItems({
                userId,
                scope: personalScope,
                items: [
                    {
                        name: "Bath & Body Bar Chocolate",
                        foodProvider: "usda",
                        providerFoodId: "999001",
                        quantity: 1,
                        unit: "count",
                        idempotencyKey: `honesty-f8-provenance-${userId}`,
                    },
                ],
            });
            const item = added.items[0];
            if (!item) throw new Error("Provenance grocery add failed");
            await markGroceryItemPurchased({
                userId,
                scope: personalScope,
                groceryItemId: String(item.id),
                purchased: true,
                expectedVersion: Number(item.version),
            });
            const pantry = await getPantry({
                userId,
                scope: personalScope,
                includeDepleted: true,
            });
            expect(
                pantry.items.map((entry) => entry.normalized_name),
            ).toContain("bath body bar chocolate");
        },
    );
});

describe("Finding 3: draw-down reaches AI seam through real getPantry", () => {
    dbTest(
        "applyPantryDrawdown through real getPantry matches non-substring pantry item via AI and commits consumption",
        async () => {
            const userId = await createTestUser("f3-drawdown");
            const acquired = await reconcilePantry({
                userId,
                scope: personalScope,
                sourceType: "manual",
                idempotencyKey: `honesty-f3-acquire-${userId}`,
                operations: [
                    {
                        action: "acquire",
                        name: "Chicken thighs",
                        quantity: 2,
                        unit: "lb",
                        quantityMode: "approximate",
                    },
                ],
            });
            const thighs = acquired.operations[0]?.item;
            if (!thighs)
                throw new Error("Chicken thighs acquire returned no item");

            const summary = await applyPantryDrawdown(
                {
                    userId,
                    scope: personalScope,
                    sourceType: "recipe_preparation",
                    mealId: crypto.randomUUID(),
                    mealIdempotencyKey: `honesty-f3-meal-${userId}`,
                    requirements: [
                        { name: "chicken breast", quantity: 0.5, unit: "lb" },
                    ],
                },
                {
                    aiConfig: {
                        apiKey: "test-key",
                        model: "meta/muse-ember",
                        baseUrl: "https://openrouter.example/api/v1",
                        timeoutMs: 5_000,
                    },
                    fetcher: async () =>
                        new Response(
                            JSON.stringify({
                                choices: [
                                    {
                                        message: {
                                            content: JSON.stringify({
                                                matches: [
                                                    {
                                                        ingredient_index: 0,
                                                        inventory_item_id:
                                                            thighs.id,
                                                        quantity: 0.5,
                                                        unit: "lb",
                                                        remainder: "most_left",
                                                        confidence: 0.8,
                                                    },
                                                ],
                                            }),
                                        },
                                    },
                                ],
                            }),
                            {
                                status: 200,
                                headers: {
                                    "content-type": "application/json",
                                },
                            },
                        ),
                    jevConfig: null,
                },
            );
            expect(summary.status).toBe("applied");
            if (summary.status === "applied") {
                expect(summary.lines[0]).toMatchObject({
                    status: "applied",
                    via: "ai",
                    pantry_item_id: thighs.id,
                });
            }

            const pantry = await getPantry({
                userId,
                scope: personalScope,
                includeDepleted: true,
            });
            const row = pantry.items.find((item) => item.id === thighs.id);
            expect(row?.quantity).toBe(1.5);
            expect(row?.quantity_mode).toBe("approximate");
        },
    );
});
