import { describe, expect, test } from "bun:test";
import { getPlatformDatabase } from "../platform/database.js";
import type { StructuredMealItemInput } from "../nutrition/types.js";
import {
    createMealDraftWithItemsAndQuestions,
    getMealDraft,
} from "./repository.js";

const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());

/**
 * Integration coverage for the bulk draft-creation path (PR #360):
 * createMealDraftWithItemsAndQuestions assembles the returned draft in
 * memory from the bulk inserts' RETURNING rows instead of reading the
 * draft back, so the contract pinned here is that the returned draft is
 * IDENTICAL to a fresh getMealDraft read of the same draft — items,
 * positions, question linkage, ordering, and status included.
 */
describe("createMealDraftWithItemsAndQuestions against real Postgres", () => {
    test.skipIf(!hasDatabase)(
        "the returned draft matches a fresh read (items, questions, linkage, status)",
        async () => {
            const database = getPlatformDatabase();
            const userId = crypto.randomUUID();
            const item = (
                name: string,
                calories: number,
            ): StructuredMealItemInput => ({
                name,
                quantity: 1,
                nutrients: {
                    calories,
                    protein_g: 10,
                    carbs_g: 20,
                    fat_g: 5,
                },
                sourceType: "user_supplied",
            });
            try {
                await database`
                    insert into munch.users (id, email)
                    values (${userId}::uuid, ${`draft-bulk-${userId}@example.test`})
                `;
                const created = await createMealDraftWithItemsAndQuestions({
                    userId,
                    sourceMode: "photo",
                    mealType: "lunch",
                    description: "Bulk-create regression meal",
                    items: [item("Item one", 250), item("Item two", 400)],
                    questions: [
                        {
                            questionKey: "oil_or_butter",
                            prompt: "Was item two cooked with oil or butter?",
                            impactScore: 40,
                            itemPosition: 1,
                        },
                        {
                            questionKey: "anything_else",
                            prompt: "Anything else on the plate?",
                            impactScore: 80,
                        },
                    ],
                });

                expect(created.status).toBe("awaiting_answers");
                expect(created.items).toHaveLength(2);
                expect(created.items[0]!.position).toBe(0);
                expect(created.items[1]!.position).toBe(1);
                expect(created.items[0]!.item.name).toBe("Item one");
                expect(created.items[1]!.item.name).toBe("Item two");
                expect(created.questions).toHaveLength(2);
                // Questions read back impact-first, matching loadDraft's
                // ordering contract.
                expect(created.questions[0]!.questionKey).toBe("anything_else");
                expect(created.questions[1]!.questionKey).toBe("oil_or_butter");
                // The item-linked question points at item two's row id.
                expect(created.questions[1]!.itemId).toBe(created.items[1]!.id);
                expect(created.questions[0]!.itemId).toBeNull();

                const reread = await getMealDraft(userId, created.id);
                expect(reread).not.toBeNull();
                expect(reread).toEqual(created);
            } finally {
                await database`
                    delete from munch.users where id = ${userId}::uuid
                `;
            }
        },
    );

    test.skipIf(!hasDatabase)(
        "an items-only draft is awaiting_confirmation; an empty draft stays open",
        async () => {
            const database = getPlatformDatabase();
            const userId = crypto.randomUUID();
            try {
                await database`
                    insert into munch.users (id, email)
                    values (${userId}::uuid, ${`draft-bulk-${userId}@example.test`})
                `;
                const itemsOnly = await createMealDraftWithItemsAndQuestions({
                    userId,
                    sourceMode: "text",
                    items: [
                        {
                            name: "Solo item",
                            quantity: 1,
                            nutrients: {
                                calories: 100,
                                protein_g: 5,
                                carbs_g: 10,
                                fat_g: 2,
                            },
                            sourceType: "user_supplied",
                        },
                    ],
                    questions: [],
                });
                expect(itemsOnly.status).toBe("awaiting_confirmation");
                expect(itemsOnly).toEqual(
                    await getMealDraft(userId, itemsOnly.id),
                );

                const empty = await createMealDraftWithItemsAndQuestions({
                    userId,
                    sourceMode: "text",
                    items: [],
                    questions: [],
                });
                expect(empty.status).toBe("open");
                expect(empty).toEqual(await getMealDraft(userId, empty.id));
            } finally {
                await database`
                    delete from munch.users where id = ${userId}::uuid
                `;
            }
        },
    );
});
