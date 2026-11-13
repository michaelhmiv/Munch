import { getFeatureModules } from "../feature-modules-repository.js";
import {
    getGroceryList,
    getMealPlan,
    getRecipe,
    type RecipeIngredientInput,
} from "../planning/repository.js";
import {
    isOnGroceryList,
    pantryMatchForGroceryItem,
    type PantryFlag,
} from "./grocery-pantry.js";
import {
    canonicalInventoryUnit,
    convertInventoryQuantity,
    inventoryIdentityScore,
    normalizeInventoryName,
    type InventoryMatchableItem,
} from "./matching.js";
import { getPantry, type InventoryScope } from "./repository.js";

// Cross-work slice 5 (brief §3) — plan → pantry shortfall.
//
// Deterministic math only: planned-meal ingredient needs for the week,
// scaled by planned servings, aggregated per ingredient, compared
// against pantry stock. The pantry is approximate BY DESIGN (slice 4):
// stock recorded as approximate or presence-only can never prove a
// shortfall, so a matched item in either of those modes covers the
// need. Only two states ever surface — the pantry has none of it, or
// exact stock provably falls short — and nothing here adds anything to
// a grocery list: the rundown proposes, the user adds.
//
// Ingredients without a quantity carry no measurable need and are
// excluded (a presence-only need is not grocery math). Optional
// ingredients are excluded, matching the recipe grocery-add path.

export interface ShortfallMealInput {
    planned_meal_id: string;
    recipe_name: string;
    /** Servings planned for this meal. */
    servings: number;
    /** Servings the recipe revision itself makes. */
    recipe_servings: number;
    ingredients: RecipeIngredientInput[];
}

export interface ShortfallReason {
    recipe_name: string;
    planned_meal_id: string;
    /** How many planned meals in the range use this recipe. */
    times: number;
}

export interface ShortfallItem {
    name: string;
    normalized_name: string;
    /** Total needed for the range, in need_unit. Null only when the
     * aggregated need itself had no unit-bearing quantity — not
     * produced today (quantity-less ingredients are excluded). */
    need_quantity: number;
    need_unit: string | null;
    /** Exact stock on hand, in need_unit; 0 when the pantry has none. */
    have_quantity: number;
    /** max(0, need − have), in need_unit. Always > 0 on a listed row. */
    short_quantity: number;
    pantry_state: "none" | "short";
    reasons: ShortfallReason[];
    /** First planned meal that needs this item (add provenance). */
    planned_meal_id: string;
}

const MASS_UNITS = new Set(["g", "kg", "oz", "lb"]);
const VOLUME_UNITS = new Set(["ml", "l", "cup", "tbsp", "tsp"]);

function round3(value: number): number {
    return Number(value.toFixed(3));
}

/** Aggregation family: mass and volume each collapse to a base unit so
 * 1 lb + 200 g of flour is one need; anything else keeps its own unit. */
function unitFamily(unit: string | null): { key: string; base: string | null } {
    const canonical = canonicalInventoryUnit(unit);
    if (!canonical) return { key: "unitless", base: null };
    if (MASS_UNITS.has(canonical)) return { key: "mass", base: "g" };
    if (VOLUME_UNITS.has(canonical)) return { key: "volume", base: "ml" };
    return { key: `unit:${canonical}`, base: canonical };
}

interface AggregatedNeed {
    name: string;
    normalizedName: string;
    familyKey: string;
    baseUnit: string | null;
    displayUnit: string | null;
    totalBase: number;
    reasons: Map<string, ShortfallReason>;
}

