import { describe, expect, test } from "bun:test";
import { isOnGroceryList } from "../inventory/grocery-pantry.js";
import type { DatabaseTransaction } from "../platform/database.js";
import {
    addGroceryItemsInTransaction,
    type GroceryItemInput,
} from "./repository.js";

/**
 * In-memory fake of the grocery slice of the database, spoken to
 * through the same tagged-template surface as the real transaction.
 * It understands both the pre-fix per-item lookup SQL and the fixed
 * load-open-rows SQL, so this file can run against unmodified main
 * (with only the `export` keyword added to
 * `addGroceryItemsInTransaction`) to demonstrate fail-before.
 */
interface FakeGroceryRow {
    id: string;
    grocery_list_id: string;
    name: string;
    normalized_name: string;
    quantity: number | null;
    unit: string | null;
    note: string | null;
    food_provider: string | null;
    provider_food_id: string | null;
    source_recipe_id: string | null;
    source_recipe_revision_id: string | null;
    source_planned_meal_id: string | null;
    idempotency_key: string | null;
    purchased_at: null;
    deleted_at: null;
    version: number;
    seq: number;
}

function makeFakeGroceryDb() {
    const rows: FakeGroceryRow[] = [];
    let listId: string | null = null;
    let seq = 0;
    let idCounter = 0;
    const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

    const tx = (async (
        strings: TemplateStringsArray,
        ...values: unknown[]
    ): Promise<Array<Record<string, unknown>>> => {
        const sql = strings.join(" ").replace(/\s+/g, " ");
        if (sql.includes("insert into munch.grocery_lists")) {
            listId = nextId("list");
            return [{ id: listId }];
        }
        if (sql.includes("from munch.grocery_lists")) {
            return listId ? [{ id: listId }] : [];
        }
        if (sql.includes("insert into munch.grocery_items")) {
            const [
                lid,
                name,
                normalized,
                quantity,
                unit,
                note,
                foodProvider,
                providerFoodId,
                sourceRecipeId,
                sourceRecipeRevisionId,
                sourcePlannedMealId,
                idempotencyKey,
            ] = values as Array<string | number | null>;
            if (
                idempotencyKey != null &&
                rows.some(
                    (row) =>
                        row.grocery_list_id === lid &&
                        row.idempotency_key === idempotencyKey,
                )
            ) {
                return [];
            }
            const row: FakeGroceryRow = {
                id: nextId("item"),
                grocery_list_id: String(lid),
                name: String(name),
                normalized_name: String(normalized),
                quantity: quantity == null ? null : Number(quantity),
                unit: unit == null ? null : String(unit),
                note: note == null ? null : String(note),
                food_provider:
                    foodProvider == null ? null : String(foodProvider),
                provider_food_id:
                    providerFoodId == null ? null : String(providerFoodId),
                source_recipe_id:
                    sourceRecipeId == null ? null : String(sourceRecipeId),
                source_recipe_revision_id:
                    sourceRecipeRevisionId == null
                        ? null
                        : String(sourceRecipeRevisionId),
                source_planned_meal_id:
                    sourcePlannedMealId == null
                        ? null
                        : String(sourcePlannedMealId),
                idempotency_key:
                    idempotencyKey == null ? null : String(idempotencyKey),
                purchased_at: null,
                deleted_at: null,
                version: 1,
                seq: ++seq,
            };
            rows.push(row);
            return [
                {
                    id: row.id,
                    name: row.name,
                    quantity: row.quantity,
                    unit: row.unit,
                    purchased_at: null,
                    version: row.version,
                },
            ];
        }
        if (sql.includes("update munch.grocery_items")) {
            const id = String(values[values.length - 1]);
            const row = rows.find((candidate) => candidate.id === id);
            if (!row) return [];
            if (sql.includes("coalesce(quantity, 0)")) {
                // Pre-fix merge: quantity is a delta.
                row.quantity = (row.quantity ?? 0) + Number(values[0]);
            } else {
                row.quantity = Number(values[0]);
            }
            row.version += 1;
            return [
                {
                    id: row.id,
                    name: row.name,
                    quantity: row.quantity,
                    unit: row.unit,
                    purchased_at: null,
                    version: row.version,
                },
            ];
        }
        if (sql.includes("from munch.grocery_items")) {
            if (sql.includes("order by created_at")) {
                // Fixed code: load every open row once, in order.
                return rows
                    .filter(
                        (row) =>
                            row.grocery_list_id === values[0] &&
                            !row.purchased_at &&
                            !row.deleted_at,
                    )
                    .sort((a, b) => a.seq - b.seq)
                    .map((row) => ({
                        id: row.id,
                        name: row.name,
                        normalized_name: row.normalized_name,
                        quantity: row.quantity,
                        unit: row.unit,
                        food_provider: row.food_provider,
                        provider_food_id: row.provider_food_id,
                        version: row.version,
                    }));
            }
            // Pre-fix code: exact normalized_name + unit lookup.
            const [lid, normalized, unit, foodProvider, providerFoodId] =
                values as Array<string | null>;
            const found = rows.find(
                (row) =>
                    row.grocery_list_id === lid &&
                    row.normalized_name === normalized &&
                    row.unit === (unit ?? null) &&
                    row.food_provider === (foodProvider ?? null) &&
                    row.provider_food_id === (providerFoodId ?? null) &&
                    !row.purchased_at &&
                    !row.deleted_at,
            );
            return found
                ? [
                      {
                          id: found.id,
                          quantity: found.quantity,
                          version: found.version,
                      },
                  ]
                : [];
        }
        throw new Error(`Fake grocery tx received unexpected SQL: ${sql}`);
    }) as unknown as DatabaseTransaction;

    return {
        tx,
        rows,
        seedOpenRow(partial: Partial<FakeGroceryRow> & { name: string }) {
            if (!listId) listId = nextId("list");
            const row: FakeGroceryRow = {
                id: nextId("item"),
                grocery_list_id: listId,
                normalized_name: partial.name.toLowerCase(),
                quantity: null,
                unit: null,
                note: null,
                food_provider: null,
                provider_food_id: null,
                source_recipe_id: null,
                source_recipe_revision_id: null,
                source_planned_meal_id: null,
                idempotency_key: null,
                purchased_at: null,
                deleted_at: null,
                version: 1,
                seq: ++seq,
                ...partial,
            };
            rows.push(row);
            return row;
        },
    };
}

