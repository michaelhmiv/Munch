/**
 * Recipe total yield + portion-share resolution (unit logging,
 * owner-approved 2026-11-13).
 *
 * A recipe revision may carry a SET total yield per measure family —
 * one volume slot ("12 cups") and one weight slot ("1,800 g"). When a
 * slot is unset, Amount-mode logging falls back to the deterministic
 * ingredient-sum ESTIMATE computed here. The estimate is a pure
 * function of the revision's ingredients, always labeled "estimated"
 * wherever it surfaces, and stored on every log's yield snapshot with
 * its provenance — it is never presented as measured. The estimator
 * lives behind this module boundary so the Jev yield seat (A2b) can
 * replace the anchor computation later without touching callers.
 *
 * Every recipe-log surface (recipe detail form, log-as-planned,
 * active-cook completion, MCP log_recipe) resolves its portion
 * through resolveRecipePortion: one spec in, one share out, and the
 * meal scales by that share exactly the way servings always have.
 */
import { formatRecipeQuantity } from "../quantity-format.js";
import { normalizePortionUnit } from "../food-providers/portions.js";

export type YieldFamily = "volume" | "weight";

export interface RecipeYield {
    quantity: number;
    unit: string;
}

export interface RecipeYieldSlots {
    volume: RecipeYield | null;
    weight: RecipeYield | null;
}

export interface EffectiveYield extends RecipeYield {
    family: YieldFamily;
    source: "set" | "estimated";
}

export interface EffectiveRecipeYields {
    volume: EffectiveYield | null;
    weight: EffectiveYield | null;
}

/**
 * Exact within-family conversions, matching the constants the rest of
 * the codebase already uses (inventory matching, meal-photo
 * grounding, the nutrition resolver): 1 cup = 236.5882365 ml,
 * 1 lb = 453.59237 g. Cross-family conversion does not exist here by
 * design — no density guesses, ever.
 */
const ML_PER_UNIT: Readonly<Record<string, number>> = {
    ml: 1,
    l: 1000,
    tsp: 4.92892159375,
    tbsp: 14.78676478125,
    cup: 236.5882365,
    "fl oz": 29.5735295625,
    pint: 473.176473,
    quart: 946.352946,
    gallon: 3785.411784,
};

const GRAMS_PER_UNIT: Readonly<Record<string, number>> = {
    g: 1,
    kg: 1000,
    mg: 0.001,
    oz: 28.349523125,
    lb: 453.59237,
};

const VOLUME_UNITS = [
    "cup",
    "tbsp",
    "tsp",
    "fl oz",
    "ml",
    "l",
    "pint",
    "quart",
] as const;

const WEIGHT_UNITS = ["g", "kg", "oz", "lb"] as const;

/** Canonical units offered by the pickers, per family. */
export function yieldFamilyUnits(family: YieldFamily): readonly string[] {
    return family === "volume" ? VOLUME_UNITS : WEIGHT_UNITS;
}

/** The normalized yield unit ("cups" → "cup"), or null when unknown. */
export function normalizeYieldUnit(unit: string): string | null {
    const normalized = normalizePortionUnit(unit);
    if (normalized in ML_PER_UNIT || normalized in GRAMS_PER_UNIT) {
        return normalized;
    }
    return null;
}

/** Which measure family a unit belongs to, or null for non-measures. */
export function yieldUnitFamily(unit: string): YieldFamily | null {
    const normalized = normalizeYieldUnit(unit);
    if (!normalized) return null;
    return normalized in ML_PER_UNIT ? "volume" : "weight";
}

export function isYieldUnit(unit: string): boolean {
    return yieldUnitFamily(unit) !== null;
}

/**
 * Convert a quantity between two units of the SAME family. Returns
 * null for cross-family or unknown units — callers must refuse, not
 * guess a density.
 */
export function convertYieldQuantity(
    value: number,
    fromUnit: string,
    toUnit: string,
): number | null {
    const from = normalizeYieldUnit(fromUnit);
    const to = normalizeYieldUnit(toUnit);
    if (!from || !to) return null;
    if (from === to) return value;
    if (from in ML_PER_UNIT && to in ML_PER_UNIT) {
        return (value * ML_PER_UNIT[from]!) / ML_PER_UNIT[to]!;
    }
    if (from in GRAMS_PER_UNIT && to in GRAMS_PER_UNIT) {
        return (value * GRAMS_PER_UNIT[from]!) / GRAMS_PER_UNIT[to]!;
    }
    return null;
}

