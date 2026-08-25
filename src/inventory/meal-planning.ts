import { withUserDatabase } from "../platform/database.js";
import {
    evaluateRecipeAvailability,
    type IngredientRequirement,
    type RecipeAvailabilityResult,
} from "./matching.js";
import {
    classifyPantryFood,
    enrichPantryItemsBestEffort,
    getStoredPlanningProfiles,
    heuristicPlanningProfile,
    pantryPlanningEnabled,
    type PantryPlanningProfile,
} from "./planning-profile.js";
import {
    getPantry,
    type InventoryScope,
    type PantryItem,
} from "./repository.js";

export type PantryMealGoal =
    | "high_protein"
    | "low_calorie"
    | "high_fiber"
    | "use_what_i_have"
    | "balanced";

export interface PlanningPantryItem extends PantryItem {
    planning_profile: PantryPlanningProfile;
}

export interface PantryPlanningContext {
    enabled: boolean;
    planning_enabled: boolean;
    inventorySpaceId: string | null;
    items: PlanningPantryItem[];
    enrichment: {
        resolved: number;
        partial: number;
        unresolved: number;
    };
}

export interface PantryRecipeCandidate {
    recipe_id: string;
    revision_id: string;
    name: string;
    servings: number;
    nutrition_status: string;
    nutrition_per_serving: {
        calories: number | null;
        protein_g: number | null;
        carbs_g: number | null;
        fat_g: number | null;
        fiber_g: number | null;
    };
    preparation_minutes: number | null;
    cooking_minutes: number | null;
    total_minutes: number | null;
    availability: RecipeAvailabilityResult;
    flavor_support: {
        matched: string[];
        missing: string[];
        coverage: number | null;
    };
    score: number;
    score_reasons: string[];
}

interface RecipeRow {
    recipe_id: string;
    revision_id: string;
    name: string;
    servings: number;
    nutrition_status: string;
    calories_per_serving: number | null;
    protein_g_per_serving: number | null;
    carbs_g_per_serving: number | null;
    fat_g_per_serving: number | null;
    fiber_g_per_serving: number | null;
    preparation_minutes: number | null;
    cooking_minutes: number | null;
    ingredients: Array<{
        name: string;
        quantity: number | null;
        unit: string | null;
        optional: boolean;
        provider: string | null;
        provider_food_id: string | null;
    }>;
}

