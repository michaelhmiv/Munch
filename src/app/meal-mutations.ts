import {
    withUserDatabase,
    type DatabaseTransaction,
} from "../platform/database.js";
import { insertMeal } from "../storage.js";
import {
    getStructuredMeal,
    insertStructuredMeal,
} from "../structured-meals/repository.js";
import type { StructuredMealItemInput } from "../structured-meals/types.js";

const NUTRIENT_COLUMNS = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "alcohol_g",
    "sodium_mg",
    "saturated_fat_g",
    "cholesterol_mg",
    "potassium_mg",
] as const;

type NutrientColumn = (typeof NUTRIENT_COLUMNS)[number];

export interface MealItemPatch {
    name?: string;
    quantity?: number;
    portionLabel?: string;
    nutrients?: Partial<Record<NutrientColumn, number | null>>;
}

export interface CopyMealInput {
    loggedAt?: string;
    mealType?: "breakfast" | "lunch" | "dinner" | "snack";
}

function numberFromRow(value: unknown): number | null {
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

async function recomputeParentTotals(
    tx: DatabaseTransaction,
    userId: string,
    mealId: string,
) {
    const rows = await tx<Array<Record<string, unknown>>>`
        select
            round(coalesce(sum(calories), 0))::integer as calories,
            coalesce(sum(protein_g), 0)::numeric as protein_g,
            coalesce(sum(carbs_g), 0)::numeric as carbs_g,
            coalesce(sum(fat_g), 0)::numeric as fat_g,
            coalesce(sum(fiber_g), 0)::numeric as fiber_g,
            coalesce(sum(sugar_g), 0)::numeric as sugar_g,
            coalesce(sum(alcohol_g), 0)::numeric as alcohol_g
        from munch.meal_items
        where user_id = ${userId}
          and meal_id = ${mealId}
    `;
    const totals = rows[0] ?? {};
    await tx`
        update munch.meals
        set calories = ${Number(totals.calories ?? 0)},
            protein_g = ${Number(totals.protein_g ?? 0)},
            carbs_g = ${Number(totals.carbs_g ?? 0)},
            fat_g = ${Number(totals.fat_g ?? 0)},
            fiber_g = ${Number(totals.fiber_g ?? 0)},
            sugar_g = ${Number(totals.sugar_g ?? 0)},
            alcohol_g = ${Number(totals.alcohol_g ?? 0)}
        where id = ${mealId}
          and user_id = ${userId}
    `;
}

export async function updateStructuredMealItem(
    userId: string,
    mealId: string,
    itemId: string,
    patch: MealItemPatch,
) {
    await withUserDatabase(userId, async (tx) => {
        const rows = await tx<Array<Record<string, unknown>>>`
            select *
            from munch.meal_items
            where id = ${itemId}
              and meal_id = ${mealId}
              and user_id = ${userId}
            limit 1
        `;
        const current = rows[0];
        if (!current) throw new Error("Meal item not found");

        const currentQuantity = numberFromRow(current.quantity);
        const nextQuantity = patch.quantity ?? currentQuantity;
        const correctedFields = [
            ...(patch.name !== undefined ? ["name"] : []),
            ...Object.keys(patch.nutrients ?? {}),
        ];
        const explicitCorrection = correctedFields.length > 0;
        const existingSnapshot =
            current.source_snapshot &&
            typeof current.source_snapshot === "object"
                ? (current.source_snapshot as Record<string, unknown>)
                : {};
        const nextSnapshot = explicitCorrection
            ? {
                  ...existingSnapshot,
                  user_correction: {
                      corrected_at: new Date().toISOString(),
                      original_source_type: current.source_type ?? null,
                      original_provider: current.provider ?? null,
                      changed_fields: correctedFields,
                  },
              }
            : existingSnapshot;
        const ratio =
            patch.quantity !== undefined &&
            currentQuantity !== null &&
            currentQuantity > 0
                ? patch.quantity / currentQuantity
                : null;

        const nextNutrients = {} as Record<NutrientColumn, number | null>;
        for (const column of NUTRIENT_COLUMNS) {
            const explicit = patch.nutrients?.[column];
            const currentValue = numberFromRow(current[column]);
            nextNutrients[column] =
                explicit !== undefined
                    ? explicit
                    : ratio !== null && currentValue !== null
                      ? currentValue * ratio
                      : currentValue;
        }

        await tx`
            update munch.meal_items
            set name = ${patch.name?.trim() || current.name},
                quantity = ${nextQuantity},
                portion_label = ${patch.portionLabel ?? current.portion_label ?? null},
                calories = ${nextNutrients.calories},
                protein_g = ${nextNutrients.protein_g},
                carbs_g = ${nextNutrients.carbs_g},
                fat_g = ${nextNutrients.fat_g},
                fiber_g = ${nextNutrients.fiber_g},
                sugar_g = ${nextNutrients.sugar_g},
                alcohol_g = ${nextNutrients.alcohol_g},
                sodium_mg = ${nextNutrients.sodium_mg},
                saturated_fat_g = ${nextNutrients.saturated_fat_g},
                cholesterol_mg = ${nextNutrients.cholesterol_mg},
                potassium_mg = ${nextNutrients.potassium_mg},
                source_type = ${explicitCorrection ? "user_supplied" : current.source_type},
                provider = ${explicitCorrection ? "user_correction" : current.provider},
                source_snapshot = ${nextSnapshot}::jsonb
            where id = ${itemId}
              and meal_id = ${mealId}
              and user_id = ${userId}
        `;
        await recomputeParentTotals(tx, userId, mealId);
    });

    const meal = await getStructuredMeal(userId, mealId);
    if (!meal) throw new Error("Meal not found");
    return meal;
}

export async function addStructuredMealItem(
    userId: string,
    mealId: string,
    item: StructuredMealItemInput,
) {
    const name = item.name.trim();
    if (!name) throw new Error("Meal item name is required");
    if (
        item.sourceUpdatedAt &&
        !Number.isFinite(new Date(item.sourceUpdatedAt).getTime())
    ) {
        throw new Error("Meal item source date is invalid");
    }
    await withUserDatabase(userId, async (tx) => {
        const mealRows = await tx<Array<{ id: string }>>`
            select id from munch.meals
            where id = ${mealId} and user_id = ${userId}
            limit 1
        `;
        if (!mealRows[0]) throw new Error("Meal not found");
        const positionRows = await tx<
            Array<{ position: number | string; count: number | string }>
        >`
            select coalesce(max(position), -1)::integer + 1 as position,
                   count(*)::integer as count
            from munch.meal_items
            where meal_id = ${mealId} and user_id = ${userId}
        `;
        if (Number(positionRows[0]?.count ?? 0) >= 100) {
            throw new Error(
                "Structured meal cannot contain more than 100 items",
            );
        }
        const position = Number(positionRows[0]?.position ?? 0);
        await tx`
            insert into munch.meal_items (
                meal_id, user_id, position, name, quantity, portion_label,
                gram_weight, calories, protein_g, carbs_g, fat_g, fiber_g,
                sugar_g, alcohol_g, sodium_mg, saturated_fat_g,
                cholesterol_mg, potassium_mg, source_type, provider,
                provider_food_id, provider_revision, source_url,
                source_updated_at, confidence, assumptions, source_snapshot
            ) values (
                ${mealId}, ${userId}, ${position}, ${name},
                ${item.quantity ?? null}, ${item.portionLabel ?? null},
                ${item.gramWeight ?? null}, ${item.nutrients.calories ?? null},
                ${item.nutrients.protein_g ?? null}, ${item.nutrients.carbs_g ?? null},
                ${item.nutrients.fat_g ?? null}, ${item.nutrients.fiber_g ?? null},
                ${item.nutrients.sugar_g ?? null}, ${item.nutrients.alcohol_g ?? null},
                ${item.nutrients.sodium_mg ?? null},
                ${item.nutrients.saturated_fat_g ?? null},
                ${item.nutrients.cholesterol_mg ?? null},
                ${item.nutrients.potassium_mg ?? null}, ${item.sourceType},
                ${item.provider ?? null}, ${item.providerFoodId ?? null},
                ${item.providerRevision ?? null}, ${item.sourceUrl ?? null},
                ${item.sourceUpdatedAt ? new Date(item.sourceUpdatedAt) : null},
                ${item.confidence ?? null}, ${item.assumptions ?? []}::jsonb,
                ${item.sourceSnapshot ?? {}}::jsonb
            )
        `;
        await recomputeParentTotals(tx, userId, mealId);
    });
    const meal = await getStructuredMeal(userId, mealId);
    if (!meal) throw new Error("Meal not found");
    return meal;
}

export async function deleteStructuredMealItem(
    userId: string,
    mealId: string,
    itemId: string,
) {
    await withUserDatabase(userId, async (tx) => {
        const rows = await tx<Array<{ count: number | string }>>`
            select count(*)::integer as count
            from munch.meal_items
            where meal_id = ${mealId}
              and user_id = ${userId}
        `;
        if (Number(rows[0]?.count ?? 0) <= 1) {
            throw new Error("A structured meal must keep at least one item");
        }
        const deleted = await tx<Array<{ id: string }>>`
            delete from munch.meal_items
            where id = ${itemId}
              and meal_id = ${mealId}
              and user_id = ${userId}
            returning id
        `;
        if (!deleted[0]) throw new Error("Meal item not found");
        await recomputeParentTotals(tx, userId, mealId);
    });

    const meal = await getStructuredMeal(userId, mealId);
    if (!meal) throw new Error("Meal not found");
    return meal;
}

export async function copyMeal(
    userId: string,
    mealId: string,
    input: CopyMealInput = {},
): Promise<{ mealId: string; structured: boolean }> {
    const source = await getStructuredMeal(userId, mealId);
    if (!source) throw new Error("Meal not found");
    const loggedAt = input.loggedAt ?? new Date().toISOString();
    const sourceType =
        source.mealType === "breakfast" ||
        source.mealType === "lunch" ||
        source.mealType === "dinner" ||
        source.mealType === "snack"
            ? source.mealType
            : "snack";
    const mealType = input.mealType ?? sourceType;
    const idempotencyKey = crypto.randomUUID();

    if (source.items.length > 0) {
        const result = await insertStructuredMeal(userId, {
            description: source.description,
            mealType,
            loggedAt,
            notes: source.notes ?? undefined,
            idempotencyKey,
            items: source.items.map((item) => ({
                name: item.name,
                quantity: item.quantity ?? undefined,
                portionLabel: item.portionLabel ?? undefined,
                gramWeight: item.gramWeight ?? undefined,
                nutrients: { ...item.nutrients },
                sourceType: item.sourceType,
                provider: item.provider ?? undefined,
                providerFoodId: item.providerFoodId ?? undefined,
                providerRevision: item.providerRevision ?? undefined,
                sourceUrl: item.sourceUrl ?? undefined,
                sourceUpdatedAt: item.sourceUpdatedAt ?? undefined,
                confidence: item.confidence ?? undefined,
                assumptions: [...item.assumptions],
                sourceSnapshot: { ...item.sourceSnapshot },
            })),
        });
        return { mealId: result.meal.id, structured: true };
    }

    const result = await insertMeal(userId, {
        description: source.description,
        meal_type: mealType,
        calories: source.calories ?? undefined,
        protein_g: source.proteinG ?? undefined,
        carbs_g: source.carbsG ?? undefined,
        fat_g: source.fatG ?? undefined,
        fiber_g: source.fiberG ?? undefined,
        sugar_g: source.sugarG ?? undefined,
        alcohol_g: source.alcoholG ?? undefined,
        logged_at: loggedAt,
        notes: source.notes ?? undefined,
        idempotency_key: idempotencyKey,
    });
    return { mealId: result.meal.id, structured: false };
}

export { NUTRIENT_COLUMNS };
