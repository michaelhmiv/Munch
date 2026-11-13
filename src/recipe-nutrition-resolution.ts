import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    getFoodSearchService,
    type FoodSearchService,
} from "./food-providers/service.js";
import { scaleNutrients } from "./food-providers/nutrients.js";
import {
    isNonHeadlinePortion,
    portionNaturalRank,
} from "./food-providers/portions.js";
import type {
    FoodCandidate,
    FoodPortion,
    NutrientValues,
} from "./food-providers/types.js";

const CORE_NUTRIENTS = ["calories", "protein_g", "carbs_g", "fat_g"] as const;
const SUPPORTED_NUTRIENTS = [
    ...CORE_NUTRIENTS,
    "fiber_g",
    "sugar_g",
    "sodium_mg",
] as const;
const LOW_IMPACT_PATTERN =
    /\b(salt|pepper|seasoning|spice|thyme|parsley|bay leaves?|oregano|basil|rosemary|sage|paprika)\b/i;
const COUNT_UNITS = new Set([
    "each",
    "piece",
    "item",
    "whole",
    "breast",
    "crust",
    "clove",
    "stalk",
    "sprig",
    "slice",
]);
const MIN_CANDIDATE_SCORE = 0.52;
const RESOLVER_VERSION = 2;

export type RecipeNutrientFacts = Partial<
    Record<(typeof SUPPORTED_NUTRIENTS)[number], number>
>;

export interface RecipeNutritionIngredientPayload {
    name: string;
    quantity?: number;
    unit?: string;
    preparation?: string;
    optional?: boolean;
    gram_weight?: number;
    nutrients?: RecipeNutrientFacts;
    provider?: string;
    provider_food_id?: string;
    source_type: string;
    source_url?: string;
    confidence?: number;
    source_snapshot?: Record<string, unknown>;
}

/**
 * A recipe's yield, as stored with `yield_estimate` provenance
 * (seat A2b). `source: "estimate"` is the labelled model estimate
 * (anchor + adjustment factors + serving model recorded);
 * `source: "user"` is a user correction, which PERMANENTLY replaces
 * the estimate — no later save/revision/recalculate may overwrite
 * it with a fresh estimate.
 */
export interface RecipeYieldEstimate {
    source: "estimate" | "user";
    weight_g: number | null;
    volume_ml: number | null;
    anchor?: {
        weight_g: number | null;
        volume_ml: number | null;
        weight_factor: number | null;
        volume_factor: number | null;
    } | null;
    model?: string | null;
    probability?: number | null;
}

export interface RecipeNutritionPayload {
    name: string;
    servings: number;
    ingredients: RecipeNutritionIngredientPayload[];
    instructions?: string[];
    yield_estimate?: RecipeYieldEstimate | null;
    [key: string]: unknown;
}

export interface RecipeNutritionResolution {
    recipe: RecipeNutritionPayload;
    providerMatches: number;
    lowImpactEstimates: number;
    unresolved: number;
    estimatedPositions: number[];
    unresolvedPositions: number[];
    /**
     * Positions left unresolved because the food search provider
     * THREW (outage, circuit open, timeout) rather than because no
     * defensible match exists. These are retryable: the ingredients
     * may match perfectly well once the provider recovers, so save
     * paths surface them distinctly instead of letting them blend
     * into the ordinary no-match count.
     */
    providerErrorPositions: number[];
    /** Positions filled by the A2 labelled estimate rung (audit §2)
     * when the resolution-review hook ran. Absent when it did not. */
    modelEstimates?: number;
    /** Positions the A1 plausibility review flagged. Absent when
     * the review hook did not run. */
    flaggedReviewPositions?: number[];
}

export interface RecipeNutritionResolutionDependencies {
    foodSearch?: Pick<FoodSearchService, "search">;
    /**
     * A1+A2 accountability hook (Jev accountability audit §2 Tier 1):
     * invoked with the deterministic resolution before it is
     * returned, on every path that threads these dependencies. The
     * implementation lives website-side (src/decisions/) and is
     * supplied by website callers — the host-AI boundary law keeps
     * model clients out of this module's dependency graph. The hook
     * is fail-open by contract; the resolver additionally guards the
     * call so a throwing hook can never change the outcome.
     */
    resolutionReview?: (
        resolution: RecipeNutritionResolution,
    ) => Promise<RecipeNutritionResolution>;
}

type ToolServer = {
    registerTool: (
        name: string,
        config: Record<string, any>,
        handler: (args: Record<string, any>) => Promise<any> | any,
    ) => unknown;
};

type SearchPlan = {
    query: string;
    assumptions: string[];
};

type PortionResolution = {
    gramWeight?: number;
    nutrients: RecipeNutrientFacts;
    portionId: string;
    portionLabel: string;
    factor: number;
    assumption?: string;
    /** For volume resolutions: the gram weight one requested unit
     * implies under the chosen portion (density × unit volume) — the
     * number the sanity gate judged, kept for later review. */
    impliedGramsPerUnit?: number;
};

