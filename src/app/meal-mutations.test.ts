import { describe, expect, test } from "bun:test";
import {
    addStructuredMealItem,
    deleteStructuredMealItem,
    recomputeParentTotals,
    updateStructuredMealItem,
} from "./meal-mutations.js";
import { getPlatformDatabase } from "../platform/database.js";
import { insertStructuredMeal } from "../structured-meals/repository.js";
import type { DatabaseTransaction } from "../platform/database.js";
import type { StructuredMealItemInput } from "../structured-meals/types.js";

/**
 * W2 data-integrity F3: recomputeParentTotals must preserve NULL for
 * unrecorded partial nutrients (fiber/sugar/alcohol) instead of
 * coalescing them to 0 — `null` means "not recorded" and `0` means
 * "recorded zero" for dayCarries / trends / the range contract.
 */

interface CapturedCall {
    sql: string;
    values: unknown[];
}

/** A fake DatabaseTransaction that serves one canned SELECT row from
 *  munch.meal_items and captures every statement + bound values. */
function makeTx(selectRow: Record<string, unknown>) {
    const calls: CapturedCall[] = [];
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        calls.push({ sql, values });
        if (sql.includes("from munch.meal_items")) {
            return Promise.resolve([selectRow]);
        }
        return Promise.resolve([]);
    }) as unknown as DatabaseTransaction;
    return { tx, calls };
}

describe("recomputeParentTotals partial-nutrient NULL preservation", () => {
    test("recomputeParentTotals preserves NULL for unrecorded fiber, sugar, and alcohol while keeping headline nutrients", async () => {
        const { tx, calls } = makeTx({
            calories: 450,
            protein_g: "32",
            carbs_g: "48",
            fat_g: "14",
            fiber_g: null,
            sugar_g: null,
            alcohol_g: null,
        });
        await recomputeParentTotals(tx, "user-1", "meal-1");

        const select = calls.find((c) => c.sql.includes("select"))!;
        expect(select.sql).not.toContain("coalesce(sum(fiber_g)");
        expect(select.sql).not.toContain("coalesce(sum(sugar_g)");
        expect(select.sql).not.toContain("coalesce(sum(alcohol_g)");

        const update = calls.find((c) => c.sql.includes("update munch.meals"))!;
        // Bound order: calories, protein_g, carbs_g, fat_g, fiber_g,
        // sugar_g, alcohol_g, then mealId, userId.
        expect(update.values.slice(0, 7)).toEqual([
            450,
            32,
            48,
            14,
            null,
            null,
            null,
        ]);
    });

    test("recomputeParentTotals preserves explicit zero and positive values for partial nutrients", async () => {
        const { tx, calls } = makeTx({
            calories: 300,
            protein_g: "20",
            carbs_g: "30",
            fat_g: "10",
            fiber_g: "0",
            sugar_g: "12.5",
            alcohol_g: null,
        });
        await recomputeParentTotals(tx, "user-1", "meal-1");

        const update = calls.find((c) => c.sql.includes("update munch.meals"))!;
        expect(update.values.slice(0, 7)).toEqual([
            300,
            20,
            30,
            10,
            0,
            12.5,
            null,
        ]);
    });
});

const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());

describe("recomputeParentTotals against real Postgres", () => {
    test.skipIf(!hasDatabase)(
        "editing, adding, or deleting an item on a meal without fiber leaves parent fiber_g NULL in Postgres",
        async () => {
            const database = getPlatformDatabase();
            const userId = crypto.randomUUID();
            const item = (name: string): StructuredMealItemInput => ({
                name,
                quantity: 1,
                nutrients: {
                    calories: 250,
                    protein_g: 20,
                    carbs_g: 25,
                    fat_g: 8,
                },
                sourceType: "user_supplied",
            });
            try {
                await database`
                    insert into munch.users (id, email)
                    values (${userId}::uuid, ${`meal-mutations-f3-${userId}@example.test`})
                `;
                const inserted = await insertStructuredMeal(userId, {
                    description: "F3 regression meal",
                    mealType: "lunch",
                    idempotencyKey: `f3-${userId}`,
                    items: [item("Item one"), item("Item two")],
                });
                const mealId = inserted.meal.id;
                const firstItemId = inserted.meal.items[0]!.id;
                expect(inserted.meal.fiberG).toBeNull();
                expect(inserted.meal.sugarG).toBeNull();
                expect(inserted.meal.alcoholG).toBeNull();

                // Edit: doubling item one's quantity rescales its nutrients
                // (250 -> 500 kcal) and must not fabricate fiber/sugar/alcohol.
                const updated = await updateStructuredMealItem(
                    userId,
                    mealId,
                    firstItemId,
                    { quantity: 2 },
                );
                expect(updated.calories).toBe(750);
                expect(updated.fiberG).toBeNull();
                expect(updated.sugarG).toBeNull();
                expect(updated.alcoholG).toBeNull();

                // Add an item without fiber: parent stays NULL.
                const added = await addStructuredMealItem(
                    userId,
                    mealId,
                    item("Item three"),
                );
                expect(added.fiberG).toBeNull();
                const thirdItemId = added.items.find(
                    (i) => i.name === "Item three",
                )!.id;

                // Delete it again: parent stays NULL.
                const afterDelete = await deleteStructuredMealItem(
                    userId,
                    mealId,
                    thirdItemId,
                );
                expect(afterDelete.fiberG).toBeNull();

                // Recorded zero is a real value, distinct from NULL.
                const withZero = await updateStructuredMealItem(
                    userId,
                    mealId,
                    firstItemId,
                    { nutrients: { fiber_g: 0 } },
                );
                expect(withZero.fiberG).toBe(0);

                // Clearing it back to null restores NULL on the parent.
                const cleared = await updateStructuredMealItem(
                    userId,
                    mealId,
                    firstItemId,
                    { nutrients: { fiber_g: null } },
                );
                expect(cleared.fiberG).toBeNull();
            } finally {
                await database`
                    delete from munch.meal_items where user_id = ${userId}::uuid
                `;
                await database`
                    delete from munch.meals where user_id = ${userId}::uuid
                `;
                await database`
                    delete from munch.users where id = ${userId}::uuid
                `;
            }
        },
    );
});