function numberOrNull(value: unknown): number | null {
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function nutritionFromRow(row: Record<string, unknown>) {
    return {
        calories: numberOrNull(row.calories_per_serving),
        protein_g: numberOrNull(row.protein_g_per_serving),
        carbs_g: numberOrNull(row.carbs_g_per_serving),
        fat_g: numberOrNull(row.fat_g_per_serving),
        fiber_g: numberOrNull(row.fiber_g_per_serving),
    };
}

function pantryProfileFallback(item: PantryItem): PantryPlanningProfile {
    const profile = heuristicPlanningProfile(item.id, item.name);
    return {
        ...profile,
        enriched_at: null,
        updated_at: item.updated_at,
    };
}

export async function getPantryPlanningContext(input: {
    userId: string;
    scope: InventoryScope;
    query?: string;
    location?: PantryItem["location"];
    limit?: number;
    enrichLimit?: number;
}): Promise<PantryPlanningContext> {
    const pantry = await getPantry({
        userId: input.userId,
        scope: input.scope,
        query: input.query,
        location: input.location,
        includeDepleted: false,
        limit: Math.min(200, input.limit ?? 200),
    });
    if (!pantry.enabled || !pantry.items.length) {
        return {
            ...pantry,
            planning_enabled: pantryPlanningEnabled(),
            items: [],
            enrichment: { resolved: 0, partial: 0, unresolved: 0 },
        };
    }

    const planningEnabled = pantryPlanningEnabled();
    let profiles = await getStoredPlanningProfiles(
        input.userId,
        pantry.items.map((item) => item.id),
    );
    if (planningEnabled) {
        const missing = pantry.items
            .filter((item) => !profiles.has(item.id))
            .map((item) => item.id);
        if (missing.length) {
            await enrichPantryItemsBestEffort({
                userId: input.userId,
                inventoryItemIds: missing,
                limit: input.enrichLimit ?? 24,
            });
            profiles = await getStoredPlanningProfiles(
                input.userId,
                pantry.items.map((item) => item.id),
            );
        }
    }

    const items = pantry.items.map((item) => ({
        ...item,
        planning_profile: profiles.get(item.id) ?? pantryProfileFallback(item),
    }));
    const enrichment = { resolved: 0, partial: 0, unresolved: 0 };
    for (const item of items) {
        if (item.planning_profile.profile_status === "resolved") {
            enrichment.resolved += 1;
        } else if (item.planning_profile.profile_status === "partial") {
            enrichment.partial += 1;
        } else {
            enrichment.unresolved += 1;
        }
    }
    return {
        enabled: true,
        planning_enabled: planningEnabled,
        inventorySpaceId: pantry.inventorySpaceId,
        items,
        enrichment,
    };
}

async function readSavedRecipeRows(input: {
    userId: string;
    scope: InventoryScope;
    maxMinutes?: number;
    limit?: number;
}): Promise<RecipeRow[]> {
    const limit = Math.max(1, Math.min(50, input.limit ?? 30));
    const maxMinutes =
        input.maxMinutes == null
            ? null
            : Math.max(1, Math.min(10_080, input.maxMinutes));
    return withUserDatabase(input.userId, async (tx) => {
        const householdId =
            input.scope.type === "household" ? input.scope.householdId : null;
        const rows = await tx<Array<Record<string, unknown>>>`
            select
                r.id as recipe_id,
                rev.id as revision_id,
                r.name,
                rev.servings,
                rev.nutrition_status,
                rev.calories_per_serving,
                rev.protein_g_per_serving,
                rev.carbs_g_per_serving,
                rev.fat_g_per_serving,
                rev.fiber_g_per_serving,
                rev.preparation_minutes,
                rev.cooking_minutes,
                coalesce(
                    jsonb_agg(
                        jsonb_build_object(
                            'name', ing.name,
                            'quantity', ing.quantity,
                            'unit', ing.unit,
                            'optional', ing.optional,
                            'provider', ing.provider,
                            'provider_food_id', ing.provider_food_id
                        ) order by ing.position
                    ) filter (where ing.id is not null),
                    '[]'::jsonb
                ) as ingredients
            from munch.recipes r
            join munch.recipe_revisions rev
              on rev.recipe_id = r.id
             and rev.revision_number = r.current_revision_number
            left join munch.recipe_ingredients ing
              on ing.recipe_revision_id = rev.id
            where r.archived_at is null
              and (
                    (${householdId}::uuid is null and r.personal_owner_user_id = ${input.userId})
                    or (${householdId}::uuid is not null and r.household_id = ${householdId}::uuid)
              )
              and (
                    ${maxMinutes}::integer is null
                    or coalesce(rev.preparation_minutes, 0) + coalesce(rev.cooking_minutes, 0) <= ${maxMinutes}
              )
            group by r.id, rev.id
            order by r.updated_at desc
            limit ${limit}
        `;
        return rows.map((row) => ({
            recipe_id: String(row.recipe_id),
            revision_id: String(row.revision_id),
            name: String(row.name),
            servings: Number(row.servings),
            nutrition_status: String(row.nutrition_status),
            ...nutritionFromRow(row),
            calories_per_serving: numberOrNull(row.calories_per_serving),
            protein_g_per_serving: numberOrNull(row.protein_g_per_serving),
            carbs_g_per_serving: numberOrNull(row.carbs_g_per_serving),
            fat_g_per_serving: numberOrNull(row.fat_g_per_serving),
            fiber_g_per_serving: numberOrNull(row.fiber_g_per_serving),
            preparation_minutes: numberOrNull(row.preparation_minutes),
            cooking_minutes: numberOrNull(row.cooking_minutes),
            ingredients: Array.isArray(row.ingredients)
                ? row.ingredients.map((ingredient: any) => ({
                      name: String(ingredient.name),
                      quantity: numberOrNull(ingredient.quantity),
                      unit:
                          ingredient.unit == null
                              ? null
                              : String(ingredient.unit),
                      optional: Boolean(ingredient.optional),
                      provider:
                          ingredient.provider == null
                              ? null
                              : String(ingredient.provider),
                      provider_food_id:
                          ingredient.provider_food_id == null
                              ? null
                              : String(ingredient.provider_food_id),
                  }))
                : [],
        })) as RecipeRow[];
    });
}

function ingredientRequirements(row: RecipeRow): IngredientRequirement[] {
    return row.ingredients.map((ingredient) => ({
        name: ingredient.name,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        optional: ingredient.optional,
        provider: ingredient.provider,
        providerFoodId: ingredient.provider_food_id,
    }));
}

const FLAVOR_CATEGORIES = new Set([
    "spice",
    "herb",
    "sauce_condiment",
    "acid",
    "aromatic",
    "cooking_fat",
]);

function flavorSupport(row: RecipeRow, availability: RecipeAvailabilityResult) {
    const matchedNames = new Set(
        availability.matched.map((match) => match.ingredient),
    );
    const flavorIngredients = row.ingredients
        .filter((ingredient) =>
            FLAVOR_CATEGORIES.has(classifyPantryFood(ingredient.name).category),
        )
        .map((ingredient) => ingredient.name);
    const matched = flavorIngredients.filter((name) => matchedNames.has(name));
    const missing = flavorIngredients.filter((name) => !matchedNames.has(name));
    return {
        matched,
        missing,
        coverage:
            flavorIngredients.length === 0
                ? null
                : Number(
                      (matched.length / flavorIngredients.length).toFixed(3),
                  ),
    };
}

function refinePlanningReadiness(
    availability: RecipeAvailabilityResult,
): RecipeAvailabilityResult {
    const missingCore = [
        ...availability.missing_required,
        ...availability.shortages.map((shortage) => shortage.ingredient),
    ].some((name) => {
        const classification = classifyPantryFood(name);
        return (
            classification.culinaryRoles.includes("main") ||
            classification.culinaryRoles.includes("protein")
        );
    });
    return missingCore && availability.readiness !== "missing_core"
        ? { ...availability, readiness: "missing_core" }
        : availability;
}

function goalScore(
    goal: PantryMealGoal,
    nutrition: ReturnType<typeof nutritionFromRow>,
) {
    if (goal === "high_protein") {
        const protein = nutrition.protein_g;
        return protein == null ? 0 : Math.min(30, (protein / 50) * 30);
    }
    if (goal === "low_calorie") {
        const calories = nutrition.calories;
        if (calories == null) return 0;
        return Math.max(0, Math.min(25, ((800 - calories) / 500) * 25));
    }
    if (goal === "high_fiber") {
        const fiber = nutrition.fiber_g;
        return fiber == null ? 0 : Math.min(25, (fiber / 12) * 25);
    }
    return 12;
}

function readinessScore(
    readiness: RecipeAvailabilityResult["readiness"],
): number {
    if (readiness === "ready_now") return 50;
    if (readiness === "likely_ready") return 44;
    if (readiness === "almost_there") return 26;
    return 0;
}

export function scorePantryRecipe(input: {
    goal: PantryMealGoal;
    row: RecipeRow;
    availability: RecipeAvailabilityResult;
}) {
    const nutrition = {
        calories: input.row.calories_per_serving,
        protein_g: input.row.protein_g_per_serving,
        carbs_g: input.row.carbs_g_per_serving,
        fat_g: input.row.fat_g_per_serving,
        fiber_g: input.row.fiber_g_per_serving,
    };
    const flavor = flavorSupport(input.row, input.availability);
    let score = readinessScore(input.availability.readiness);
    score += goalScore(input.goal, nutrition);
    if (flavor.coverage != null) score += flavor.coverage * 12;
    score -= input.availability.missing_required.length * 8;
    score -= input.availability.shortages.length * 7;
    score -= input.availability.missing_optional.length;

    const reasons: string[] = [];
    if (
        input.availability.readiness === "ready_now" ||
        input.availability.readiness === "likely_ready"
    ) {
        reasons.push("core ingredients are on hand");
    }
    if (input.goal === "high_protein" && (nutrition.protein_g ?? 0) >= 30) {
        reasons.push(
            `${Math.round(nutrition.protein_g!)} g protein per serving`,
        );
    }
    if ((flavor.coverage ?? 0) >= 0.75 && flavor.matched.length) {
        reasons.push("strong seasoning/sauce support from Pantry");
    }
    if (input.availability.missing_required.length === 0) {
        reasons.push("no missing required ingredient names");
    }
    return {
        score: Number(score.toFixed(2)),
        reasons,
        flavor,
    };
}

export async function rankSavedRecipesForPantry(input: {
    userId: string;
    scope: InventoryScope;
    goal?: PantryMealGoal;
    assumedStaples?: string[];
    maxMinutes?: number;
    limit?: number;
    context?: PantryPlanningContext;
}): Promise<PantryRecipeCandidate[]> {
    const [context, recipes] = await Promise.all([
        input.context
            ? Promise.resolve(input.context)
            : getPantryPlanningContext({
                  userId: input.userId,
                  scope: input.scope,
                  limit: 200,
              }),
        readSavedRecipeRows({
            userId: input.userId,
            scope: input.scope,
            maxMinutes: input.maxMinutes,
            limit: 40,
        }),
    ]);
    if (!context.enabled) return [];
    const inventory = context.items.map((item) => ({
        id: item.id,
        name: item.name,
        normalized_name: item.normalized_name,
        quantity: item.quantity,
        unit: item.unit,
        quantity_mode: item.quantity_mode,
        stock_state: item.stock_state,
        food_provider: item.food_provider,
        provider_food_id: item.provider_food_id,
    }));
    const goal = input.goal ?? "balanced";
    const candidates = recipes.map((row) => {
        const availability = refinePlanningReadiness(
            evaluateRecipeAvailability(
                ingredientRequirements(row),
                inventory,
                input.assumedStaples ?? [],
            ),
        );
        const scoring = scorePantryRecipe({ goal, row, availability });
        const nutrition = {
            calories: row.calories_per_serving,
            protein_g: row.protein_g_per_serving,
            carbs_g: row.carbs_g_per_serving,
            fat_g: row.fat_g_per_serving,
            fiber_g: row.fiber_g_per_serving,
        };
        const totalMinutes =
            row.preparation_minutes == null && row.cooking_minutes == null
                ? null
                : (row.preparation_minutes ?? 0) + (row.cooking_minutes ?? 0);
        return {
            recipe_id: row.recipe_id,
            revision_id: row.revision_id,
            name: row.name,
            servings: row.servings,
            nutrition_status: row.nutrition_status,
            nutrition_per_serving: nutrition,
            preparation_minutes: row.preparation_minutes,
            cooking_minutes: row.cooking_minutes,
            total_minutes: totalMinutes,
            availability,
            flavor_support: scoring.flavor,
            score: scoring.score,
            score_reasons: scoring.reasons,
        } satisfies PantryRecipeCandidate;
    });
    return candidates
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, Math.max(1, Math.min(12, input.limit ?? 6)));
}