export function validateYield(
    family: YieldFamily,
    yieldValue: RecipeYield,
): void {
    if (!Number.isFinite(yieldValue.quantity) || yieldValue.quantity <= 0) {
        throw new Error("Recipe yield quantity must be positive");
    }
    const unit = normalizeYieldUnit(yieldValue.unit);
    if (!unit) {
        throw new Error(
            `Recipe yield unit is not a measure: ${yieldValue.unit}`,
        );
    }
    if (yieldUnitFamily(unit) !== family) {
        throw new Error(
            `Recipe ${family} yield must use a ${family} unit, not ${yieldValue.unit}`,
        );
    }
}

export interface YieldEstimateIngredient {
    quantity?: number | null;
    unit?: string | null;
    gram_weight?: number | null;
}

/**
 * The v1 yield estimator: the deterministic ingredient-sum anchor.
 *
 * Each ingredient contributes a mass proxy and a volume proxy:
 * its resolved gram weight when it has one, otherwise its quantity
 * converted within its own family, with the other family's figure
 * carried across at water density (1 g ≈ 1 ml) purely as bulk. The
 * weight estimate is the summed mass in grams; the volume estimate
 * is the summed volume expressed in cups, snapped to the nearest
 * quarter cup. Cooking transforms (absorption, reduction) are
 * exactly what this anchor cannot see — that is why its output is
 * always labeled "estimated" and why the Jev seat replaces this
 * function, not its callers, when it lands.
 */
export function estimateRecipeYield(
    ingredients: readonly YieldEstimateIngredient[],
): RecipeYieldSlots {
    let totalGrams = 0;
    let totalMl = 0;
    let contributors = 0;
    for (const ingredient of ingredients) {
        let grams: number | null = null;
        let ml: number | null = null;
        if (
            ingredient.gram_weight != null &&
            Number.isFinite(ingredient.gram_weight) &&
            ingredient.gram_weight > 0
        ) {
            grams = ingredient.gram_weight;
            ml = ingredient.gram_weight;
        }
        if (
            ingredient.quantity != null &&
            Number.isFinite(ingredient.quantity) &&
            ingredient.quantity > 0 &&
            ingredient.unit
        ) {
            const unit = normalizeYieldUnit(ingredient.unit);
            if (unit && unit in ML_PER_UNIT) {
                ml = ingredient.quantity * ML_PER_UNIT[unit]!;
                if (grams == null) grams = ml;
            } else if (unit && unit in GRAMS_PER_UNIT) {
                grams = ingredient.quantity * GRAMS_PER_UNIT[unit]!;
                if (ml == null) ml = grams;
            }
        }
        if (grams != null && ml != null) {
            totalGrams += grams;
            totalMl += ml;
            contributors += 1;
        }
    }
    if (contributors === 0 || totalGrams <= 0 || totalMl <= 0) {
        return { volume: null, weight: null };
    }
    const cups = totalMl / ML_PER_UNIT.cup!;
    const snappedCups = Math.max(0.25, Math.round(cups * 4) / 4);
    return {
        volume: { quantity: snappedCups, unit: "cup" },
        weight: { quantity: Math.round(totalGrams), unit: "g" },
    };
}

/**
 * The yield a log is figured from, per family: the stored (set) yield
 * when the recipe carries one, otherwise the ingredient estimate.
 * The `source` rides along so every surface can label honestly.
 */
export function effectiveRecipeYields(
    stored: RecipeYieldSlots,
    ingredients: readonly YieldEstimateIngredient[],
): EffectiveRecipeYields {
    const estimates = estimateRecipeYield(ingredients);
    const pick = (
        family: YieldFamily,
        set: RecipeYield | null,
        estimated: RecipeYield | null,
    ): EffectiveYield | null => {
        if (set) {
            return {
                quantity: set.quantity,
                unit: normalizeYieldUnit(set.unit) ?? set.unit,
                family,
                source: "set",
            };
        }
        if (estimated) {
            return {
                quantity: estimated.quantity,
                unit: estimated.unit,
                family,
                source: "estimated",
            };
        }
        return null;
    };
    return {
        volume: pick("volume", stored.volume, estimates.volume),
        weight: pick("weight", stored.weight, estimates.weight),
    };
}

/* ---------------- portion specs and share resolution ---------------- */

export type RecipePortionSpec =
    | { mode: "servings"; servings: number }
    | { mode: "amount"; amount: number; unit: string }
    | {
          mode: "fraction";
          value: number;
          numerator?: number;
          denominator?: number;
      };

