/**
 * Stored-data sweep, Pass 1 — the deterministic pre-filter (audit §3).
 *
 * Pure functions over stored shapes: recipe-revision ingredients (their
 * `source_snapshot.automatic_nutrition` records, exactly as the
 * resolver writes them) and structured meal items. No model, no I/O,
 * read-only by construction. A flag here makes an ingredient a SUSPECT
 * only — Pass 2 (the shared A1 checker, `src/decisions/plausibility.ts`)
 * confirms or clears it. Deterministic flags alone never accuse data.
 *
 * The four audit signatures:
 *  (i)   `assumed_portion_implausible` — an assumed provider match whose
 *        implied gram weight per unit is implausible for the unit (the
 *        milk signature: a "cup" under ~100 g; generalized through the
 *        resolver's own density envelope, 0.06–2.0 g/ml).
 *  (ii)  `packaged_profile_implausible` — a packaged provider entry
 *        whose per-100 g profile is implausible for the named food
 *        class (the cheddar signature: double-digit sugar per 100 g on
 *        a hard cheese).
 *  (iii) `unresolved_in_totals` — an ingredient counted in the totals
 *        with `resolution = unresolved` (the flour signature), plus
 *        recipes sitting at `nutrition_status: partial`.
 *  (iv)  meal items whose implied kcal/100 g exceeds physical
 *        possibility (> ~900; pure fat is ~884) or whose gram weight
 *        is implausible for the stated unit.
 */

/** Volume units → ml (the resolver's table, recipe-nutrition-resolution.ts). */
export const SWEEP_VOLUME_TO_ML: Record<string, number> = {
    tsp: 4.92892159,
    tbsp: 14.7867648,
    "fl oz": 29.5735296,
    cup: 236.5882365,
    pint: 473.176473,
    quart: 946.352946,
    gallon: 3785.41178,
    ml: 1,
    l: 1000,
};

/** The resolver's sanity envelope (PR #310), reused as the flag band. */
export const MIN_PLAUSIBLE_DENSITY_G_PER_ML = 0.06;
export const MAX_PLAUSIBLE_DENSITY_G_PER_ML = 2.0;
/** Audit §3 signature (i): a "cup" under ~100 g is implausible. */
export const CUP_MIN_PLAUSIBLE_GRAMS = 100;
/** Audit §3 signature (iv): pure fat is ~884 kcal/100 g. */
export const MAX_PHYSICAL_KCAL_PER_100G = 900;
/** Audit §3 signature (ii): double-digit sugar per 100 g on hard cheese. */
export const HARD_CHEESE_MAX_PLAUSIBLE_SUGAR_PER_100G = 10;

export type SweepSignature =
    | "assumed_portion_implausible"
    | "packaged_profile_implausible"
    | "unresolved_in_totals"
    | "partial_recipe"
    | "meal_density_impossible"
    | "meal_unit_weight_implausible";

export interface StoredIngredientRecord {
    name: string;
    quantity: number | null;
    unit: string | null;
    gramWeight: number | null;
    /** Stored nutrient totals for this ingredient line. */
    nutrients: Partial<Record<string, number | null>>;
    sourceSnapshot: Record<string, unknown>;
}

export interface StoredRecipeRecord {
    nutritionStatus: string;
    ingredients: StoredIngredientRecord[];
}

export interface StoredMealItemRecord {
    name: string;
    quantity: number | null;
    portionLabel: string | null;
    gramWeight: number | null;
    nutrients: Partial<Record<string, number | null>>;
}

export interface IngredientFlag {
    index: number;
    name: string;
    signatures: SweepSignature[];
}

export interface RecipeScan {
    /** One entry per flagged ingredient, in ingredient order. */
    flagged: IngredientFlag[];
    /** Recipe-level suspicion (partial status with no flagged row). */
    recipeLevelSignatures: SweepSignature[];
    suspect: boolean;
}

export interface MealItemFlag {
    signatures: SweepSignature[];
}