export function computePlanShortfall(
    meals: ShortfallMealInput[],
    pantryItems: InventoryMatchableItem[],
): ShortfallItem[] {
    const needs = new Map<string, AggregatedNeed>();

    for (const meal of meals) {
        const scale =
            meal.recipe_servings > 0 ? meal.servings / meal.recipe_servings : 1;
        for (const ingredient of meal.ingredients) {
            if (ingredient.optional) continue;
            if (ingredient.quantity == null || !(ingredient.quantity > 0)) {
                continue;
            }
            const normalizedName = normalizeInventoryName(ingredient.name);
            if (!normalizedName) continue;
            const family = unitFamily(ingredient.unit ?? null);
            const key = `${normalizedName}|${family.key}`;
            const inBase = convertInventoryQuantity(
                ingredient.quantity * scale,
                ingredient.unit ?? null,
                family.base,
            );
            if (inBase == null) continue;
            let need = needs.get(key);
            if (!need) {
                need = {
                    name: ingredient.name,
                    normalizedName,
                    familyKey: family.key,
                    baseUnit: family.base,
                    displayUnit: ingredient.unit ?? null,
                    totalBase: 0,
                    reasons: new Map(),
                };
                needs.set(key, need);
            }
            need.totalBase += inBase;
            const reason = need.reasons.get(meal.recipe_name);
            if (reason) {
                reason.times += 1;
            } else {
                need.reasons.set(meal.recipe_name, {
                    recipe_name: meal.recipe_name,
                    planned_meal_id: meal.planned_meal_id,
                    times: 1,
                });
            }
        }
    }

    const items: ShortfallItem[] = [];
    for (const need of needs.values()) {
        const needDisplay = convertInventoryQuantity(
            need.totalBase,
            need.baseUnit,
            need.displayUnit,
        );
        if (needDisplay == null || needDisplay <= 0) continue;

        const candidates = pantryItems.filter((item) => {
            if (item.stock_state === "depleted") return false;
            const score = inventoryIdentityScore(item, { name: need.name });
            if (score < 0.62) return false;
            const itemUnit = canonicalInventoryUnit(item.unit);
            if (!itemUnit || !need.baseUnit) return true;
            const family = unitFamily(item.unit);
            return family.key === need.familyKey;
        });

        if (candidates.length === 0) {
            items.push({
                name: need.name,
                normalized_name: need.normalizedName,
                need_quantity: round3(needDisplay),
                need_unit: need.displayUnit,
                have_quantity: 0,
                short_quantity: round3(needDisplay),
                pantry_state: "none",
                reasons: [...need.reasons.values()],
                planned_meal_id: [...need.reasons.values()][0]!.planned_meal_id,
            });
            continue;
        }

        // Approximate or presence-only stock can never prove a
        // shortfall — the pantry record is approximate by design.
        const hasApproximate = candidates.some(
            (item) => item.quantity_mode !== "exact" || item.quantity == null,
        );
        if (hasApproximate) continue;

        let haveBase = 0;
        for (const item of candidates) {
            const converted = convertInventoryQuantity(
                item.quantity!,
                item.unit,
                need.baseUnit,
            );
            if (converted != null) haveBase += converted;
        }
        if (haveBase + 1e-9 >= need.totalBase) continue;
        const haveDisplay =
            convertInventoryQuantity(
                haveBase,
                need.baseUnit,
                need.displayUnit,
            ) ?? 0;
        const shortDisplay = needDisplay - haveDisplay;
        if (shortDisplay <= 0.005) continue;
        items.push({
            name: need.name,
            normalized_name: need.normalizedName,
            need_quantity: round3(needDisplay),
            need_unit: need.displayUnit,
            have_quantity: round3(haveDisplay),
            short_quantity: round3(shortDisplay),
            pantry_state: "short",
            reasons: [...need.reasons.values()],
            planned_meal_id: [...need.reasons.values()][0]!.planned_meal_id,
        });
    }

    items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
}

/**
 * A rundown row plus its presence flag (owner ruling, Nov 13). The
 * flag and the row stay separate channels: the flag reports presence
 * (have / none / already on the list), the row reports the quantity
 * math that put it here. A "short" row is by definition in the
 * pantry — its flag says "have" while the row says how short the
 * exact stock falls; presence-only rows never reach this surface at
 * all (the #283 boundary above is unchanged).
 */
export interface ShortfallItemWithFlag extends ShortfallItem {
    on_list: boolean;
    pantry_flag: PantryFlag;
}

export interface PlanShortfallResult {
    enabled: boolean;
    start: string;
    end: string;
    items: ShortfallItemWithFlag[];
}

/**
 * Service assembly: feature-module gate first (plan + groceries +
 * pantry all on, else the surface simply does not exist), then the
 * week's planned meals at their pinned revisions, then pantry stock.
 */
export async function getPlanShortfall(input: {
    userId: string;
    startDate: string;
    endDate: string;
    scope: InventoryScope;
}): Promise<PlanShortfallResult> {
    const base = { start: input.startDate, end: input.endDate };
    const flags = await getFeatureModules(input.userId);
    if (!flags.plan || !flags.groceries || !flags.pantry) {
        return { enabled: false, ...base, items: [] };
    }
    const pantry = await getPantry({
        userId: input.userId,
        scope: input.scope,
        limit: 200,
    });
    if (!pantry.enabled) {
        return { enabled: false, ...base, items: [] };
    }
    const planned = await getMealPlan({
        userId: input.userId,
        startDate: input.startDate,
        endDate: input.endDate,
        scope: input.scope.type,
    });
    const meals: ShortfallMealInput[] = [];
    for (const meal of planned) {
        const recipe = await getRecipe(
            input.userId,
            meal.recipe_id,
            meal.recipe_revision_id,
        );
        if (!recipe) continue;
        meals.push({
            planned_meal_id: meal.planned_meal_id,
            recipe_name: meal.recipe_name,
            servings: meal.servings,
            recipe_servings: recipe.servings,
            ingredients: recipe.ingredients.map((ingredient) => ({
                name: ingredient.name,
                quantity: ingredient.quantity ?? undefined,
                unit: ingredient.unit ?? undefined,
                optional: ingredient.optional,
                sourceType: "user_supplied",
            })),
        });
    }
    const openList = await getGroceryList({
        userId: input.userId,
        scope: input.scope,
        includePurchased: false,
    });
    return {
        enabled: true,
        ...base,
        items: computePlanShortfall(meals, pantry.items).map((item) => {
            const onList = isOnGroceryList(
                { name: item.name, unit: item.need_unit },
                openList.items,
            );
            const match =
                item.pantry_state === "short"
                    ? pantryMatchForGroceryItem(
                          { name: item.name },
                          pantry.items,
                      )
                    : null;
            return {
                ...item,
                on_list: onList,
                pantry_flag: {
                    state: onList
                        ? ("listed" as const)
                        : item.pantry_state === "short"
                          ? ("have" as const)
                          : ("none" as const),
                    pantry_item_id: match?.pantry_item_id ?? null,
                    pantry_name: match?.pantry_name ?? null,
                },
            };
        }),
    };
}