/**
 * The portion record stored on every item of a logged recipe meal
 * (brief §2.3 + the 2026-11-13 amendment): what the user entered, the
 * share it resolved to, and the yield it was figured from — so a
 * later yield edit never rewrites history, and an estimate-based log
 * stays honest about its provenance forever.
 */
export interface RecipePortionRecord {
    mode: "servings" | "amount" | "fraction";
    entered_amount: number | null;
    entered_unit: string | null;
    fraction_numerator: number | null;
    fraction_denominator: number | null;
    share: number;
    yield_snapshot: {
        quantity: number;
        unit: string;
        family: YieldFamily;
        source: "set" | "estimated";
    } | null;
    servings_equivalent: number;
}

export interface ResolvedRecipePortion {
    /** Full-precision share used to scale the meal. */
    factor: number;
    record: RecipePortionRecord;
    /** "1 cup" · "1/4 of the recipe" · "2 servings" — the description language. */
    label: string;
    /** "1/12" — the share as a plain fraction, for card/math lines. */
    shareLabel: string;
}

export interface RecipePortionContext {
    servings: number;
    yields: RecipeYieldSlots;
    ingredients: readonly YieldEstimateIngredient[];
}

function trimDecimal(value: number): string {
    return Number.isInteger(value)
        ? String(value)
        : String(Number(value.toFixed(3)));
}

function quantityLabel(value: number, unit?: string | null): string {
    return formatRecipeQuantity(value, unit) ?? trimDecimal(value);
}

const PLURALIZABLE_UNITS: Readonly<Record<string, string>> = {
    cup: "cups",
    pint: "pints",
    quart: "quarts",
    gallon: "gallons",
};

/** "cup" → "cups" when the formatted amount is not exactly 1. */
export function displayYieldUnit(unit: string, quantity: number): string {
    const normalized = normalizeYieldUnit(unit) ?? unit;
    if (quantity !== 1 && PLURALIZABLE_UNITS[normalized]) {
        return PLURALIZABLE_UNITS[normalized]!;
    }
    return normalized;
}

function gcd(a: number, b: number): number {
    let x = Math.abs(a);
    let y = Math.abs(b);
    while (y !== 0) {
        const next = x % y;
        x = y;
        y = next;
    }
    return x || 1;
}

/**
 * Recover a simple fraction (n/d, d ≤ 16) for a share when one fits
 * within tolerance — 1/12 stays "1/12" instead of "0.083". Returns
 * null when the share is not a simple fraction.
 */
export function shareToFraction(
    share: number,
): { numerator: number; denominator: number } | null {
    if (!Number.isFinite(share) || share <= 0) return null;
    for (let denominator = 1; denominator <= 16; denominator += 1) {
        const numerator = Math.round(share * denominator);
        if (numerator <= 0) continue;
        if (Math.abs(numerator / denominator - share) < 1e-6) {
            const divisor = gcd(numerator, denominator);
            return {
                numerator: numerator / divisor,
                denominator: denominator / divisor,
            };
        }
    }
    return null;
}

/** "1/12" for simple shares, the integer for whole shares, else a trimmed decimal. */
export function shareFractionLabel(share: number): string {
    const fraction = shareToFraction(share);
    if (fraction) {
        return fraction.denominator === 1
            ? String(fraction.numerator)
            : `${fraction.numerator}/${fraction.denominator}`;
    }
    return trimDecimal(share);
}

/**
 * Parse a fraction given as a decimal (0.25), a ratio string
 * ("1/4"), or an explicit numerator/denominator pair into a portion
 * spec, recovering the exact n/d whenever one fits — 1/3 must never
 * degrade to 0.333333 in a label.
 */
export function parseFractionSpec(input: {
    value?: number | string;
    numerator?: number;
    denominator?: number;
}): Extract<RecipePortionSpec, { mode: "fraction" }> {
    if (input.numerator !== undefined || input.denominator !== undefined) {
        const numerator = input.numerator;
        const denominator = input.denominator;
        if (
            numerator === undefined ||
            denominator === undefined ||
            !Number.isInteger(numerator) ||
            !Number.isInteger(denominator) ||
            numerator <= 0 ||
            denominator <= 0
        ) {
            throw new Error(
                "Fraction numerator and denominator must be positive integers",
            );
        }
        const divisor = gcd(numerator, denominator);
        return {
            mode: "fraction",
            value: numerator / denominator,
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        };
    }
    if (typeof input.value === "string") {
        const match = input.value.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
        if (match) {
            return parseFractionSpec({
                numerator: Number(match[1]),
                denominator: Number(match[2]),
            });
        }
        const parsed = Number(input.value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error("Fraction must be a positive number or n/d");
        }
        return parseFractionSpec({ value: parsed });
    }
    const value = input.value;
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
        throw new Error("Fraction must be positive");
    }
    const recovered = shareToFraction(value);
    return {
        mode: "fraction",
        value,
        ...(recovered
            ? {
                  numerator: recovered.numerator,
                  denominator: recovered.denominator,
              }
            : {}),
    };
}

