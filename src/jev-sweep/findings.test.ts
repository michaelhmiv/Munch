import { afterAll, describe, expect, test } from "bun:test";
import {
    closePlatformDatabase,
    getPlatformDatabase,
} from "../platform/database.js";
import { recordSweepFindings, sweepFindingPayload } from "./findings.js";
import type { SweepFinding } from "./sweep.js";

/**
 * Regression coverage for the first live sweep run (2026-11-13): the
 * findings insert bound its payload as a pre-stringified string, Bun's
 * SQL driver encoded it a second time, and the row landed as a JSON
 * string — violating `jev_sweep_findings_payload_object` (SQLSTATE
 * 23514) and aborting the run with zero findings recorded.
 *
 * The payload-shape tests pin what each finding kind persists. The
 * persistence test exercises the REAL insert (`recordSweepFindings`)
 * against a migrated database and proves the payload round-trips as a
 * jsonb OBJECT; it runs wherever DATABASE_URL is set (the CI database
 * job) and skips in the no-database quality job. On the old binding it
 * fails with the same 23514 violation production hit.
 */

const healedFinding: SweepFinding = {
    kind: "recipe_healed",
    userId: "00000000-0000-4000-8000-000000000001",
    recipeId: "00000000-0000-4000-8000-000000000002",
    beforeRevisionId: "00000000-0000-4000-8000-000000000003",
    afterRevisionId: "00000000-0000-4000-8000-000000000004",
    confirmedIngredients: ["Whole milk"],
    perServingBefore: { calories: 111.63 },
    perServingAfter: { calories: 446.52 },
};

const flaggedFinding: SweepFinding = {
    kind: "recipe_flagged",
    userId: "00000000-0000-4000-8000-000000000001",
    recipeId: "00000000-0000-4000-8000-000000000002",
    confirmedIngredients: ["Sharp cheddar"],
    signatures: ["packaged_profile_implausible"],
};

const mealCheckFinding: SweepFinding = {
    kind: "meal_check",
    userId: "00000000-0000-4000-8000-000000000001",
    mealId: "00000000-0000-4000-8000-000000000005",
    itemId: "00000000-0000-4000-8000-000000000006",
    itemName: "Millville Protein Crunchy Granola, Oats & Dark Chocolate",
    signatures: ["meal_density_impossible"],
};

describe("sweep finding payloads", () => {
    test("recipe_healed payload carries ids and before/after per-serving totals", () => {
        expect(sweepFindingPayload(healedFinding)).toEqual({
            recipe_id: healedFinding.recipeId,
            before_revision_id: healedFinding.beforeRevisionId,
            after_revision_id: healedFinding.afterRevisionId,
            confirmed_ingredients: ["Whole milk"],
            per_serving_before: { calories: 111.63 },
            per_serving_after: { calories: 446.52 },
        });
    });

    test("recipe_flagged payload carries the recipe, ingredients and signatures", () => {
        expect(sweepFindingPayload(flaggedFinding)).toEqual({
            recipe_id: flaggedFinding.recipeId,
            confirmed_ingredients: ["Sharp cheddar"],
            signatures: ["packaged_profile_implausible"],
        });
    });

    test("meal_check payload carries the meal, item and signatures", () => {
        expect(sweepFindingPayload(mealCheckFinding)).toEqual({
            meal_id: mealCheckFinding.mealId,
            item_id: mealCheckFinding.itemId,
            item_name:
                "Millville Protein Crunchy Granola, Oats & Dark Chocolate",
            signatures: ["meal_density_impossible"],
        });
    });
});

const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());
const persistenceTest = hasDatabase ? test : test.skip;

describe("sweep findings persistence", () => {
    persistenceTest(
        "recordSweepFindings stores payloads as jsonb objects that round-trip intact",
        async () => {
            const database = getPlatformDatabase();
            const userId = crypto.randomUUID();
            const recipeId = crypto.randomUUID();
            const mealId = crypto.randomUUID();
            const findings: SweepFinding[] = [
                { ...healedFinding, userId, recipeId },
                { ...flaggedFinding, userId, recipeId },
                { ...mealCheckFinding, userId, mealId },
            ];
            try {
                await database`
                    insert into munch.users (id, email)
                    values (${userId}::uuid, ${`jev-sweep-findings-${userId}@example.test`})
                `;
                await database`
                    insert into munch.recipes (
                        id, personal_owner_user_id, name,
                        created_by_user_id, updated_by_user_id
                    )
                    values (
                        ${recipeId}::uuid, ${userId}::uuid,
                        'Sweep findings regression recipe',
                        ${userId}::uuid, ${userId}::uuid
                    )
                `;
                await database`
                    insert into munch.meals (id, user_id, description)
                    values (${mealId}::uuid, ${userId}::uuid, 'Sweep findings regression meal')
                `;

                await recordSweepFindings(database, findings);

                const rows = await database<
                    Array<{
                        kind: string;
                        payload: Record<string, unknown>;
                        payload_type: string;
                    }>
                >`
                    select kind, payload, jsonb_typeof(payload) as payload_type
                    from munch.jev_sweep_findings
                    where user_id = ${userId}::uuid
                    order by kind asc
                `;
                expect(rows).toHaveLength(3);
                for (const row of rows) {
                    expect(row.payload_type).toBe("object");
                }
                const byKind = new Map(
                    rows.map((row) => [row.kind, row.payload]),
                );
                expect(byKind.get("recipe_healed")).toEqual(
                    sweepFindingPayload(findings[0]!),
                );
                expect(byKind.get("recipe_flagged")).toEqual(
                    sweepFindingPayload(findings[1]!),
                );
                expect(byKind.get("meal_check")).toEqual(
                    sweepFindingPayload(findings[2]!),
                );
            } finally {
                await database`
                    delete from munch.jev_sweep_findings
                    where user_id = ${userId}::uuid
                `;
                await database`
                    delete from munch.recipes where id = ${recipeId}::uuid
                `;
                await database`
                    delete from munch.meals where id = ${mealId}::uuid
                `;
                await database`
                    delete from munch.users where id = ${userId}::uuid
                `;
            }
        },
    );
});

afterAll(async () => {
    if (hasDatabase) {
        await closePlatformDatabase();
    }
});