function normalizeText(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function singularToken(token: string): string {
    if (token.endsWith("ies") && token.length > 4)
        return `${token.slice(0, -3)}y`;
    if (token.endsWith("ses") && token.length > 4) return token.slice(0, -2);
    if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
        return token.slice(0, -1);
    }
    return token;
}

function tokens(value: string): Set<string> {
    return new Set(
        normalizeText(value).split(" ").filter(Boolean).map(singularToken),
    );
}

function normalizeUnit(value: string | undefined): string {
    const normalized = normalizeText(value ?? "");
    const aliases: Record<string, string> = {
        cups: "cup",
        tablespoons: "tbsp",
        tablespoon: "tbsp",
        tbsp: "tbsp",
        teaspoons: "tsp",
        teaspoon: "tsp",
        tsp: "tsp",
        ounces: "oz",
        ounce: "oz",
        grams: "g",
        gram: "g",
        kilograms: "kg",
        kilogram: "kg",
        pounds: "lb",
        pound: "lb",
        breasts: "breast",
        crusts: "crust",
        cloves: "clove",
        slices: "slice",
        pieces: "piece",
        items: "item",
    };
    return aliases[normalized] ?? singularToken(normalized);
}

function unitTerms(unit: string): string[] {
    const terms: Record<string, string[]> = {
        cup: ["cup"],
        tbsp: ["tbsp", "tablespoon"],
        tsp: ["tsp", "teaspoon"],
        oz: ["oz", "ounce"],
        lb: ["lb", "pound"],
        g: ["g", "gram"],
        kg: ["kg", "kilogram"],
        breast: ["breast", "piece"],
        crust: ["crust", "piece"],
        clove: ["clove", "piece"],
        slice: ["slice"],
        piece: ["piece", "item"],
        each: ["each", "piece", "item", "whole"],
        whole: ["whole", "piece", "item"],
    };
    return terms[unit] ?? [unit];
}

function hasCoreNutrition(nutrients: RecipeNutrientFacts | undefined): boolean {
    return CORE_NUTRIENTS.every((key) => nutrients?.[key] !== undefined);
}

function supportedNutrients(values: NutrientValues): RecipeNutrientFacts {
    const result: RecipeNutrientFacts = {};
    for (const key of SUPPORTED_NUTRIENTS) {
        const value = values[key];
        if (value !== undefined && Number.isFinite(value) && value >= 0) {
            result[key] = Number(value.toFixed(2));
        }
    }
    return result;
}

function searchPlan(ingredient: RecipeNutritionIngredientPayload): SearchPlan {
    const name = normalizeText(ingredient.name);
    const preparation = normalizeText(ingredient.preparation ?? "");
    const assumptions: string[] = [];

    if (/\bpie crusts?\b/.test(name)) {
        assumptions.push(
            "Unspecified pie crust resolved as a standard refrigerated regular unbaked pie crust.",
        );
        return { query: "pie crust refrigerated regular unbaked", assumptions };
    }
    if (/^milk$/.test(name)) {
        assumptions.push("Unspecified milk resolved as generic whole milk.");
        return { query: "milk whole", assumptions };
    }
    if (
        /\bmixed vegetables?\b/.test(name) &&
        /\bfrozen\b/.test(`${name} ${preparation}`)
    ) {
        assumptions.push(
            "Frozen mixed vegetables resolved as a generic classic frozen mix cooked without added fat.",
        );
        return {
            query: "classic mixed vegetables frozen cooked no added fat",
            assumptions,
        };
    }
    if (
        /\bchicken breasts?\b/.test(name) &&
        /\bcooked\b/.test(`${name} ${preparation}`)
    ) {
        assumptions.push(
            "Unspecified cooked chicken breasts resolved as generic cooked boneless skinless chicken breast pieces.",
        );
        return {
            query: "chicken breast skinless boneless cooked braised",
            assumptions,
        };
    }
    if (/\bchicken broth\b/.test(name)) {
        assumptions.push(
            "Chicken broth resolved as generic ready-to-serve chicken broth.",
        );
        return { query: "chicken broth ready to serve", assumptions };
    }
    if (/\ball purpose flour\b/.test(name)) {
        assumptions.push(
            "All-purpose flour resolved as generic enriched white all-purpose flour.",
        );
        return { query: "wheat flour white all-purpose enriched", assumptions };
    }
    if (/^onions?$/.test(name)) {
        assumptions.push("Unspecified onion resolved as generic raw onion.");
        return { query: "onions raw", assumptions };
    }

    const form = preparation.match(
        /\b(raw|cooked|grilled|roasted|boiled|frozen)\b/,
    )?.[1];
    return {
        query: [ingredient.name, form].filter(Boolean).join(" "),
        assumptions,
    };
}

