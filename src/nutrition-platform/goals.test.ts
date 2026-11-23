import { describe, expect, test } from "bun:test";
import { goalTargetsSchema } from "../guidance/contracts.js";
import { getPlatformDatabase } from "../platform/database.js";
import { getNutritionGoals, upsertNutritionGoals } from "./goals.js";

const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());

/**
 * Micro targets (2026-11-23): sodium, saturated fat, cholesterol, and
 * potassium join the goal fields. The guidance preview/apply contract
 * is a strict zod object, so the schema must accept exactly the 13
 * target fields the settings form now sends — no more, no fewer.
 */
describe("goal targets contract (micro targets)", () => {
    const full = {
        daily_calories: 2250,
        daily_protein_g: 130,
        daily_carbs_g: 225,
        daily_fat_g: 70,
        daily_fiber_g: 35,
        daily_sugar_g: null,
        daily_alcohol_g: null,
        daily_sodium_mg: 2300,
        daily_saturated_fat_g: 20,
        daily_cholesterol_mg: 300,
        daily_potassium_mg: 3500,
        daily_water_ml: 3000,
        target_weight_g: null,
    };

    test("accepts the full 13-field shape including the micros", () => {
        expect(goalTargetsSchema.parse(full)).toEqual(full);
    });

    test("rejects a payload missing a micro field (strict shape)", () => {
        const { daily_sodium_mg: _dropped, ...missing } = full;
        expect(() => goalTargetsSchema.parse(missing)).toThrow();
    });

    test("rejects unknown keys and negative micro values", () => {
        expect(() =>
            goalTargetsSchema.parse({ ...full, daily_calcium_mg: 1000 }),
        ).toThrow();
        expect(() =>
            goalTargetsSchema.parse({ ...full, daily_potassium_mg: -1 }),
        ).toThrow();
    });
});

describe("nutrition goals round-trip against real Postgres", () => {
    test.skipIf(!hasDatabase)(
        "micro targets save, read back, and clear like the other fields",
        async () => {
            const database = getPlatformDatabase();
            const userId = crypto.randomUUID();
            try {
                await database`
                    insert into munch.users (id, email)
                    values (${userId}::uuid, ${`micro-goals-${userId}@example.test`})
                `;
                const saved = await upsertNutritionGoals(
                    userId,
                    {
                        daily_calories: 2250,
                        daily_fiber_g: 35,
                        daily_sodium_mg: 2300,
                        daily_saturated_fat_g: 20.5,
                        daily_cholesterol_mg: 300,
                        daily_potassium_mg: 3500,
                    },
                    { origin: "user" },
                );
                expect(saved.daily_sodium_mg).toBe(2300);
                expect(saved.daily_saturated_fat_g).toBe(20.5);
                expect(saved.daily_cholesterol_mg).toBe(300);
                expect(saved.daily_potassium_mg).toBe(3500);

                const read = await getNutritionGoals(userId);
                expect(read?.daily_sodium_mg).toBe(2300);
                expect(read?.daily_saturated_fat_g).toBe(20.5);
                expect(read?.daily_cholesterol_mg).toBe(300);
                expect(read?.daily_potassium_mg).toBe(3500);
                expect(read?.daily_fiber_g).toBe(35);

                const cleared = await upsertNutritionGoals(
                    userId,
                    {
                        daily_calories: 2250,
                        daily_fiber_g: 35,
                        daily_sodium_mg: null,
                        daily_saturated_fat_g: 20.5,
                        daily_cholesterol_mg: 300,
                        daily_potassium_mg: 3500,
                    },
                    { origin: "user" },
                );
                expect(cleared.daily_sodium_mg).toBeNull();
                expect(cleared.daily_potassium_mg).toBe(3500);
            } finally {
                await database`
                    delete from munch.users where id = ${userId}::uuid
                `;
            }
        },
    );
});