function finite(value: unknown): number | null {
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function automaticNutrition(
    ingredient: StoredIngredientRecord,
): Record<string, unknown> | null {
    const auto = ingredient.sourceSnapshot?.automatic_nutrition;
    return auto && typeof auto === "object"
        ? (auto as Record<string, unknown>)
        : null;
}

function normalizeUnit(unit: string | null | undefined): string | null {
    if (!unit) return null;
    const normalized = unit
        .toLowerCase()
        .replace(/[^a-z ]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
    const aliases: Record<string, string> = {
        teaspoon: "tsp",
        teaspoons: "tsp",
        tsp: "tsp",
        tsps: "tsp",
        tablespoon: "tbsp",
        tablespoons: "tbsp",
        tbsp: "tbsp",
        tbsps: "tbsp",
        cup: "cup",
        cups: "cup",
        "fluid ounce": "fl oz",
        "fl oz": "fl oz",
        milliliter: "ml",
        milliliters: "ml",
        millilitre: "ml",
        millilitres: "ml",
        ml: "ml",
        liter: "l",
        liters: "l",
        litre: "l",
        litres: "l",
        l: "l",
        pint: "pint",
        pints: "pint",
        quart: "quart",
        quarts: "quart",
        gallon: "gallon",
        gallons: "gallon",
    };
    return aliases[normalized] ?? null;
}

/** Implied density (g/ml) for a volume unit at the given grams/unit. */
export function impliedDensity(
    unit: string | null | undefined,
    gramsPerUnit: number | null,
): number | null {
    const key = normalizeUnit(unit);
    if (!key || gramsPerUnit === null || !(gramsPerUnit > 0)) return null;
    const ml = SWEEP_VOLUME_TO_ML[key];
    return ml ? gramsPerUnit / ml : null;
}

const HARD_CHEESE_PATTERN =
    /\b(cheddar|parmesan|parmigiano|gouda|emmental|gruyere|gruyère|provolone|pecorino|manchego|asiago|swiss cheese)\b/i;

export function isHardCheeseName(
    ...names: Array<string | null | undefined>
): boolean {
    return names.some((name) => !!name && HARD_CHEESE_PATTERN.test(name));
}

function per100g(
    nutrients: Partial<Record<string, number | null>>,
    gramWeight: number | null,
    key: string,
): number | null {
    const value = finite(nutrients[key]);
    if (value === null || !gramWeight || !(gramWeight > 0)) return null;
    return (value * 100) / gramWeight;
}

/** Signatures for one stored recipe ingredient (Pass 1, signatures i–iii). */
export function scanRecipeIngredient(
    ingredient: StoredIngredientRecord,
): SweepSignature[] {
    const signatures: SweepSignature[] = [];
    const auto = automaticNutrition(ingredient);
    const resolution =
        typeof auto?.resolution === "string" ? auto.resolution : null;

    // (iii) the flour signature — counted in totals while unresolved.
    if (resolution === "unresolved") {
        signatures.push("unresolved_in_totals");
    }

    // (i) the milk signature — assumed match, implausible implied weight.
    if (resolution === "assumed_provider_match") {
        const unitKey = normalizeUnit(ingredient.unit);
        let gramsPerUnit = finite(auto?.implied_grams_per_unit);
        if (
            gramsPerUnit === null &&
            ingredient.gramWeight !== null &&
            ingredient.quantity !== null &&
            ingredient.quantity > 0
        ) {
            gramsPerUnit = ingredient.gramWeight / ingredient.quantity;
        }
        const density = impliedDensity(ingredient.unit, gramsPerUnit);
        const cupTooLight =
            unitKey === "cup" &&
            gramsPerUnit !== null &&
            gramsPerUnit < CUP_MIN_PLAUSIBLE_GRAMS;
        const densityInsane =
            density !== null &&
            (density < MIN_PLAUSIBLE_DENSITY_G_PER_ML ||
                density > MAX_PLAUSIBLE_DENSITY_G_PER_ML);
        if (cupTooLight || densityInsane) {
            signatures.push("assumed_portion_implausible");
        }
    }

    // (ii) the cheddar signature — packaged profile wrong for its class.
    if (auto?.provider_data_kind === "packaged") {
        const sugarPer100g = per100g(
            ingredient.nutrients,
            ingredient.gramWeight,
            "sugar_g",
        );
        const providerFoodName =
            typeof auto?.provider_food_name === "string"
                ? auto.provider_food_name
                : null;
        if (
            sugarPer100g !== null &&
            sugarPer100g > HARD_CHEESE_MAX_PLAUSIBLE_SUGAR_PER_100G &&
            isHardCheeseName(ingredient.name, providerFoodName)
        ) {
            signatures.push("packaged_profile_implausible");
        }
    }

    return signatures;
}

export function scanRecipe(recipe: StoredRecipeRecord): RecipeScan {
    const flagged: IngredientFlag[] = [];
    recipe.ingredients.forEach((ingredient, index) => {
        const signatures = scanRecipeIngredient(ingredient);
        if (signatures.length > 0) {
            flagged.push({ index, name: ingredient.name, signatures });
        }
    });
    const recipeLevelSignatures: SweepSignature[] = [];
    // (iii) recipes sitting at partial are suspects even when the
    // offending row carries no snapshot (pre-snapshot saves).
    if (recipe.nutritionStatus === "partial" && flagged.length === 0) {
        recipeLevelSignatures.push("partial_recipe");
    }
    return {
        flagged,
        recipeLevelSignatures,
        suspect: flagged.length > 0 || recipeLevelSignatures.length > 0,
    };
}

/**
 * The volume a meal item's portion label declares ("1 cup", "1/2 cup",
 * "8 fl oz") — a leading amount + volume unit, the resolver's rule.
 * Labels that merely mention a volume word declare nothing.
 */
export function portionLabelVolumeMl(
    portionLabel: string | null,
): number | null {
    if (!portionLabel) return null;
    const match = portionLabel
        .trim()
        .match(
            /^(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*(cups?|tablespoons?|tbsp|teaspoons?|tsp|fl\.?\s*oz|milliliters?|millilitres?|ml|liters?|litres?|l|pints?|quarts?|gallons?)\b/i,
        );
    if (!match) return null;
    let amount = 0;
    for (const part of match[1]!.trim().split(/\s+/)) {
        const fraction = part.match(/^(\d+)\/(\d+)$/);
        if (fraction) {
            if (Number(fraction[2]) === 0) return null;
            amount += Number(fraction[1]) / Number(fraction[2]);
        } else if (/^\d+(?:\.\d+)?$/.test(part)) {
            amount += Number(part);
        } else {
            return null;
        }
    }
    const unit = normalizeUnit(match[2]!.replace(/\./g, ""));
    if (!unit || !(amount > 0)) return null;
    const ml = SWEEP_VOLUME_TO_ML[unit];
    return ml ? amount * ml : null;
}

/** Signatures for one stored meal item (Pass 1, signature iv). */
export function scanMealItem(item: StoredMealItemRecord): MealItemFlag {
    const signatures: SweepSignature[] = [];
    const kcalPer100g = per100g(item.nutrients, item.gramWeight, "calories");
    if (kcalPer100g !== null && kcalPer100g > MAX_PHYSICAL_KCAL_PER_100G) {
        signatures.push("meal_density_impossible");
    }
    const labelMl = portionLabelVolumeMl(item.portionLabel);
    if (
        labelMl !== null &&
        item.gramWeight !== null &&
        item.gramWeight > 0 &&
        item.quantity !== null &&
        item.quantity > 0
    ) {
        // The label states the volume of ONE stated unit; the stored
        // gram weight covers `quantity` such units.
        const gramsPerUnit = item.gramWeight / item.quantity;
        const unitMl = labelMl / item.quantity;
        const density = gramsPerUnit / unitMl;
        const labelUnit = normalizeUnit(
            item.portionLabel
                .trim()
                .match(
                    /(cups?|tablespoons?|tbsp|teaspoons?|tsp|fl\.?\s*oz|milliliters?|millilitres?|ml|liters?|litres?|l|pints?|quarts?|gallons?)\b/i,
                )?.[1]
                ?.replace(/\./g, "") ?? null,
        );
        const cupTooLight =
            labelUnit === "cup" && gramsPerUnit < CUP_MIN_PLAUSIBLE_GRAMS;
        if (
            cupTooLight ||
            density < MIN_PLAUSIBLE_DENSITY_G_PER_ML ||
            density > MAX_PLAUSIBLE_DENSITY_G_PER_ML
        ) {
            signatures.push("meal_unit_weight_implausible");
        }
    }
    return { signatures };
}
