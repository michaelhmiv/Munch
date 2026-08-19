import { resolveMunchCapabilities } from "../billing/capabilities.js";
import {
    getActiveHouseholdContext,
    listHouseholdMembers,
} from "../households/repository.js";
import {
    buildNutritionRangeContract,
    inclusiveDateSpanDays,
    sumNutrition,
    validateLocalDate,
} from "../nutrition-contract.js";
import { withUserDatabase } from "../platform/database.js";
import {
    getGroceryList,
    getMealPlan,
    getRecipe,
    searchRecipes,
} from "../planning/repository.js";
import { getPublicProductPolicy } from "../product-config.js";
import { listSavedFoods } from "../saved-foods/repository.js";
import {
    getMealsByDate,
    getMealsInRange,
    getNutritionGoals,
    getProfile,
    getWaterByDate,
    getWeightByDate,
    type Meal,
} from "../storage.js";

export interface AppMealItem {
    id: string;
    mealId: string;
    position: number;
    name: string;
    quantity: number | null;
    portionLabel: string | null;
    gramWeight: number | null;
    calories: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
    fiberG: number | null;
    sugarG: number | null;
    alcoholG: number | null;
    sodiumMg: number | null;
    saturatedFatG: number | null;
    cholesterolMg: number | null;
    potassiumMg: number | null;
    sourceType: string;
    provider: string | null;
    providerFoodId: string | null;
    sourceUrl: string | null;
    sourceUpdatedAt: string | null;
    confidence: number | null;
    assumptions: string[];
}

export interface AppMeal extends Meal {
    items: AppMealItem[];
}

function numeric(value: unknown): number | null {
    return value == null ? null : Number(value);
}

async function listMealItems(
    userId: string,
    mealIds: string[],
): Promise<AppMealItem[]> {
    if (mealIds.length === 0) return [];
    const idJson = JSON.stringify(mealIds);
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<Array<Record<string, unknown>>>`
            select
                id, meal_id, position, name, quantity, portion_label, gram_weight,
                calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, alcohol_g,
                sodium_mg, saturated_fat_g, cholesterol_mg, potassium_mg,
                source_type, provider, provider_food_id, source_url,
                source_updated_at, confidence, assumptions
            from munch.meal_items
            where meal_id in (
                select value::uuid
                from jsonb_array_elements_text((${idJson}::text)::jsonb)
            )
            order by meal_id, position
        `;
        return rows.map((row) => ({
            id: String(row.id),
            mealId: String(row.meal_id),
            position: Number(row.position),
            name: String(row.name),
            quantity: numeric(row.quantity),
            portionLabel:
                row.portion_label == null ? null : String(row.portion_label),
            gramWeight: numeric(row.gram_weight),
            calories: numeric(row.calories),
            proteinG: numeric(row.protein_g),
            carbsG: numeric(row.carbs_g),
            fatG: numeric(row.fat_g),
            fiberG: numeric(row.fiber_g),
            sugarG: numeric(row.sugar_g),
            alcoholG: numeric(row.alcohol_g),
            sodiumMg: numeric(row.sodium_mg),
            saturatedFatG: numeric(row.saturated_fat_g),
            cholesterolMg: numeric(row.cholesterol_mg),
            potassiumMg: numeric(row.potassium_mg),
            sourceType: String(row.source_type),
            provider: row.provider == null ? null : String(row.provider),
            providerFoodId:
                row.provider_food_id == null
                    ? null
                    : String(row.provider_food_id),
            sourceUrl: row.source_url == null ? null : String(row.source_url),
            sourceUpdatedAt:
                row.source_updated_at == null
                    ? null
                    : new Date(String(row.source_updated_at)).toISOString(),
            confidence: numeric(row.confidence),
            assumptions: Array.isArray(row.assumptions)
                ? row.assumptions.map(String)
                : [],
        }));
    });
}

