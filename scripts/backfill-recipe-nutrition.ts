#!/usr/bin/env bun

import {
    closePlatformDatabase,
    withAuthDatabase,
} from "../src/platform/database.js";
import {
    getRecipe,
    updateRecipe,
    type PlanningScope,
    type RecipeInput,
} from "../src/planning/repository.js";

const recipeIds = (process.env.MUNCH_RECIPE_NUTRITION_BACKFILL_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

if (recipeIds.length === 0) {
    console.log(
        "No recipe nutrition backfill requested; MUNCH_RECIPE_NUTRITION_BACKFILL_IDS is empty.",
    );
    process.exit(0);
}

function optionalString(value: string | null | undefined): string | undefined {
    return value == null || value.trim() === "" ? undefined : value;
}

function recipeInputFromStored(
    stored: NonNullable<Awaited<ReturnType<typeof getRecipe>>>,
): RecipeInput {
    if (!Array.isArray(stored.instructions)) {
        throw new Error(`Recipe ${stored.id} instructions are not an array`);
    }
    const instructions = stored.instructions.map((instruction) => {
        if (typeof instruction !== "string") {
            throw new Error(
                `Recipe ${stored.id} contains a non-string instruction`,
            );
        }
        return instruction;
    });

    return {
        name: stored.name,
        servings: stored.servings,
        description: optionalString(stored.description),
        instructions,
        preparationMinutes: stored.preparation_minutes ?? undefined,
        cookingMinutes: stored.cooking_minutes ?? undefined,
        sourceType: stored.source.type as RecipeInput["sourceType"],
        sourceTitle: optionalString(stored.source.title),
        sourceUrl: optionalString(stored.source.url),
        ingredients: stored.ingredients.map((ingredient) => ({
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
        })),
    };
}

async function ownershipForRecipe(recipeId: string): Promise<{
    userId: string;
    scope: PlanningScope;
}> {
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
    if (!row) {
        throw new Error(`Recipe ${recipeId} was not found or is archived`);
    }
    if (row.personal_owner_user_id) {
        return {
            userId: row.personal_owner_user_id,
            scope: { type: "personal" },
        };
    }
    if (!row.household_id) {
        throw new Error(`Recipe ${recipeId} has no valid ownership scope`);
    }
    return {
        userId: row.updated_by_user_id,
        scope: { type: "household", householdId: row.household_id },
    };
}

async function backfillRecipe(recipeId: string) {
    const { userId, scope } = await ownershipForRecipe(recipeId);
    const before = await getRecipe(userId, recipeId);
    if (!before) {
        throw new Error(
            `Recipe ${recipeId} could not be read through normal user RLS`,
        );
    }
    if (before.nutrition_status === "complete") {
        return {
            recipe_id: recipeId,
            skipped: true,
            reason: "nutrition_already_complete",
            revision_id: before.revision_id,
            revision_number: before.revision_number,
            nutrition_status: before.nutrition_status,
            nutrition_total: before.nutrition_total,
            nutrition_per_serving: before.nutrition_per_serving,
        };
    }

    const updated = await updateRecipe({
        userId,
        scope,
        recipeId,
        recipe: recipeInputFromStored(before),
        expectedVersion: before.version,
        idempotencyKey: `recipe-nutrition-backfill:${recipeId}:v${before.version}`,
    });
    const after = await getRecipe(userId, recipeId, updated.revisionId);
    if (!after) {
        throw new Error(`Recipe ${recipeId} backfill revision could not be read`);
    }
    return {
        recipe_id: recipeId,
        skipped: false,
        prior_revision_id: before.revision_id,
        prior_revision_number: before.revision_number,
        prior_nutrition_status: before.nutrition_status,
        revision_id: after.revision_id,
        revision_number: after.revision_number,
        nutrition_status: after.nutrition_status,
        nutrition_total: after.nutrition_total,
        nutrition_per_serving: after.nutrition_per_serving,
        ingredients: after.ingredients.map((ingredient) => ({
            name: ingredient.name,
            gram_weight: ingredient.gram_weight,
            nutrients: ingredient.nutrients,
            provider: ingredient.provider,
            provider_food_id: ingredient.provider_food_id,
            source_type: ingredient.source_type,
            confidence: ingredient.confidence,
            automatic_nutrition:
                ingredient.source_snapshot?.automatic_nutrition ?? null,
        })),
    };
}

try {
    for (const recipeId of recipeIds) {
        const result = await backfillRecipe(recipeId);
        console.log(JSON.stringify(result));
    }
} finally {
    await closePlatformDatabase();
}
