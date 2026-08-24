export type InventoryQuantityMode = "exact" | "approximate" | "presence_only";
export type InventoryStockState = "available" | "low" | "depleted";

export interface InventoryMatchableItem {
    id: string;
    name: string;
    normalized_name: string;
    quantity: number | null;
    unit: string | null;
    quantity_mode: InventoryQuantityMode;
    stock_state: InventoryStockState;
    food_provider: string | null;
    provider_food_id: string | null;
}

export interface IngredientRequirement {
    name: string;
    quantity?: number | null;
    unit?: string | null;
    optional?: boolean;
    provider?: string | null;
    providerFoodId?: string | null;
}

export function normalizeInventoryName(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(
            /\b(organic|fresh|large|small|medium|whole|package|pkg)\b/g,
            " ",
        )
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

const UNIT_ALIASES: Record<string, string> = {
    lb: "lb",
    lbs: "lb",
    pound: "lb",
    pounds: "lb",
    oz: "oz",
    ounce: "oz",
    ounces: "oz",
    g: "g",
    gram: "g",
    grams: "g",
    kg: "kg",
    kilogram: "kg",
    kilograms: "kg",
    ml: "ml",
    milliliter: "ml",
    milliliters: "ml",
    l: "l",
    liter: "l",
    liters: "l",
    cup: "cup",
    cups: "cup",
    tbsp: "tbsp",
    tablespoon: "tbsp",
    tablespoons: "tbsp",
    tsp: "tsp",
    teaspoon: "tsp",
    teaspoons: "tsp",
    count: "count",
    each: "count",
    whole: "count",
    item: "count",
    items: "count",
    can: "can",
    cans: "can",
    bag: "bag",
    bags: "bag",
    bottle: "bottle",
    bottles: "bottle",
};

export function canonicalInventoryUnit(value?: string | null): string | null {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return null;
    return UNIT_ALIASES[normalized] ?? normalized;
}

const MASS_UNITS = new Set(["lb", "oz", "g", "kg"]);
const VOLUME_UNITS = new Set(["ml", "l", "cup", "tbsp", "tsp"]);

export function compatibleInventoryUnits(
    left?: string | null,
    right?: string | null,
): boolean {
    const a = canonicalInventoryUnit(left);
    const b = canonicalInventoryUnit(right);
    if (!a || !b) return true;
    if (a === b) return true;
    return (
        (MASS_UNITS.has(a) && MASS_UNITS.has(b)) ||
        (VOLUME_UNITS.has(a) && VOLUME_UNITS.has(b))
    );
}

export function convertInventoryQuantity(
    value: number,
    from?: string | null,
    to?: string | null,
): number | null {
    const a = canonicalInventoryUnit(from);
    const b = canonicalInventoryUnit(to);
    if (!a || !b || a === b) return value;
    const grams: Record<string, number> = {
        g: 1,
        kg: 1000,
        oz: 28.349523125,
        lb: 453.59237,
    };
    const ml: Record<string, number> = {
        ml: 1,
        l: 1000,
        tsp: 4.92892159375,
        tbsp: 14.78676478125,
        cup: 236.5882365,
    };
    if (a in grams && b in grams) return (value * grams[a]!) / grams[b]!;
    if (a in ml && b in ml) return (value * ml[a]!) / ml[b]!;
    return null;
}

export function inventoryIdentityScore(
    item: Pick<
        InventoryMatchableItem,
        "normalized_name" | "food_provider" | "provider_food_id"
    >,
    requirement: IngredientRequirement,
): number {
    if (
        requirement.providerFoodId &&
        item.provider_food_id &&
        requirement.providerFoodId === item.provider_food_id &&
        (!requirement.provider || requirement.provider === item.food_provider)
    ) {
        return 1;
    }
    const wanted = normalizeInventoryName(requirement.name);
    const actual = item.normalized_name || normalizeInventoryName("");
    if (!wanted || !actual) return 0;
    if (wanted === actual) return 0.95;
    if (actual.includes(wanted) || wanted.includes(actual)) return 0.82;
    const a = new Set(actual.split(" "));
    const b = new Set(wanted.split(" "));
    const intersection = [...a].filter((token) => b.has(token)).length;
    const union = new Set([...a, ...b]).size;
    return union ? Math.min(0.8, intersection / union) : 0;
}

export function bestInventoryMatch(
    items: InventoryMatchableItem[],
    requirement: IngredientRequirement,
): { item: InventoryMatchableItem; score: number } | null {
    let best: { item: InventoryMatchableItem; score: number } | null = null;
    for (const item of items) {
        if (item.stock_state === "depleted") continue;
        if (!compatibleInventoryUnits(item.unit, requirement.unit)) continue;
        const score = inventoryIdentityScore(item, requirement);
        if (!best || score > best.score) best = { item, score };
    }
    return best && best.score >= 0.62 ? best : null;
}

export type RecipeReadiness =
    "ready_now" | "likely_ready" | "almost_there" | "missing_core";

export interface RecipeAvailabilityResult {
    readiness: RecipeReadiness;
    matched: Array<{
        ingredient: string;
        inventory_item_id: string;
        score: number;
        sufficient: boolean | null;
    }>;
    missing_required: string[];
    missing_optional: string[];
    shortages: Array<{
        ingredient: string;
        missing_quantity: number;
        unit: string;
    }>;
}

export function evaluateRecipeAvailability(
    ingredients: IngredientRequirement[],
    inventory: InventoryMatchableItem[],
    assumedStaples: string[] = [],
): RecipeAvailabilityResult {
    const staples = new Set(assumedStaples.map(normalizeInventoryName));
    const matched: RecipeAvailabilityResult["matched"] = [];
    const missingRequired: string[] = [];
    const missingOptional: string[] = [];
    const shortages: RecipeAvailabilityResult["shortages"] = [];
    let uncertainRequired = 0;

    for (const ingredient of ingredients) {
        if (staples.has(normalizeInventoryName(ingredient.name))) continue;
        const candidate = bestInventoryMatch(inventory, ingredient);
        if (!candidate) {
            (ingredient.optional ? missingOptional : missingRequired).push(
                ingredient.name,
            );
            continue;
        }
        let sufficient: boolean | null = null;
        if (
            ingredient.quantity &&
            ingredient.unit &&
            candidate.item.quantity != null
        ) {
            const available = convertInventoryQuantity(
                candidate.item.quantity,
                candidate.item.unit,
                ingredient.unit,
            );
            if (available != null) {
                sufficient = available + 1e-9 >= ingredient.quantity;
                if (!sufficient && !ingredient.optional) {
                    shortages.push({
                        ingredient: ingredient.name,
                        missing_quantity: Number(
                            (ingredient.quantity - available).toFixed(3),
                        ),
                        unit: ingredient.unit,
                    });
                }
            }
        }
        if (
            !ingredient.optional &&
            (candidate.item.quantity_mode !== "exact" || sufficient === null)
        ) {
            uncertainRequired += 1;
        }
        matched.push({
            ingredient: ingredient.name,
            inventory_item_id: candidate.item.id,
            score: candidate.score,
            sufficient,
        });
    }

    const effectiveMissing = missingRequired.length + shortages.length;
    const readiness: RecipeReadiness =
        effectiveMissing === 0
            ? uncertainRequired > 0
                ? "likely_ready"
                : "ready_now"
            : effectiveMissing <= 2
              ? "almost_there"
              : "missing_core";

    return {
        readiness,
        matched,
        missing_required: missingRequired,
        missing_optional: missingOptional,
        shortages,
    };
}