async function attachItems(userId: string, meals: Meal[]): Promise<AppMeal[]> {
    const items = await listMealItems(
        userId,
        meals.map((meal) => meal.id),
    );
    const byMeal = new Map<string, AppMealItem[]>();
    for (const item of items) {
        const group = byMeal.get(item.mealId) ?? [];
        group.push(item);
        byMeal.set(item.mealId, group);
    }
    return meals.map((meal) => ({
        ...meal,
        items: byMeal.get(meal.id) ?? [],
    }));
}

async function listOpenDrafts(userId: string) {
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<Array<Record<string, unknown>>>`
            select
                draft.id, draft.status, draft.source_mode, draft.meal_type,
                draft.description, draft.logged_at, draft.notes, draft.version,
                draft.expires_at, draft.updated_at,
                count(distinct item.id)::integer as item_count,
                count(distinct question.id)
                    filter (where question.status = 'open')::integer
                    as open_question_count
            from munch.meal_drafts draft
            left join munch.meal_draft_items item on item.draft_id = draft.id
            left join munch.meal_draft_questions question
                on question.draft_id = draft.id
            where draft.status in (
                'open',
                'awaiting_answers',
                'awaiting_confirmation'
            )
              and draft.expires_at > now()
            group by draft.id
            order by draft.updated_at desc
            limit 10
        `;
        return rows.map((row) => ({
            id: String(row.id),
            status: String(row.status),
            sourceMode: String(row.source_mode),
            mealType: row.meal_type == null ? null : String(row.meal_type),
            description:
                row.description == null ? null : String(row.description),
            loggedAt:
                row.logged_at == null
                    ? null
                    : new Date(String(row.logged_at)).toISOString(),
            notes: row.notes == null ? null : String(row.notes),
            version: Number(row.version),
            itemCount: Number(row.item_count),
            openQuestionCount: Number(row.open_question_count),
            expiresAt: new Date(String(row.expires_at)).toISOString(),
            updatedAt: new Date(String(row.updated_at)).toISOString(),
        }));
    });
}

export async function getAppBootstrap(userId: string, email: string) {
    const [profile, capabilities, household] = await Promise.all([
        getProfile(userId),
        resolveMunchCapabilities(userId),
        getActiveHouseholdContext(userId),
    ]);
    return {
        user: { id: userId, email },
        profile,
        productPolicy: getPublicProductPolicy(),
        capabilities: {
            tier: capabilities.tier,
            entitlementSource: capabilities.entitlementSource,
            historyDays: capabilities.historyDays,
            savedFoodLimit: capabilities.savedFoodLimit,
            recipes:
                capabilities.personalRecipesRead || capabilities.householdRead,
            planning:
                capabilities.personalPlanningRead || capabilities.householdRead,
            household: capabilities.householdRead,
            householdManage: capabilities.householdManage,
        },
        household,
    };
}

export async function getTodayWorkspace(userId: string, dateValue: string) {
    const date = validateLocalDate(dateValue);
    const [profile, capabilities] = await Promise.all([
        getProfile(userId),
        resolveMunchCapabilities(userId),
    ]);
    const timezone = profile?.timezone ?? "UTC";
    const [meals, goals, water, weight, drafts, plannedMeals] =
        await Promise.all([
            getMealsByDate(userId, date, timezone),
            getNutritionGoals(userId),
            getWaterByDate(userId, date, timezone),
            getWeightByDate(userId, date, timezone),
            listOpenDrafts(userId),
            capabilities.personalPlanningRead || capabilities.householdRead
                ? getMealPlan({
                      userId,
                      startDate: date,
                      endDate: date,
                      scope: "all",
                  })
                : Promise.resolve([]),
        ]);
    return {
        date,
        timezone,
        totals: sumNutrition(meals),
        meals: await attachItems(userId, meals),
        goals,
        water: {
            totalMl: water.reduce((sum, entry) => sum + entry.amount_ml, 0),
            entries: water,
        },
        weight,
        drafts,
        plannedMeals,
    };
}

