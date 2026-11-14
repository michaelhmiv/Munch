#!/usr/bin/env bun
/**
 * Jev stored-data sweep — operational entry point (audit §3).
 *
 * Runs in the deployed environment (DATABASE_URL + OPENROUTER_API_KEY),
 * following the repo's operational-script pattern
 * (scripts/backfill-recipe-nutrition.ts, scripts/maintenance.ts):
 * platform DB for enumeration, normal user-RLS reads/writes for recipe
 * data, heals ONLY through updateRecipe (the existing Calculate path —
 * a NEW revision, the old revision is never mutated).
 *
 * Modes:
 *   bun scripts/jev-sweep.ts --dry-run [--backfill]
 *       Report-only: suspect counts by signature, confirmed counts,
 *       projected heals. Writes NOTHING (no heals, no findings, no
 *       watermark move). This is the mode the first live run uses.
 *   bun scripts/jev-sweep.ts --backfill
 *       One-time full scan; confirmed resolver-defect recipes heal as
 *       new revisions; meal findings are recorded for users to check.
 *   bun scripts/jev-sweep.ts [--incremental]
 *       Weekly cadence (default): records changed since the stored
 *       watermark; the watermark advances only on a completed run.
 *       Schedule off-peak (e.g. a Railway cron service, weekly):
 *         bun scripts/jev-sweep.ts --incremental
 *
 * Gate: the sweep is inert unless the plausibility seat is enabled
 * (MUNCH_JEV_PLAUSIBILITY_ENABLED=true, or the master
 * MUNCH_JEV_ENABLED=true without a seat-level off) and an OpenRouter
 * key is configured — the same flags discipline as every Jev seat.
 * Model calls send ingredient names + numbers ONLY (no user name,
 * email, account ID or recipe title) — see
 * src/decisions/plausibility.ts and its payload-inspection tests.
 * Logged meals are never written by this script.
 */
import {
    closePlatformDatabase,
    getPlatformDatabase,
    withAuthDatabase,
} from "../src/platform/database.js";
import {
    getRecipe,
    updateRecipe,
    type PlanningScope,
    type RecipeInput,
} from "../src/planning/repository.js";
import { decisionsConfig } from "../src/decisions/config.js";
import { reviewRecipePlausibility } from "../src/decisions/plausibility.js";
import {
    runSweep,
    type SweepHealOutcome,
    type SweepRecipeRecord,
    type SweepStore,
} from "../src/jev-sweep/sweep.js";
import { recordSweepFindings } from "../src/jev-sweep/findings.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const mode = args.has("--backfill") ? "backfill" : "incremental";

const config = decisionsConfig();
if (!config || !config.plausibilityEnabled) {
    console.error(
        "[jev-sweep] plausibility seat is not enabled (set MUNCH_JEV_PLAUSIBILITY_ENABLED=true or MUNCH_JEV_ENABLED=true, with OPENROUTER_API_KEY configured); sweep did not run.",
    );
    process.exit(0);
}

const database = getPlatformDatabase();

function optionalString(value: string | null | undefined): string | undefined {
    return value == null || value.trim() === "" ? undefined : value;
}

type StoredRecipe = NonNullable<Awaited<ReturnType<typeof getRecipe>>>;

async function ownershipForRecipe(recipeId: string): Promise<{
    userId: string;
    scope: PlanningScope;
} | null> {
    const rows = await withAuthDatabase(
        async (tx) =>
            tx<
                Array<{
                    personal_owner_user_id: string | null;
                    household_id: string | null;
                    updated_by_user_id: string;
                }>
            >`
                select personal_owner_user_id, household_id, updated_by_user_id
                from munch.recipes
                where id = ${recipeId}::uuid
                  and archived_at is null
                limit 1
            `,
    );
    const row = rows[0];
    if (!row) return null;
    if (row.personal_owner_user_id) {
        return {
            userId: row.personal_owner_user_id,
            scope: { type: "personal" },
        };
    }
    if (!row.household_id) return null;
    return {
        userId: row.updated_by_user_id,
        scope: { type: "household", householdId: row.household_id },
    };
}

function toSweepRecipe(
    stored: StoredRecipe,
    userId: string,
    scope: PlanningScope,
): SweepRecipeRecord {
    return {
        recipeId: stored.id,
        userId,
        scope,
        version: stored.version,
        revisionId: stored.revision_id,
        revisionNumber: stored.revision_number,
        nutritionStatus: stored.nutrition_status,
        perServingBefore: stored.nutrition_per_serving as Record<
            string,
            number | null
        >,
        updatedAt: new Date(stored.updated_at),
        ingredients: stored.ingredients.map((ingredient) => ({
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            gramWeight: ingredient.gram_weight,
            nutrients: ingredient.nutrients as Partial<
                Record<string, number | null>
            >,
            sourceSnapshot: ingredient.source_snapshot,
        })),
    };
}

/**
 * Build the heal input from the CURRENT stored recipe with the
 * confirmed-defect ingredients stripped of their stored nutrition —
 * the resolver preserves any ingredient that still carries core
 * nutrition, so stripping is what makes the Calculate path re-resolve
 * exactly the accused rows. Every other ingredient rides through
 * byte-identical.
 */