const USER = "user-1";
const SCOPE = { type: "personal" } as const;

async function add(
    db: ReturnType<typeof makeFakeGroceryDb>,
    items: GroceryItemInput[],
) {
    return addGroceryItemsInTransaction(db.tx, {
        userId: USER,
        scope: SCOPE,
        items,
    });
}

describe("grocery item unit conversion and merging", () => {
    test("folds same-family mass adds across two calls (1 lb + 500 g flour) into one row", async () => {
        const db = makeFakeGroceryDb();
        await add(db, [{ name: "Flour", quantity: 1, unit: "lb" }]);
        const second = await add(db, [
            { name: "Flour", quantity: 500, unit: "g" },
        ]);
        expect(db.rows).toHaveLength(1);
        expect(db.rows[0]).toMatchObject({ unit: "lb", quantity: 2.102 });
        expect(second.items[0]!.merged).toBe(true);
    });

    test("folds volume family adds and canonicalizes plurals/case (2 cups + 1 cup, 1 cup + 4 tbsp, Lb vs lb)", async () => {
        const db = makeFakeGroceryDb();
        await add(db, [{ name: "Milk", quantity: 2, unit: "cups" }]);
        expect(db.rows[0]).toMatchObject({ unit: "cup", quantity: 2 });
        const milk = await add(db, [
            { name: "Milk", quantity: 1, unit: "cup" },
        ]);
        expect(milk.items[0]!.merged).toBe(true);

        await add(db, [{ name: "Olive oil", quantity: 1, unit: "cup" }]);
        const oil = await add(db, [
            { name: "Olive oil", quantity: 4, unit: "tbsp" },
        ]);
        expect(oil.items[0]!.merged).toBe(true);

        await add(db, [{ name: "Butter", quantity: 1, unit: "Lb" }]);
        const butter = await add(db, [
            { name: "Butter", quantity: 8, unit: "oz" },
        ]);
        expect(butter.items[0]!.merged).toBe(true);

        expect(db.rows).toHaveLength(3);
        const byName = new Map(db.rows.map((row) => [row.name, row]));
        expect(byName.get("Milk")).toMatchObject({
            quantity: 3,
            unit: "cup",
        });
        expect(byName.get("Olive oil")).toMatchObject({
            quantity: 1.25,
            unit: "cup",
        });
        expect(byName.get("Butter")).toMatchObject({
            quantity: 1.5,
            unit: "lb",
        });
    });

    test("folds same-family items within a single addGroceryItems batch", async () => {
        const db = makeFakeGroceryDb();
        await add(db, [
            { name: "Flour", quantity: 500, unit: "g" },
            { name: "Flour", quantity: 1, unit: "lb" },
        ]);
        expect(db.rows).toHaveLength(1);
        expect(db.rows[0]).toMatchObject({ quantity: 953.592, unit: "g" });
    });

    test("folds into a pre-existing row saved with legacy un-stripped normalized_name and plural unit", async () => {
        const db = makeFakeGroceryDb();
        db.seedOpenRow({
            name: "Fresh Flour",
            normalized_name: "fresh flour",
            quantity: 2,
            unit: "cups",
        });
        const result = await add(db, [
            { name: "Flour", quantity: 1, unit: "cup" },
        ]);
        expect(db.rows).toHaveLength(1);
        expect(db.rows[0]).toMatchObject({ quantity: 3 });
        expect(result.items[0]!.merged).toBe(true);
    });

    test("keeps cross-family units separate (1 cup flour + 500 g flour stay two rows)", async () => {
        const db = makeFakeGroceryDb();
        await add(db, [{ name: "Flour", quantity: 1, unit: "cup" }]);
        const second = await add(db, [
            { name: "Flour", quantity: 500, unit: "g" },
        ]);
        expect(db.rows).toHaveLength(2);
        expect(second.items[0]!.merged).toBe(false);
        const units = db.rows.map((row) => row.unit).sort();
        expect(units).toEqual(["cup", "g"]);
    });

    test("folds unitless + unitless but keeps unitless separate from unit-bearing", async () => {
        const db = makeFakeGroceryDb();
        await add(db, [{ name: "Avocado", quantity: 2 }]);
        await add(db, [{ name: "Avocado", quantity: 3 }]);
        await add(db, [{ name: "Milk", quantity: 1, unit: "gal" }]);
        const milkless = await add(db, [{ name: "Milk", quantity: 2 }]);
        expect(milkless.items[0]!.merged).toBe(false);
        expect(db.rows).toHaveLength(3);
        const avocado = db.rows.find((row) => row.name === "Avocado");
        expect(avocado).toMatchObject({ quantity: 5, unit: null });
        const milks = db.rows.filter((row) => row.name === "Milk");
        expect(milks).toHaveLength(2);
    });
});