function candidateScore(query: string, candidate: FoodCandidate): number {
    const queryTokens = tokens(query);
    const candidateTokens = tokens(candidate.name);
    if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
    let overlap = 0;
    for (const token of queryTokens) {
        if (candidateTokens.has(token)) overlap += 1;
    }
    const recall = overlap / queryTokens.size;
    const precision = overlap / candidateTokens.size;
    const lexical =
        recall + precision === 0
            ? 0
            : (2 * recall * precision) / (recall + precision);
    const exact =
        normalizeText(query) === normalizeText(candidate.name) ? 0.2 : 0;
    const generic = candidate.dataKind === "generic" ? 0.14 : 0;
    const packagedPenalty =
        candidate.dataKind === "packaged" || candidate.dataKind === "branded"
            ? 0.08
            : 0;
    return (
        lexical +
        exact +
        generic +
        candidate.confidence * 0.08 -
        packagedPenalty
    );
}

function rankCandidates(
    query: string,
    candidates: FoodCandidate[],
): FoodCandidate[] {
    return candidates
        .map((candidate) => ({
            candidate,
            score: candidateScore(query, candidate),
        }))
        .filter(
            ({ candidate, score }) =>
                score >= MIN_CANDIDATE_SCORE && candidate.confidence >= 0.75,
        )
        .sort((left, right) => right.score - left.score)
        .map(({ candidate }) => candidate);
}

function portionText(portion: FoodPortion): string {
    return normalizeText(`${portion.unit} ${portion.label}`);
}

function portionForUnitIn(
    portions: FoodPortion[],
    unit: string,
): FoodPortion | undefined {
    if (!unit) {
        return portions.find((portion) => portion.id !== "100g") ?? portions[0];
    }
    const terms = unitTerms(unit);
    const exact = portions.find(
        (portion) => normalizeUnit(portion.unit) === unit,
    );
    if (exact) return exact;
    const labelMatch = portions.find((portion) => {
        const text = portionText(portion);
        return terms.some((term) =>
            text.split(" ").includes(singularToken(term)),
        );
    });
    if (labelMatch) return labelMatch;
    if (COUNT_UNITS.has(unit)) {
        return portions.find((portion) => {
            const text = portionText(portion);
            return /\b(each|piece|item|whole)\b/.test(text);
        });
    }
    return undefined;
}

function portionForUnit(
    portions: FoodPortion[],
    unit: string,
): FoodPortion | undefined {
    // Non-headline portions (USDA "guideline amount" / "quantity not
    // specified" rows) are reference amounts for another food context,
    // never a portion anyone eats — portions.ts ranks them last for
    // the same reason. They may only win when nothing else matches.
    const headline = portions.filter(
        (portion) => !isNonHeadlinePortion(portion),
    );
    if (headline.length === portions.length) {
        return portionForUnitIn(portions, unit);
    }
    return portionForUnitIn(headline, unit) ?? portionForUnitIn(portions, unit);
}

/** Exact millilitres per volume unit — mirrors the table in
 * src/meal-photo/grounding.ts so both resolvers convert identically. */
const VOLUME_TO_ML: Record<string, number> = {
    ml: 1,
    l: 1_000,
    tsp: 4.92892159,
    tbsp: 14.7867648,
    "fl oz": 29.5735296,
    cup: 236.5882365,
    pint: 473.176473,
    quart: 946.352946,
    gallon: 3785.41178,
};

/**
 * Sanity envelope for volume resolution. A portion used to interpret
 * a volume quantity implies a density (its gram weight over its
 * volume); ordinary foods sit between whipped toppings (~0.25 g/ml)
 * and honey (~1.4 g/ml). Outside [MIN, MAX] the portion data is
 * wrong for this food — the resolver must refuse it and try the next
 * portion/candidate rather than silently scale a bad number into a
 * saved recipe (the Nov 2026 mac-and-cheese save priced 3 cups of
 * milk at 183 g this way). For liquid-like foods — the candidate
 * carries a fluid-ounce portion, or any anchor already sits near
 * water's density — a cup is additionally held to the conventional
 * liquid cup weight: 150–350 g.
 */
const MIN_PLAUSIBLE_DENSITY_G_PER_ML = 0.06;
const MAX_PLAUSIBLE_DENSITY_G_PER_ML = 2.0;
const LIQUID_CUP_MIN_GRAMS = 150;
const LIQUID_CUP_MAX_GRAMS = 350;

function volumeUnitKey(unit: string): string | undefined {
    const normalized = normalizeUnit(unit);
    if (normalized in VOLUME_TO_ML) return normalized;
    if (normalized === "fluid ounce") return "fl oz";
    return undefined;
}