function healRecipeInput(
    stored: StoredRecipe,
    confirmedIngredientIndexes: number[],
): RecipeInput {
    const confirmed = new Set(confirmedIngredientIndexes);
    return {
        name: stored.name,
        servings: stored.servings,
        description: optionalString(stored.description),
        instructions: Array.isArray(stored.instructions)
            ? (stored.instructions as string[])
            : [],
        preparationMinutes: stored.preparation_minutes ?? undefined,
        cookingMinutes: stored.cooking_minutes ?? undefined,
        sourceType: stored.source.type as RecipeInput["sourceType"],
        sourceTitle: optionalString(stored.source.title),
        sourceUrl: optionalString(stored.source.url),
        ingredients: stored.ingredients.map((ingredient, index) => {
            if (!confirmed.has(index)) {
                return {
                    name: ingredient.name,
                    quantity: ingredient.quantity ?? undefined,
                    unit: optionalString(ingredient.unit),
                    preparation: optionalString(ingredient.preparation),
                    optional: ingredient.optional,
                    gramWeight: ingredient.gram_weight ?? undefined,
                    nutrients: ingredient.nutrients,
                    provider: optionalString(ingredient.provider),
                    providerFoodId: optionalString(ingredient.provider_food_id),
                    sourceType:
                        ingredient.source_type as RecipeInput["ingredients"][number]["sourceType"],
                    sourceUrl: optionalString(ingredient.source_url),
                    confidence: ingredient.confidence ?? undefined,
                    sourceSnapshot: ingredient.source_snapshot,
                };
            }
            const snapshot = {
                ...(ingredient.source_snapshot ?? {}),
            } as Record<string, unknown>;
            delete snapshot.automatic_nutrition;
            return {
                name: ingredient.name,
                quantity: ingredient.quantity ?? undefined,
                unit: optionalString(ingredient.unit),
                preparation: optionalString(ingredient.preparation),
                optional: ingredient.optional,
                sourceType:
                    ingredient.source_type as RecipeInput["ingredients"][number]["sourceType"],
                sourceUrl: optionalString(ingredient.source_url),
                sourceSnapshot: snapshot,
            };
        }),
    };
}

const store: SweepStore = {
    async listRecipes(since) {
        const rows = await database<Array<{ id: string }>>`
            select id::text as id
            from munch.recipes
            where archived_at is null
              and (${since}::timestamptz is null or updated_at >= ${since}::timestamptz)
            order by updated_at asc
        `;
        const recipes: SweepRecipeRecord[] = [];
        for (const row of rows) {
            const ownership = await ownershipForRecipe(row.id);
            if (!ownership) continue;
            const stored = await getRecipe(ownership.userId, row.id);
            if (!stored) continue;
            recipes.push(
                toSweepRecipe(stored, ownership.userId, ownership.scope),
            );
        }
        return recipes;
    },

    async listMealItems(since) {
        const rows = await database<Array<Record<string, unknown>>>`
            select id::text as id, meal_id::text as meal_id,
                   user_id::text as user_id, name, quantity,
                   portion_label, gram_weight, calories, protein_g,
                   carbs_g, fat_g, fiber_g, sugar_g, created_at
            from munch.meal_items
            where ${since}::timestamptz is null or created_at >= ${since}::timestamptz
            order by created_at asc
        `;
        return rows.map((row) => ({
            itemId: String(row.id),
            mealId: String(row.meal_id),
            userId: String(row.user_id),
            name: String(row.name),
            quantity: row.quantity == null ? null : Number(row.quantity),
            portionLabel:
                row.portion_label == null ? null : String(row.portion_label),
            gramWeight:
                row.gram_weight == null ? null : Number(row.gram_weight),
            nutrients: {
                calories: row.calories == null ? null : Number(row.calories),
                protein_g: row.protein_g == null ? null : Number(row.protein_g),
                carbs_g: row.carbs_g == null ? null : Number(row.carbs_g),
                fat_g: row.fat_g == null ? null : Number(row.fat_g),
                fiber_g: row.fiber_g == null ? null : Number(row.fiber_g),
                sugar_g: row.sugar_g == null ? null : Number(row.sugar_g),
            },
            updatedAt: new Date(String(row.created_at)),
        }));
    },

    async healRecipe({ recipe, confirmedIngredientIndexes, idempotencyKey }) {
        const stored = await getRecipe(recipe.userId, recipe.recipeId);
        if (!stored) throw new Error(`Recipe ${recipe.recipeId} vanished`);
        const updated = await updateRecipe({
            userId: recipe.userId,
            scope: recipe.scope as PlanningScope,
            recipeId: recipe.recipeId,
            recipe: healRecipeInput(stored, confirmedIngredientIndexes),
            expectedVersion: stored.version,
            idempotencyKey,
        });
        const outcome: SweepHealOutcome = {
            healed: updated.revisionId !== recipe.revisionId,
            newRevisionId: updated.revisionId,
            newRevisionNumber: updated.revisionNumber,
            nutritionStatus: updated.nutritionStatus,
            perServingAfter: updated.perServing as Record<
                string,
                number | null
            >,
        };
        return outcome;
    },

    async recordFindings(findings) {
        // The insert lives in src/jev-sweep/findings.ts (importable and
        // regression-tested; the payload must bind as an object, never
        // a pre-stringified string — see that module's binding law).
        await recordSweepFindings(database, findings);
    },

    async getWatermark() {
        const rows = await database<Array<{ watermark: string | null }>>`
            select watermark from munch.jev_sweep_state where id = 1
        `;
        return rows[0]?.watermark ? new Date(rows[0].watermark) : null;
    },

    async setWatermark(at) {
        await database`
            insert into munch.jev_sweep_state (id, watermark, updated_at)
            values (1, ${at.toISOString()}::timestamptz, now())
            on conflict (id) do update
                set watermark = excluded.watermark, updated_at = now()
        `;
    },
};

try {
    const report = await runSweep({
        mode: mode as "backfill" | "incremental",
        dryRun,
        store,
        review: (states, profiles) =>
            reviewRecipePlausibility(states, config, {}, profiles),
    });
    console.info(`[jev-sweep] ${JSON.stringify(report, null, 2)}`);
} finally {
    await closePlatformDatabase();
}