describe("flag identity === merge identity (Finding 2)", () => {
    const pairs: Array<{
        label: string;
        existing: GroceryItemInput;
        incoming: GroceryItemInput;
        folds: boolean;
    }> = [
        {
            label: "mass family (500 g + 1 lb)",
            existing: { name: "Flour", quantity: 500, unit: "g" },
            incoming: { name: "Flour", quantity: 1, unit: "lb" },
            folds: true,
        },
        {
            label: "plural alias (2 cups + 1 cup)",
            existing: { name: "Flour", quantity: 2, unit: "cups" },
            incoming: { name: "Flour", quantity: 1, unit: "cup" },
            folds: true,
        },
        {
            label: "merchandising modifier (Fresh Flour + Flour)",
            existing: { name: "Fresh Flour", quantity: 500, unit: "g" },
            incoming: { name: "Flour", quantity: 200, unit: "g" },
            folds: true,
        },
        {
            label: "volume family (1 cup + 2 tbsp olive oil)",
            existing: { name: "Olive oil", quantity: 1, unit: "cup" },
            incoming: { name: "Olive oil", quantity: 2, unit: "tbsp" },
            folds: true,
        },
        {
            label: "cross-family (1 cup + 500 g flour)",
            existing: { name: "Flour", quantity: 1, unit: "cup" },
            incoming: { name: "Flour", quantity: 500, unit: "g" },
            folds: false,
        },
        {
            label: "unit-bearing vs unitless (1 gal milk + 2 milk)",
            existing: { name: "Milk", quantity: 1, unit: "gal" },
            incoming: { name: "Milk", quantity: 2 },
            folds: false,
        },
        {
            label: "unitless + unitless (rice)",
            existing: { name: "Rice", quantity: 2 },
            incoming: { name: "Rice", quantity: 1 },
            folds: true,
        },
        {
            label: "different ingredient (Onion vs Large Yellow Onion)",
            existing: { name: "Onion", quantity: 2, unit: "count" },
            incoming: {
                name: "Large Yellow Onion",
                quantity: 1,
                unit: "count",
            },
            folds: false,
        },
        {
            label: "modifier + count alias (Large Onion each + Onion count)",
            existing: { name: "Large Onion", quantity: 2, unit: "each" },
            incoming: { name: "Onion", quantity: 1, unit: "count" },
            folds: true,
        },
        {
            label: "distinct custom units (loaf vs slices)",
            existing: { name: "Bread", quantity: 1, unit: "loaf" },
            incoming: { name: "Bread", quantity: 2, unit: "slices" },
            folds: false,
        },
    ];

    for (const pair of pairs) {
        test(`isOnGroceryList matches whether the add folds — ${pair.label}`, async () => {
            const db = makeFakeGroceryDb();
            await add(db, [pair.existing]);
            const flagged = isOnGroceryList(
                { name: pair.incoming.name, unit: pair.incoming.unit },
                [{ name: pair.existing.name, unit: pair.existing.unit }],
            );
            const result = await add(db, [pair.incoming]);
            expect(flagged).toBe(pair.folds);
            expect(result.items[0]!.merged).toBe(flagged);
            expect(db.rows).toHaveLength(flagged ? 1 : 2);
        });
    }
});