function parseLabelAmount(text: string): number | undefined {
    let total = 0;
    for (const part of text.trim().split(/\s+/)) {
        const fraction = part.match(/^(\d+)\/(\d+)$/);
        if (fraction) {
            const denominator = Number(fraction[2]);
            if (denominator === 0) return undefined;
            total += Number(fraction[1]) / denominator;
        } else if (/^\d+(?:\.\d+)?$/.test(part)) {
            total += Number(part);
        } else {
            return undefined;
        }
    }
    return total > 0 ? total : undefined;
}

/**
 * The volume denomination a portion itself declares — from its unit
 * when the unit is a volume unit, else from a leading "<amount>
 * <volume unit>" in its label ("1 cup", "1/2 cup", "8 fl oz").
 * Portions whose labels merely MENTION a volume word ("Guideline
 * amount per cup of hot cereal") declare nothing and return
 * undefined.
 */
function portionVolumeDenomination(
    portion: FoodPortion,
): { amount: number; unit: string } | undefined {
    const byUnit = volumeUnitKey(portion.unit);
    if (byUnit && portion.amount > 0) {
        return { amount: portion.amount, unit: byUnit };
    }
    const labelMatch = portion.label
        .trim()
        .match(
            /^(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*(cups?|tablespoons?|tbsp|teaspoons?|tsp|fl\.?\s*oz|milliliters?|millilitres?|ml|liters?|litres?|l|pints?|quarts?|gallons?)\b/i,
        );
    if (!labelMatch) return undefined;
    const amount = parseLabelAmount(labelMatch[1]!);
    const unit = volumeUnitKey(
        labelMatch[2]!.replace(/\s+/g, " ").replace(/\./g, ""),
    );
    if (amount === undefined || !unit) return undefined;
    return { amount, unit };
}

/**
 * A portion the sanity gate refused, recorded so the saved
 * ingredient's snapshot shows WHY a portion was not used — the
 * outcome stays inspectable without re-deriving the decision.
 */
type RejectedPortion = {
    portion_id: string;
    portion_label: string;
    implied_grams_per_unit: number | null;
    reason: string;
};

type PortionAttempt = {
    resolution: PortionResolution | null;
    rejectedPortions: RejectedPortion[];
};

type VolumeAnchor = {
    portion: FoodPortion;
    denomination: { amount: number; unit: string };
    density: number;
    gramsPerRequestedUnit: number;
    gramWeight: number;
};

/**
 * Volume resolution through the candidate's own measured portions.
 * Each portion with a gram weight and a volume denomination anchors
 * an exact ml-ratio conversion (the same approach meal-photo
 * grounding takes: a volume converts to a volume portion, never to a
 * serving count). Anchors are tried in preference order — portions
 * denominated in the requested unit first, then the most natural —
 * and each must pass the sanity gate. Non-headline reference
 * portions anchor only when no headline anchor exists. Returns null
 * when no anchor passes: an insane portion is refused, never
 * silently accepted.
 */
function resolveVolumePortion(
    ingredient: RecipeNutritionIngredientPayload,
    candidate: FoodCandidate,
    unit: string,
    quantity: number,
): PortionAttempt {
    const mlPerRequestedUnit = VOLUME_TO_ML[unit]!;
    const anchors: VolumeAnchor[] = [];
    for (const portion of candidate.portions) {
        if (!(portion.amount > 0)) continue;
        if (portion.gramWeight === undefined || !(portion.gramWeight > 0)) {
            continue;
        }
        const denomination = portionVolumeDenomination(portion);
        if (!denomination) continue;
        const portionMl =
            denomination.amount * VOLUME_TO_ML[denomination.unit]!;
        if (!(portionMl > 0)) continue;
        const density = portion.gramWeight / portionMl;
        anchors.push({
            portion,
            denomination,
            density,
            gramsPerRequestedUnit: density * mlPerRequestedUnit,
            gramWeight: portion.gramWeight,
        });
    }
    if (anchors.length === 0) return { resolution: null, rejectedPortions: [] };

    const headline = anchors.filter(
        (anchor) => !isNonHeadlinePortion(anchor.portion),
    );
    const pool = headline.length > 0 ? headline : anchors;
    const liquidLike =
        pool.some((anchor) => anchor.denomination.unit === "fl oz") ||
        pool.some((anchor) => anchor.density >= 0.85 && anchor.density <= 1.15);
    const ordered = [...pool].sort((left, right) => {
        const leftOwn = left.denomination.unit === unit ? 0 : 1;
        const rightOwn = right.denomination.unit === unit ? 0 : 1;
        if (leftOwn !== rightOwn) return leftOwn - rightOwn;
        return (
            portionNaturalRank(left.portion) - portionNaturalRank(right.portion)
        );
    });

    const rejectedPortions: RejectedPortion[] = [];
    for (const anchor of ordered) {
        const grams = anchor.gramsPerRequestedUnit;
        const insane =
            unit === "cup" && liquidLike
                ? grams < LIQUID_CUP_MIN_GRAMS || grams > LIQUID_CUP_MAX_GRAMS
                : anchor.density < MIN_PLAUSIBLE_DENSITY_G_PER_ML ||
                  anchor.density > MAX_PLAUSIBLE_DENSITY_G_PER_ML;
        if (insane) {
            rejectedPortions.push({
                portion_id: anchor.portion.id,
                portion_label: anchor.portion.label,
                implied_grams_per_unit: Number(grams.toFixed(2)),
                reason:
                    unit === "cup" && liquidLike
                        ? "implied_grams_per_cup_out_of_range"
                        : "implied_density_out_of_range",
            });
            continue;
        }
        const factor =
            (quantity * mlPerRequestedUnit) /
            (anchor.denomination.amount *
                VOLUME_TO_ML[anchor.denomination.unit]!);
        const scaled = supportedNutrients(
            scaleNutrients(anchor.portion.nutrients, factor),
        );
        if (!hasCoreNutrition(scaled)) continue;
        return {
            resolution: {
                gramWeight: Number((anchor.gramWeight * factor).toFixed(2)),
                nutrients: scaled,
                portionId: anchor.portion.id,
                portionLabel: anchor.portion.label,
                factor,
                impliedGramsPerUnit: Number(grams.toFixed(2)),
                assumption:
                    normalizeUnit(anchor.portion.unit) !== unit
                        ? `Used provider portion "${anchor.portion.label}" to interpret ${quantity} ${ingredient.unit ?? unit}.`
                        : undefined,
            },
            rejectedPortions,
        };
    }
    return { resolution: null, rejectedPortions };
}

function resolvePortion(
    ingredient: RecipeNutritionIngredientPayload,
    candidate: FoodCandidate,
): PortionAttempt {
    const quantity = ingredient.quantity;
    if (ingredient.gram_weight !== undefined && candidate.nutrientsPer100g) {
        return {
            resolution: {
                gramWeight: ingredient.gram_weight,
                nutrients: supportedNutrients(
                    scaleNutrients(
                        candidate.nutrientsPer100g,
                        ingredient.gram_weight / 100,
                    ),
                ),
                portionId: "100g",
                portionLabel: `${ingredient.gram_weight} g`,
                factor: ingredient.gram_weight / 100,
            },
            rejectedPortions: [],
        };
    }
    if (quantity === undefined)
        return { resolution: null, rejectedPortions: [] };

    const unit = normalizeUnit(ingredient.unit);
    const weightGrams =
        unit === "g"
            ? quantity
            : unit === "kg"
              ? quantity * 1_000
              : unit === "oz"
                ? quantity * 28.349523125
                : unit === "lb"
                  ? quantity * 453.59237
                  : null;
    if (weightGrams !== null && candidate.nutrientsPer100g) {
        return {
            resolution: {
                gramWeight: Number(weightGrams.toFixed(2)),
                nutrients: supportedNutrients(
                    scaleNutrients(
                        candidate.nutrientsPer100g,
                        weightGrams / 100,
                    ),
                ),
                portionId: "100g",
                portionLabel: `${Number(weightGrams.toFixed(2))} g`,
                factor: weightGrams / 100,
            },
            rejectedPortions: [],
        };
    }

    const volumeKey = volumeUnitKey(ingredient.unit ?? "");
    if (volumeKey) {
        const attempt = resolveVolumePortion(
            ingredient,
            candidate,
            volumeKey,
            quantity,
        );
        if (attempt.resolution || attempt.rejectedPortions.length > 0) {
            return attempt;
        }
        // No volume anchors at all — fall through to the legacy pick
        // (a portion without a gram weight carries its own panel and
        // makes no implied-weight claim to validate).
    }

    const portion = portionForUnit(candidate.portions, unit);
    if (!portion || !Number.isFinite(portion.amount) || portion.amount <= 0) {
        return { resolution: null, rejectedPortions: [] };
    }
    const factor = quantity / portion.amount;
    const scaled = supportedNutrients(
        scaleNutrients(portion.nutrients, factor),
    );
    if (!hasCoreNutrition(scaled)) {
        return { resolution: null, rejectedPortions: [] };
    }
    return {
        resolution: {
            gramWeight:
                portion.gramWeight === undefined
                    ? undefined
                    : Number((portion.gramWeight * factor).toFixed(2)),
            nutrients: scaled,
            portionId: portion.id,
            portionLabel: portion.label,
            factor,
            assumption:
                unit && normalizeUnit(portion.unit) !== unit
                    ? `Used provider portion "${portion.label}" to interpret ${quantity} ${ingredient.unit ?? unit}.`
                    : undefined,
        },
        rejectedPortions: [],
    };
}

function lowImpactEstimate(
    ingredient: RecipeNutritionIngredientPayload,
): RecipeNutritionIngredientPayload {
    const assumption =
        "No measurable amount was supplied for this low-impact seasoning; calories and core macros were treated as zero and sodium was left unknown.";
    return {
        ...ingredient,
        nutrients: {
            calories: 0,
            protein_g: 0,
            carbs_g: 0,
            fat_g: 0,
            fiber_g: 0,
            sugar_g: 0,
        },
        source_type: "model_estimate",
        confidence: Math.max(ingredient.confidence ?? 0, 0.85),
        source_snapshot: {
            ...(ingredient.source_snapshot ?? {}),
            automatic_nutrition: {
                resolver_version: RESOLVER_VERSION,
                resolution: "low_impact_zero",
                estimated: true,
                assumptions: [assumption],
            },
        },
    };
}

async function resolveIngredient(
    ingredient: RecipeNutritionIngredientPayload,
    foodSearch: Pick<FoodSearchService, "search">,
): Promise<{
    ingredient: RecipeNutritionIngredientPayload;
    kind:
        | "preserved"
        | "provider"
        | "low_impact"
        | "unresolved"
        | "provider_error";
}> {
    if (hasCoreNutrition(ingredient.nutrients)) {
        return { ingredient, kind: "preserved" };
    }
    if (
        ingredient.quantity === undefined &&
        LOW_IMPACT_PATTERN.test(ingredient.name)
    ) {
        return {
            ingredient: lowImpactEstimate(ingredient),
            kind: "low_impact",
        };
    }
    if (
        ingredient.quantity === undefined &&
        ingredient.gram_weight === undefined
    ) {
        return {
            ingredient: {
                ...ingredient,
                source_snapshot: {
                    ...(ingredient.source_snapshot ?? {}),
                    automatic_nutrition: {
                        resolver_version: RESOLVER_VERSION,
                        resolution: "unresolved",
                        reason: "missing_material_quantity",
                    },
                },
            },
            kind: "unresolved",
        };
    }

    const plan = searchPlan(ingredient);
    try {
        const search = await foodSearch.search(plan.query, 8);
        const ranked = rankCandidates(plan.query, search.candidates);
        const selected = ranked[0];
        if (!selected) {
            return {
                ingredient: {
                    ...ingredient,
                    source_snapshot: {
                        ...(ingredient.source_snapshot ?? {}),
                        automatic_nutrition: {
                            resolver_version: RESOLVER_VERSION,
                            resolution: "unresolved",
                            query: plan.query,
                            reason: "no_defensible_provider_match",
                            candidate_count: search.candidates.length,
                        },
                    },
                },
                kind: "unresolved",
            };
        }
        // Try each defensible candidate in score order: a candidate
        // whose portions cannot sanely price the quantity (the sanity
        // gate) must not sink the ingredient when a lower-ranked
        // candidate can.
        let portion: PortionResolution | null = null;
        let chosen: FoodCandidate | undefined;
        let chosenRejected: RejectedPortion[] = [];
        let primaryRejected: RejectedPortion[] = [];
        for (const candidate of ranked) {
            const attempt = resolvePortion(ingredient, candidate);
            if (candidate === selected) {
                primaryRejected = attempt.rejectedPortions;
            }
            if (
                attempt.resolution &&
                hasCoreNutrition(attempt.resolution.nutrients)
            ) {
                chosen = candidate;
                portion = attempt.resolution;
                chosenRejected = attempt.rejectedPortions;
                break;
            }
        }
        if (!chosen || !portion) {
            return {
                ingredient: {
                    ...ingredient,
                    source_snapshot: {
                        ...(ingredient.source_snapshot ?? {}),
                        automatic_nutrition: {
                            resolver_version: RESOLVER_VERSION,
                            resolution: "unresolved",
                            query: plan.query,
                            provider: selected.provider,
                            provider_food_id: selected.providerFoodId,
                            reason: "no_compatible_provider_portion",
                            rejected_portions: primaryRejected,
                        },
                    },
                },
                kind: "unresolved",
            };
        }

        const assumptions = [...plan.assumptions];
        if (portion.assumption) assumptions.push(portion.assumption);
        const confidenceCap = assumptions.length > 0 ? 0.9 : 0.96;
        return {
            ingredient: {
                ...ingredient,
                gram_weight: portion.gramWeight ?? ingredient.gram_weight,
                nutrients: {
                    ...portion.nutrients,
                    ...(ingredient.nutrients ?? {}),
                },
                provider: chosen.attribution.label,
                provider_food_id: chosen.providerFoodId,
                source_type: chosen.provider,
                source_url: chosen.attribution.url ?? ingredient.source_url,
                confidence: Math.min(chosen.confidence, confidenceCap),
                source_snapshot: {
                    ...(ingredient.source_snapshot ?? {}),
                    automatic_nutrition: {
                        resolver_version: RESOLVER_VERSION,
                        resolution:
                            assumptions.length > 0
                                ? "assumed_provider_match"
                                : "provider_match",
                        estimated: true,
                        query: plan.query,
                        provider: chosen.provider,
                        provider_food_id: chosen.providerFoodId,
                        provider_food_name: chosen.name,
                        provider_data_kind: chosen.dataKind,
                        portion_id: portion.portionId,
                        portion_label: portion.portionLabel,
                        portion_factor: Number(portion.factor.toFixed(6)),
                        gram_weight: portion.gramWeight ?? null,
                        implied_grams_per_unit:
                            portion.impliedGramsPerUnit ?? null,
                        rejected_portions: chosenRejected,
                        assumptions,
                    },
                },
            },
            kind: "provider",
        };
    } catch (error) {
        return {
            ingredient: {
                ...ingredient,
                source_snapshot: {
                    ...(ingredient.source_snapshot ?? {}),
                    automatic_nutrition: {
                        resolver_version: RESOLVER_VERSION,
                        resolution: "unresolved",
                        query: plan.query,
                        reason: "provider_resolution_error",
                        error_name:
                            error instanceof Error ? error.name : "unknown",
                    },
                },
            },
            kind: "provider_error",
        };
    }
}

export async function resolveRecipeNutrition(
    recipe: RecipeNutritionPayload,
    dependencies: RecipeNutritionResolutionDependencies = {},
): Promise<RecipeNutritionResolution> {
    const foodSearch = dependencies.foodSearch ?? getFoodSearchService();
    const settled = await Promise.all(
        recipe.ingredients.map((ingredient) =>
            resolveIngredient(ingredient, foodSearch),
        ),
    );
    let providerMatches = 0;
    let lowImpactEstimates = 0;
    let unresolved = 0;
    const estimatedPositions: number[] = [];
    const unresolvedPositions: number[] = [];
    const providerErrorPositions: number[] = [];
    settled.forEach((result, position) => {
        if (result.kind === "provider") {
            providerMatches += 1;
            estimatedPositions.push(position);
        } else if (result.kind === "low_impact") {
            lowImpactEstimates += 1;
            estimatedPositions.push(position);
        } else if (result.kind === "unresolved") {
            unresolved += 1;
            unresolvedPositions.push(position);
        } else if (result.kind === "provider_error") {
            unresolved += 1;
            unresolvedPositions.push(position);
            providerErrorPositions.push(position);
        }
    });
    const resolution: RecipeNutritionResolution = {
        recipe: {
            ...recipe,
            ingredients: settled.map((result) => result.ingredient),
        },
        providerMatches,
        lowImpactEstimates,
        unresolved,
        estimatedPositions,
        unresolvedPositions,
        providerErrorPositions,
    };
    if (dependencies.resolutionReview) {
        try {
            return await dependencies.resolutionReview(resolution);
        } catch {
            return resolution;
        }
    }
    return resolution;
}

/**
 * The one structured trace every recipe save path leaves in the
 * production logs. A wholesale provider failure additionally warns:
 * those ingredients were saved unresolved because the food search
 * provider failed — not because no match exists — and re-running
 * nutrition calculation (the heal path) is the retry.
 */
export function logRecipeNutritionResolution(
    operation: string,
    resolution: RecipeNutritionResolution,
    totalMs?: number,
): void {
    console.info(
        `[recipe_nutrition] operation=${operation} provider_matches=${resolution.providerMatches} low_impact_estimates=${resolution.lowImpactEstimates} unresolved=${resolution.unresolved} provider_errors=${resolution.providerErrorPositions.length} estimated_positions=${resolution.estimatedPositions.join(",") || "none"} unresolved_positions=${resolution.unresolvedPositions.join(",") || "none"}${totalMs === undefined ? "" : ` total_ms=${Math.round(totalMs)}`}`,
    );
    if (resolution.providerErrorPositions.length > 0) {
        console.warn(
            `[recipe_nutrition] provider_failure operation=${operation} unresolved_due_to_provider_error=${resolution.providerErrorPositions.length} positions=${resolution.providerErrorPositions.join(",")} — ingredients saved unresolved because the food search provider failed, not because no match exists; re-run nutrition calculation to retry`,
        );
    }
}

export interface PlanningRecipeNutritionIngredientPayload {
    name: string;
    quantity?: number;
    unit?: string;
    preparation?: string;
    optional?: boolean;
    gramWeight?: number;
    nutrients?: RecipeNutrientFacts;
    provider?: string;
    providerFoodId?: string;
    sourceType: string;
    sourceUrl?: string;
    confidence?: number;
    sourceSnapshot?: Record<string, unknown>;
}

export interface PlanningRecipeNutritionPayload {
    name: string;
    servings: number;
    ingredients: PlanningRecipeNutritionIngredientPayload[];
    instructions?: string[];
    yieldEstimate?: RecipeYieldEstimate | null;
}

export async function resolvePlanningRecipeNutritionWithReport<
    T extends PlanningRecipeNutritionPayload,
>(
    recipe: T,
    dependencies: RecipeNutritionResolutionDependencies = {},
): Promise<{ recipe: T; resolution: RecipeNutritionResolution }> {
    const resolution = await resolveRecipeNutrition(
        {
            name: recipe.name,
            servings: recipe.servings,
            instructions: recipe.instructions,
            yield_estimate: recipe.yieldEstimate ?? undefined,
            ingredients: recipe.ingredients.map((ingredient) => ({
                name: ingredient.name,
                quantity: ingredient.quantity,
                unit: ingredient.unit,
                preparation: ingredient.preparation,
                optional: ingredient.optional,
                gram_weight: ingredient.gramWeight,
                nutrients: ingredient.nutrients,
                provider: ingredient.provider,
                provider_food_id: ingredient.providerFoodId,
                source_type: ingredient.sourceType,
                source_url: ingredient.sourceUrl,
                confidence: ingredient.confidence,
                source_snapshot: ingredient.sourceSnapshot,
            })),
        },
        dependencies,
    );
    return {
        recipe: {
            ...recipe,
            yieldEstimate:
                resolution.recipe.yield_estimate ?? recipe.yieldEstimate,
            ingredients: resolution.recipe.ingredients.map(
                (ingredient, position) => ({
                    ...recipe.ingredients[position]!,
                    name: ingredient.name,
                    quantity: ingredient.quantity,
                    unit: ingredient.unit,
                    preparation: ingredient.preparation,
                    optional: ingredient.optional,
                    gramWeight: ingredient.gram_weight,
                    nutrients: ingredient.nutrients,
                    provider: ingredient.provider,
                    providerFoodId: ingredient.provider_food_id,
                    sourceType: ingredient.source_type,
                    sourceUrl: ingredient.source_url,
                    confidence: ingredient.confidence,
                    sourceSnapshot: ingredient.source_snapshot,
                }),
            ),
        } as T,
        resolution,
    };
}

export async function resolvePlanningRecipeNutrition<
    T extends PlanningRecipeNutritionPayload,
>(
    recipe: T,
    dependencies: RecipeNutritionResolutionDependencies = {},
): Promise<T> {
    const { recipe: resolved } = await resolvePlanningRecipeNutritionWithReport(
        recipe,
        dependencies,
    );
    return resolved;
}

function enhancedDescription(description: string): string {
    return `${description} If an ordinary ingredient arrives without nutrient facts, Munch automatically attempts provider-backed nutrition resolution before persistence. It preserves explicit nutrition, uses the existing Munch food catalog/USDA/Open Food Facts pipeline, records gram weights, provider IDs, confidence, and assumptions in source_snapshot, and treats unmeasured low-impact seasonings as zero core macros. Ordinary ambiguity should produce an estimate rather than blank nutrition; truly unresolved material ingredients may still produce partial or unavailable nutrition.`;
}

export function withRecipeNutritionResolution(server: McpServer): McpServer {
    const originalRegisterTool = (
        server as unknown as ToolServer
    ).registerTool.bind(server);
    return new Proxy(server, {
        get(target, property) {
            if (property === "registerTool") {
                return (
                    name: string,
                    config: Record<string, any>,
                    handler: (args: Record<string, any>) => Promise<any> | any,
                ) => {
                    if (
                        name !== "save_recipe" &&
                        name !== "save_recipe_and_plan" &&
                        name !== "update_recipe"
                    ) {
                        return originalRegisterTool(name, config, handler);
                    }
                    return originalRegisterTool(
                        name,
                        {
                            ...config,
                            description: enhancedDescription(
                                String(config.description ?? "Save a recipe."),
                            ),
                        },
                        async (args: Record<string, any>) => {
                            const startedAt = performance.now();
                            const resolution = await resolveRecipeNutrition(
                                args.recipe as RecipeNutritionPayload,
                            );
                            const result = await handler({
                                ...args,
                                recipe: resolution.recipe,
                            });
                            logRecipeNutritionResolution(
                                name,
                                resolution,
                                performance.now() - startedAt,
                            );
                            if (
                                Array.isArray(result?.content) &&
                                resolution.estimatedPositions.length > 0
                            ) {
                                const textItem = result.content.find(
                                    (item: any) =>
                                        item?.type === "text" &&
                                        typeof item.text === "string",
                                );
                                if (textItem) {
                                    textItem.text = `${textItem.text}\n\nNutrition: Munch automatically resolved ${resolution.providerMatches} ingredient${resolution.providerMatches === 1 ? "" : "s"} from verified food data and applied ${resolution.lowImpactEstimates} low-impact seasoning estimate${resolution.lowImpactEstimates === 1 ? "" : "s"}. Assumptions and provider provenance are stored with the recipe ingredients.`;
                                }
                            }
                            return result;
                        },
                    );
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as McpServer;
}