export async function getMealHistoryWorkspace(
    userId: string,
    startValue: string,
    endValue: string,
) {
    const startDate = validateLocalDate(startValue);
    const endDate = validateLocalDate(endValue);
    if (inclusiveDateSpanDays(startDate, endDate) > 366) {
        throw new Error("Date range is too large");
    }
    const profile = await getProfile(userId);
    const timezone = profile?.timezone ?? "UTC";
    const meals = await getMealsInRange(userId, startDate, endDate, timezone);
    return {
        startDate,
        endDate,
        timezone,
        totals: sumNutrition(meals),
        meals: await attachItems(userId, meals),
    };
}

/**
 * Legacy compatibility endpoint for saved-food clients. The website no longer
 * exposes a Foods workspace; historical meal items are the primary user-facing
 * food memory. Keep this read contract until cached MCP catalogs have aged out.
 */
export async function getFoodsWorkspace(userId: string) {
    const capabilities = await resolveMunchCapabilities(userId);
    const foods = await listSavedFoods(userId, 200);
    return {
        deprecated: true,
        replacement: "/app/log",
        limit: capabilities.savedFoodLimit,
        total: foods.length,
        foods,
    };
}

export async function getInsightsWorkspace(
    userId: string,
    startValue: string,
    endValue: string,
) {
    const startDate = validateLocalDate(startValue);
    const endDate = validateLocalDate(endValue);
    const dayCount = inclusiveDateSpanDays(startDate, endDate);
    if (dayCount > 366) throw new Error("Date range is too large");
    const [profile, goals] = await Promise.all([
        getProfile(userId),
        getNutritionGoals(userId),
    ]);
    const timezone = profile?.timezone ?? "UTC";
    const meals = await getMealsInRange(userId, startDate, endDate, timezone);
    return buildNutritionRangeContract({
        meals,
        startDate,
        endDate,
        timezone,
        goals,
    });
}

export async function getPlanningWorkspace(
    userId: string,
    startValue: string,
    endValue: string,
) {
    const startDate = validateLocalDate(startValue);
    const endDate = validateLocalDate(endValue);
    if (inclusiveDateSpanDays(startDate, endDate) > 62) {
        throw new Error("Date range is too large");
    }
    const capabilities = await resolveMunchCapabilities(userId);
    const household = capabilities.household;
    const canRead =
        capabilities.personalPlanningRead || capabilities.householdRead;
    if (!canRead) {
        return {
            available: false,
            recipes: [],
            plannedMeals: [],
            groceries: [],
        };
    }
    const [recipes, plannedMeals, personalGroceries, householdGroceries] =
        await Promise.all([
            searchRecipes({ userId, scope: "all", limit: 50 }),
            getMealPlan({
                userId,
                startDate,
                endDate,
                scope: "all",
            }),
            capabilities.personalPlanningRead
                ? getGroceryList({
                      userId,
                      scope: { type: "personal" },
                      includePurchased: true,
                  })
                : Promise.resolve({ groceryListId: null, items: [] }),
            capabilities.householdRead && household
                ? getGroceryList({
                      userId,
                      scope: {
                          type: "household",
                          householdId: household.householdId,
                      },
                      includePurchased: true,
                  })
                : Promise.resolve({ groceryListId: null, items: [] }),
        ]);
    return {
        available: true,
        recipes,
        plannedMeals,
        groceries: [
            { scope: "personal", ...personalGroceries },
            ...(household
                ? [{ scope: "household", ...householdGroceries }]
                : []),
        ],
    };
}

export async function getRecipeWorkspace(
    userId: string,
    recipeId: string,
    revisionId?: string,
) {
    const capabilities = await resolveMunchCapabilities(userId);
    const canRead =
        capabilities.personalRecipesRead || capabilities.householdRead;
    if (!canRead) return { available: false, recipe: null };
    return {
        available: true,
        recipe: await getRecipe(userId, recipeId, revisionId),
    };
}

export async function getHouseholdWorkspace(userId: string) {
    const context = await getActiveHouseholdContext(userId);
    if (!context) return { household: null, members: [] };
    return {
        household: context,
        members: await listHouseholdMembers(userId, context.householdId),
    };
}