function roundShare(share: number): number {
    return Number(share.toFixed(6));
}

/**
 * The one share computation behind every recipe-log surface.
 * Servings needs nothing new; Fraction needs no yield at all;
 * Amount resolves inside the entered unit's family against that
 * family's effective yield (set, else estimated) and REFUSES when
 * the family has neither — no cross-family density guesses.
 */
export function resolveRecipePortion(
    context: RecipePortionContext,
    spec: RecipePortionSpec,
): ResolvedRecipePortion {
    if (!Number.isFinite(context.servings) || context.servings <= 0) {
        throw new Error("Recipe servings must be positive");
    }
    if (spec.mode === "servings") {
        if (!Number.isFinite(spec.servings) || spec.servings <= 0) {
            throw new Error("Recipe servings consumed must be positive");
        }
        const factor = spec.servings / context.servings;
        return {
            factor,
            record: {
                mode: "servings",
                entered_amount: spec.servings,
                entered_unit: null,
                fraction_numerator: null,
                fraction_denominator: null,
                share: roundShare(factor),
                yield_snapshot: null,
                servings_equivalent: spec.servings,
            },
            label: `${quantityLabel(spec.servings)} serving${spec.servings === 1 ? "" : "s"}`,
            shareLabel: shareFractionLabel(factor),
        };
    }

    if (spec.mode === "fraction") {
        if (!Number.isFinite(spec.value) || spec.value <= 0) {
            throw new Error("Recipe fraction must be positive");
        }
        const factor = spec.value;
        const numerator = spec.numerator ?? null;
        const denominator = spec.denominator ?? null;
        const label =
            numerator != null && denominator != null
                ? numerator === 1 && denominator === 1
                    ? "the whole recipe"
                    : `${numerator}/${denominator} of the recipe`
                : `${trimDecimal(factor)} of the recipe`;
        return {
            factor,
            record: {
                mode: "fraction",
                entered_amount: null,
                entered_unit: null,
                fraction_numerator: numerator,
                fraction_denominator: denominator,
                share: roundShare(factor),
                yield_snapshot: null,
                servings_equivalent: Number(
                    (factor * context.servings).toFixed(3),
                ),
            },
            label,
            shareLabel:
                numerator != null && denominator != null
                    ? `${numerator}/${denominator}`
                    : shareFractionLabel(factor),
        };
    }

    // Amount mode.
    if (!Number.isFinite(spec.amount) || spec.amount <= 0) {
        throw new Error("Recipe amount must be positive");
    }
    const unit = normalizeYieldUnit(spec.unit);
    if (!unit) {
        throw new Error(
            `Amount unit is not a volume or weight measure: ${spec.unit}`,
        );
    }
    const family = yieldUnitFamily(unit)!;
    const effective = effectiveRecipeYields(
        context.yields,
        context.ingredients,
    );
    const familyYield = effective[family];
    if (!familyYield) {
        throw new Error(
            family === "volume"
                ? "This recipe has no volume yield yet — add one (or log by servings or fraction) before logging a volume amount"
                : "This recipe has no weight yield yet — add one (or log by servings or fraction) before logging a weight amount",
        );
    }
    const converted = convertYieldQuantity(spec.amount, unit, familyYield.unit);
    if (converted == null) {
        throw new Error(
            `Cannot convert ${spec.unit} against the recipe's ${family} yield`,
        );
    }
    const factor = converted / familyYield.quantity;
    return {
        factor,
        record: {
            mode: "amount",
            entered_amount: spec.amount,
            entered_unit: unit,
            fraction_numerator: null,
            fraction_denominator: null,
            share: roundShare(factor),
            yield_snapshot: {
                quantity: familyYield.quantity,
                unit: familyYield.unit,
                family,
                source: familyYield.source,
            },
            servings_equivalent: Number((factor * context.servings).toFixed(3)),
        },
        label: `${quantityLabel(spec.amount, unit)} ${displayYieldUnit(unit, spec.amount)}`,
        shareLabel: shareFractionLabel(factor),
    };
}
