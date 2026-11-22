import { scaleNutrients } from "../food-providers/nutrients.js";
import {
    deduplicatePortions,
    isPer100gPortion,
    naturalPortion,
    normalizePortionUnit,
    per100gPortion,
    portionUnitKind,
    sortPortionsNaturalFirst,
} from "../food-providers/portions.js";
import { rankCandidates, scoreCandidate } from "../food-providers/ranking.js";
import {
    encodeFoodCandidateId,
    type FoodSearchService,
} from "../food-providers/service.js";
import type { FoodCandidate } from "../food-providers/types.js";
import { blockingQuestionKey } from "../meal-drafts/blocking.js";
import type { StructuredMealItemInput } from "../structured-meals/types.js";
import type {
    MealPhotoEstimate,
    MealPhotoEstimateRequest,
} from "./estimate.js";
import type {
    MealPhotoCandidateChoice,
    MealPhotoCandidateChoiceRequest,
    MealPhotoPortionChoice,
    MealPhotoPortionChoiceRequest,
    MealPhotoVisionItem,
} from "./vision.js";

/**
 * Stages 3–4 of the photo-logging pipeline (model-first grounding,
 * 2026-11-22): code fetches deeper candidate pools (25–50) and ranks
 * deterministically; the decider chooses the food candidate for EVERY
 * photo item in one batched call (seeing the top 10), then chooses the
 * matching portion from each picked candidate's REAL portions only.
 *
 * On decider abstention ("none") — or when initial retrieval returns no
 * generic candidate — code triggers at most ONE refinement retry
 * (name + cooking method / "cooked") before routing abstentions to the
 * labelled model-estimate / blocking-question path. Never forces a wrong
 * ground on abstention; decider errors or timeouts fail open to
 * deterministic grounding for the whole photo.
 *
 * Nutrition comes from provider candidates (scaled in code with full
 * unit-kind and sanity-ceiling invariants), or from the LABELLED
 * model-estimate fallback (`model_estimate`). Every item ends with
 * provider values, estimate values, or a BLOCKING draft question —
 * never silently empty.
 */

export const LOW_PORTION_CONFIDENCE = 0.7;
export const AMBIGUITY_MIN_CONFIDENCE = 0.84;
export const AMBIGUITY_MARGIN = 0.08;

/** Deeper retrieval depth for the photo grounding lane (25–50). */
export const GROUNDING_RETRIEVAL_LIMIT = 30;
/** Shortlist shown to the candidate decider per item. */
export const GROUNDING_DECIDER_SHORTLIST_LIMIT = 10;
/** Real portion options shown to the portion decider per picked candidate. */
export const GROUNDING_PORTION_SHORTLIST_LIMIT = 8;

export type MealPhotoGroundingSource =
    "local catalog" | "USDA" | "Open Food Facts" | "model_estimate";

export interface MealPhotoDraftQuestionSpec {
    questionKey: string;
    prompt: string;
    impactScore: number;
    /** Blocking questions (estimate-missing) cannot be accepted away
     * via accept_remaining_assumptions; see meal-drafts/blocking.ts. */
    blocking: boolean;
}

export interface GroundedMealPhotoItem {
    vision: MealPhotoVisionItem;
    draftItem: StructuredMealItemInput;
    /** Human-facing grounding label. USDA-backed candidates are labelled
     * USDA whether they were served from the local catalog cache or the
     * live provider — the local catalog IS cached provider data, and the
     * eval treats "local catalog" and "USDA" as the same grounded family. */
    groundingSource: MealPhotoGroundingSource;
    grounded: boolean;
    /** True when the item's values came from the labelled model-estimate
     * step (not a provider). Mutually exclusive with `grounded`. */
    estimated: boolean;
    candidateId: string | null;
    tieBreakUsed: boolean;
    needsQuestion: boolean;
    question: MealPhotoDraftQuestionSpec | null;
}

export interface MealPhotoGroundingDeps {
    search: Pick<FoodSearchService, "search">["search"];
    chooseCandidates?: (
        requests: MealPhotoCandidateChoiceRequest[],
    ) => Promise<Map<string, MealPhotoCandidateChoice>>;
    /** Batched portion chooser over each picked candidate's REAL portions.
     * Optional so deterministic callers and tests stay untouched. */
    choosePortions?: (
        requests: MealPhotoPortionChoiceRequest[],
    ) => Promise<Map<string, MealPhotoPortionChoice>>;
    /** Labelled model-estimate step for ungrounded items (estimate.ts).
     * Batched: one call receives every ungrounded item of the photo.
     * Optional in the deps shape so deterministic tests/lanes can omit
     * it — omitted or failed estimation yields blocking questions,
     * never silent empty items. */
    estimateNutrients?: (
        requests: MealPhotoEstimateRequest[],
    ) => Promise<Map<string, MealPhotoEstimate>>;
}

const WEIGHT_TO_GRAMS: Record<string, number> = {
    g: 1,
    kg: 1_000,
    oz: 28.349523125,
    lb: 453.59237,
    lbs: 453.59237,
    mg: 0.001,
};

/** Exact millilitres per volume unit (metric + US customary). Volume
 * quantities convert to volume portions through this table — never
 * through a serving count (see the unit-kind invariant on
 * resolveGroundedPortion). */
const VOLUME_TO_ML: Record<string, number> = {
    ml: 1,
    l: 1_000,
    cup: 236.5882365,
    tbsp: 14.7867648,
    tsp: 4.92892159,
    "fl oz": 29.5735296,
    pint: 473.176473,
    quart: 946.352946,
    gallon: 3785.41178,
};

/**
 * Ceiling for the GENERIC-portion fallback: a vision quantity read as
 * a count of a candidate's generic ("serving"-kind) portion is only
 * believable up to this many servings in one photographed item. Past
 * it, the quantity is a data error, not a portion — resolution
 * refuses (or falls to the labelled per-100 g values) instead of
 * silently multiplying a serving's nutrition by it.
 */
export const MAX_GENERIC_PORTION_FACTOR = 20;

/**
 * Ceiling on the gram weight of ONE resolved draft item. However a
 * quantity is expressed, a single photographed item line does not
 * weigh more than this; a resolution past it means the quantity or
 * the portion data is wrong, and the item must surface through the
 * estimate / blocking paths rather than land as a five-figure
 * calorie line. (The blowup case resolved to 127,500 g.)
 */
export const MAX_ITEM_GRAM_WEIGHT_G = 5_000;

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

interface PortionResolution {
    nutrients: StructuredMealItemInput["nutrients"];
    gramWeight?: number;
    portionId: string;
    assumption?: string;
    /** Set when a count quantity was converted through grams-per-piece
     * taken from provider portion data (this candidate's own count
     * portion or a donor candidate's), never from the raw count. */
    countConversion?: {
        gramsPerPiece: number;
        donorPortionLabel: string;
        donorProvider: string;
    };
}

/**
 * A candidate portion that can weigh ONE of the vision item's count
 * units: count-kind unit ("piece", "ear", "slice", …) with a recorded
 * gram weight. An exact unit match wins; otherwise the most natural
 * count portion the candidate carries.
 */
export function findCountPortion(
    candidate: FoodCandidate,
    unit: string,
): FoodCandidate["portions"][number] | undefined {
    const counts = candidate.portions.filter(
        (portion) =>
            portion.amount > 0 &&
            portion.gramWeight !== undefined &&
            portion.gramWeight > 0 &&
            portionUnitKind(portion.unit) === "count",
    );
    if (counts.length === 0) return undefined;
    const normalized = normalizePortionUnit(unit);
    return (
        counts.find(
            (portion) => normalizePortionUnit(portion.unit) === normalized,
        ) ?? sortPortionsNaturalFirst(counts)[0]
    );
}

/** Scale one portion's nutrients by an exact, dimensionally sound
 * factor (same unit, same kind via a conversion table, or a recorded
 * gram weight). Shared by every resolution path below. Returns null
 * when the scaled gram weight breaks the single-item sanity ceiling
 * (MAX_ITEM_GRAM_WEIGHT_G) — the quantity is then a data error, and
 * the caller surfaces the item instead of landing the multiple. */
function scaledPortionResolution(
    vision: MealPhotoVisionItem,
    portion: FoodCandidate["portions"][number],
    factor: number,
): PortionResolution | null {
    const gramWeight =
        portion.gramWeight === undefined
            ? undefined
            : round2(portion.gramWeight * factor);
    if (gramWeight !== undefined && gramWeight > MAX_ITEM_GRAM_WEIGHT_G) {
        return null;
    }
    return {
        nutrients: scaleNutrients(portion.nutrients, factor),
        gramWeight,
        portionId: portion.id,
        assumption:
            normalizePortionUnit(portion.unit) !==
            normalizePortionUnit(vision.unit)
                ? `Used provider portion "${portion.label}" to interpret ${vision.quantity} ${vision.unit}.`
                : undefined,
    };
}

/**
 * Extract a volume unit named in a USDA portion label when USDA stored
 * the measureUnit as "undetermined" or "serving" (e.g. "1 tablespoon",
 * "1 cup (8 fl oz)", "1 undetermined cup chopped").
 */
function extractVolumeUnitFromLabel(label: string): string | null {
    const low = label.toLowerCase();
    if (/\b(?:tablespoons?|tbsp)\b/.test(low)) return "tbsp";
    if (/\b(?:teaspoons?|tsp)\b/.test(low)) return "tsp";
    if (/\bcups?\b/.test(low)) return "cup";
    if (/\bfl\s*oz\b/.test(low)) return "fl oz";
    if (/\bpints?\b/.test(low)) return "pint";
    if (/\bquarts?\b/.test(low)) return "quart";
    if (/\bgallons?\b/.test(low)) return "gallon";
    if (/\b(?:milliliters?|millilitres?|ml)\b/.test(low)) return "ml";
    if (/\b(?:liters?|litres?)\b/.test(low)) return "l";
    return null;
}

/**
 * Validate and scale a decider-selected portion against the candidate's
 * REAL portions only, enforcing every dimensional and sanity invariant:
 * - Unknown/fabricated portionId -> null (caller falls back to
 *   `resolveGroundedPortion`).
 * - Count vision unit against a weight / per-100g portion -> null
 *   (preserves Count-as-Grams P1 invariant).
 * - Volume vision unit scales ONLY against a volume portion (either by
 *   unit or explicitly volume-labelled USDA portion) via ml ratios —
 *   never treats 300 ml as 300 servings.
 * - Weight vision unit scales by exact unit ratio or recorded gramWeight.
 * - Enforces `MAX_GENERIC_PORTION_FACTOR` and `MAX_ITEM_GRAM_WEIGHT_G`.
 */
export function resolveChosenPortion(
    vision: MealPhotoVisionItem,
    candidate: FoodCandidate,
    portionId: string,
): PortionResolution | null {
    const portion = candidate.portions.find(
        (entry) => entry.id === portionId && entry.amount > 0,
    );
    if (!portion) return null;

    const visionUnit = normalizePortionUnit(vision.unit);
    const visionKind = portionUnitKind(vision.unit);
    const portionUnit = normalizePortionUnit(portion.unit);
    const portionKind = portionUnitKind(portion.unit);

    if (visionKind === "weight") {
        const gramsPerUnit = WEIGHT_TO_GRAMS[visionUnit];
        if (gramsPerUnit === undefined) return null;
        if (visionUnit === portionUnit) {
            return scaledPortionResolution(
                vision,
                portion,
                vision.quantity / portion.amount,
            );
        }
        if (portion.gramWeight !== undefined && portion.gramWeight > 0) {
            const grams = vision.quantity * gramsPerUnit;
            return scaledPortionResolution(
                vision,
                portion,
                grams / portion.gramWeight,
            );
        }
        return null;
    }

    if (visionKind === "volume") {
        const mlPerUnit = VOLUME_TO_ML[visionUnit];
        if (mlPerUnit === undefined) return null;
        if (portionKind === "weight" || isPer100gPortion(portion)) return null;
        const resolvedVolumeUnit =
            portionKind === "volume" && VOLUME_TO_ML[portionUnit] !== undefined
                ? portionUnit
                : extractVolumeUnitFromLabel(portion.label);
        if (
            !resolvedVolumeUnit ||
            VOLUME_TO_ML[resolvedVolumeUnit] === undefined
        ) {
            return null;
        }
        const portionMl = portion.amount * VOLUME_TO_ML[resolvedVolumeUnit]!;
        return scaledPortionResolution(
            vision,
            portion,
            (vision.quantity * mlPerUnit) / portionMl,
        );
    }

    if (visionKind === "count") {
        if (portionKind === "weight" || isPer100gPortion(portion)) return null;
        const factor = vision.quantity / portion.amount;
        if (factor > MAX_GENERIC_PORTION_FACTOR) return null;
        return scaledPortionResolution(vision, portion, factor);
    }

    // Generic ("other") vision unit (e.g. serving, bun, link, bowl):
    if (portionKind === "weight" || isPer100gPortion(portion)) return null;
    const factor = vision.quantity / portion.amount;
    if (factor > MAX_GENERIC_PORTION_FACTOR) return null;
    return scaledPortionResolution(vision, portion, factor);
}

/**
 * Convert a vision quantity+unit into provider nutrition for that amount.
 * Mirrors `resolvePortion` in recipe-nutrition-resolution.ts: weight
 * units resolve against per-100g nutrition when available; otherwise the
 * candidate portion matching the vision unit is scaled by
 * quantity / portion.amount.
 */
export function resolveGroundedPortion(
    vision: MealPhotoVisionItem,
    candidate: FoodCandidate,
): PortionResolution | null {
    const unit = normalizePortionUnit(vision.unit);
    const gramsPerUnit = WEIGHT_TO_GRAMS[unit];
    if (gramsPerUnit !== undefined && candidate.nutrientsPer100g) {
        const grams = vision.quantity * gramsPerUnit;
        if (grams > MAX_ITEM_GRAM_WEIGHT_G) return null;
        return {
            nutrients: scaleNutrients(candidate.nutrientsPer100g, grams / 100),
            gramWeight: round2(grams),
            portionId: "100g",
        };
    }
    const visionKind = portionUnitKind(vision.unit);
    const usable = candidate.portions.filter((portion) => portion.amount > 0);
    const exactPortion = usable.find(
        (portion) => normalizePortionUnit(portion.unit) === unit,
    );
    if (exactPortion) {
        if (
            visionKind === "count" &&
            portionUnitKind(exactPortion.unit) === "weight"
        ) {
            return null;
        }
        const factor = vision.quantity / exactPortion.amount;
        if (visionKind !== "other" || factor <= MAX_GENERIC_PORTION_FACTOR) {
            return scaledPortionResolution(vision, exactPortion, factor);
        }
    }
    if (visionKind === "count") {
        const countPortion = findCountPortion(candidate, vision.unit);
        if (countPortion) {
            const resolution = scaledPortionResolution(
                vision,
                countPortion,
                vision.quantity / countPortion.amount,
            );
            if (!resolution) return null;
            return {
                ...resolution,
                countConversion: {
                    gramsPerPiece: round2(
                        countPortion.gramWeight! / countPortion.amount,
                    ),
                    donorPortionLabel: countPortion.label,
                    donorProvider: candidate.provider,
                },
            };
        }
        const fallback = usable[0];
        if (!fallback || portionUnitKind(fallback.unit) === "weight") {
            return null;
        }
        const factor = vision.quantity / fallback.amount;
        if (factor > MAX_GENERIC_PORTION_FACTOR) return null;
        return scaledPortionResolution(vision, fallback, factor);
    }
    if (visionKind === "weight") {
        const weighable = usable.find(
            (portion) =>
                portion.gramWeight !== undefined && portion.gramWeight > 0,
        );
        if (gramsPerUnit === undefined || !weighable) return null;
        const grams = vision.quantity * gramsPerUnit;
        return scaledPortionResolution(
            vision,
            weighable,
            grams / weighable.gramWeight!,
        );
    }
    if (visionKind === "volume") {
        const mlPerUnit = VOLUME_TO_ML[unit];
        const volumePortion = usable.find(
            (portion) =>
                portionUnitKind(portion.unit) === "volume" &&
                VOLUME_TO_ML[normalizePortionUnit(portion.unit)] !== undefined,
        );
        if (mlPerUnit === undefined || !volumePortion) return null;
        const portionMl =
            volumePortion.amount *
            VOLUME_TO_ML[normalizePortionUnit(volumePortion.unit)]!;
        return scaledPortionResolution(
            vision,
            volumePortion,
            (vision.quantity * mlPerUnit) / portionMl,
        );
    }
    const genericPortion = usable.find(
        (portion) => portionUnitKind(portion.unit) === "other",
    );
    if (genericPortion) {
        const factor = vision.quantity / genericPortion.amount;
        if (factor <= MAX_GENERIC_PORTION_FACTOR) {
            return scaledPortionResolution(vision, genericPortion, factor);
        }
    }
    if (candidate.nutrientsPer100g) {
        return {
            nutrients: { ...candidate.nutrientsPer100g },
            portionId: "100g",
            assumption: `Provider reports nutrition per 100 g; the photographed amount (${vision.quantity} ${vision.unit}) could not be converted, so the draft uses the per-100 g values for review.`,
        };
    }
    return null;
}

/**
 * Cross-candidate count conversion (photo-flow P1): the picked
 * candidate cannot weigh the vision item's count unit, but another
 * ranked candidate for the same food carries a count portion with a
 * gram weight.
 */
export function resolveCountViaDonor(
    vision: MealPhotoVisionItem,
    pick: FoodCandidate,
    ranked: FoodCandidate[],
): { candidate: FoodCandidate; resolution: PortionResolution } | null {
    if (portionUnitKind(vision.unit) !== "count") return null;
    for (const donor of ranked) {
        const portion = findCountPortion(donor, vision.unit);
        if (!portion) continue;
        const gramsPerPiece = portion.gramWeight! / portion.amount;
        if (pick.nutrientsPer100g) {
            const grams = vision.quantity * gramsPerPiece;
            if (grams > MAX_ITEM_GRAM_WEIGHT_G) continue;
            return {
                candidate: pick,
                resolution: {
                    nutrients: scaleNutrients(
                        pick.nutrientsPer100g,
                        grams / 100,
                    ),
                    gramWeight: round2(grams),
                    portionId: "100g",
                    assumption: `Counted ${vision.quantity} ${vision.unit} at about ${round2(gramsPerPiece)} g each — grams per ${portion.unit} from provider portion data ("${portion.label}"); nutrition from this food's per-100 g values.`,
                    countConversion: {
                        gramsPerPiece: round2(gramsPerPiece),
                        donorPortionLabel: portion.label,
                        donorProvider: donor.provider,
                    },
                },
            };
        }
        const resolution = resolveGroundedPortion(vision, donor);
        if (resolution) return { candidate: donor, resolution };
    }
    return null;
}

function groundingSourceFor(
    candidate: FoodCandidate,
): MealPhotoGroundingSource {
    return candidate.provider === "usda" ? "USDA" : "Open Food Facts";
}

function defaultPortionLabelFor(candidate: FoodCandidate): string | null {
    const portion =
        naturalPortion(candidate.portions) ??
        (candidate.nutrientsPer100g
            ? per100gPortion(candidate.nutrientsPer100g)
            : candidate.portions[0]);
    return portion?.label ?? null;
}

function realPortionOptions(
    candidate: FoodCandidate,
): FoodCandidate["portions"] {
    return deduplicatePortions(
        sortPortionsNaturalFirst(
            candidate.portions.filter((portion) => portion.amount > 0),
        ),
    ).slice(0, GROUNDING_PORTION_SHORTLIST_LIMIT);
}

/**
 * Code-driven refinement query used on decider abstention (or when
 * initial retrieval returns no generic candidate): appends the vision
 * cooking method when available and not already present, otherwise
 * "cooked". Returns null when the query is already refined.
 */
export function buildRefinementQuery(
    vision: MealPhotoVisionItem,
    originalQuery: string,
): string | null {
    const trimmed = originalQuery.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    const method = vision.cooking_method?.trim();
    if (method && !lower.includes(method.toLowerCase())) {
        return `${trimmed} ${method}`;
    }
    if (!lower.includes("cooked")) {
        return `${trimmed} cooked`;
    }
    return null;
}

function buildChoiceRequest(
    key: string,
    vision: MealPhotoVisionItem,
    shortlist: FoodCandidate[],
): MealPhotoCandidateChoiceRequest {
    return {
        key,
        itemName: vision.name,
        cookingMethod: vision.cooking_method,
        photographedAmount: `${vision.quantity} ${vision.unit}`,
        candidates: shortlist.map((candidate) => ({
            candidateId: encodeFoodCandidateId(candidate),
            name: candidate.name,
            brand: candidate.brand ?? null,
            provider: candidate.provider,
            dataKind: candidate.dataKind,
            defaultPortionLabel: defaultPortionLabelFor(candidate),
        })),
    };
}

function questionFor(
    vision: MealPhotoVisionItem,
    index: number,
): GroundedMealPhotoItem["question"] {
    if (vision.portion_confidence >= LOW_PORTION_CONFIDENCE) return null;
    return {
        questionKey: `photo_portion_${index}`,
        prompt: `About how much ${vision.name} — the photo estimate was ${vision.quantity} ${vision.unit}. Correct it if that looks off.`,
        impactScore: 80,
        blocking: false,
    };
}

function blockingQuestionFor(
    vision: MealPhotoVisionItem,
    index: number,
): GroundedMealPhotoItem["question"] {
    return {
        questionKey: blockingQuestionKey(index),
        prompt: `We couldn't find nutrition for ${vision.name} (${vision.quantity} ${vision.unit}) in a food database, and the automatic estimate didn't come through. Please supply or confirm its nutrition, or remove the item — this draft can't be confirmed until that's done.`,
        impactScore: 100,
        blocking: true,
    };
}

/**
 * The pipeline invariant, asserted by tests: an item is complete only
 * when it carries provider values, estimate values, or a blocking
 * question. Anything else is a silently-empty item — the production
 * defect this hardening removes.
 */
export function mealPhotoItemIsComplete(entry: GroundedMealPhotoItem): boolean {
    const hasValues = Object.values(entry.draftItem.nutrients).some(
        (value) => value !== undefined,
    );
    return hasValues || (entry.question !== null && entry.question.blocking);
}

export function isAmbiguous(query: string, ranked: FoodCandidate[]): boolean {
    const top = ranked[0];
    if (!top || ranked.length < 2) return false;
    const second = ranked[1]!;
    const margin =
        scoreCandidate({ query }, top) - scoreCandidate({ query }, second);
    return (
        top.confidence < AMBIGUITY_MIN_CONFIDENCE || margin < AMBIGUITY_MARGIN
    );
}

export async function groundMealPhotoItems(
    items: MealPhotoVisionItem[],
    deps: MealPhotoGroundingDeps,
): Promise<GroundedMealPhotoItem[]> {
    // Stage 3: deeper canonical search per item (25–50 fetched, generic
    // Foundation / SR Legacy / Survey prioritized ahead of branded noise).
    const searched = await Promise.all(
        items.map(async (vision) => {
            const query = vision.name.trim();
            const result = await deps.search(query, GROUNDING_RETRIEVAL_LIMIT, {
                preferGeneric: true,
            });
            const ranked = rankCandidates({ query }, result.candidates);
            return { vision, query, ranked };
        }),
    );

    // Stage 4a: ONE batched decider pick call for EVERY photo item that
    // returned candidates (replaces the legacy `isAmbiguous` gate).
    const pickRequests: MealPhotoCandidateChoiceRequest[] = [];
    if (deps.chooseCandidates) {
        searched.forEach(({ vision, ranked }, index) => {
            if (ranked.length === 0) return;
            pickRequests.push(
                buildChoiceRequest(
                    `item:${index}`,
                    vision,
                    ranked.slice(0, GROUNDING_DECIDER_SHORTLIST_LIMIT),
                ),
            );
        });
    }
    let choices = new Map<string, MealPhotoCandidateChoice>();
    let deciderFailed = false;
    if (pickRequests.length > 0 && deps.chooseCandidates) {
        try {
            choices = await deps.chooseCandidates(pickRequests);
        } catch {
            // Fail-open to deterministic behavior for the whole photo.
            deciderFailed = true;
            choices = new Map();
        }
    }

    // Stage 4a-retry: code-driven refinement retry (at most ONCE per item)
    // triggered by decider abstention ("none") or absence of any generic
    // candidate in the initial top 10. The model stays out of the fetch
    // loop — code constructs the refined query (name + cooking method /
    // "cooked") and, when fresh candidates arrive, consults the decider
    // once more before falling back to the estimate path.
    if (!deciderFailed) {
        const retryTargets: Array<{ index: number; refinedQuery: string }> = [];
        searched.forEach(({ vision, query, ranked }, index) => {
            const key = `item:${index}`;
            const choice = choices.get(key);
            const deciderAbstained =
                Boolean(deps.chooseCandidates) && choice?.candidateId === null;
            const deciderPicked = Boolean(choice?.candidateId);
            const hasGeneric = ranked
                .slice(0, GROUNDING_DECIDER_SHORTLIST_LIMIT)
                .some((candidate) => candidate.dataKind === "generic");
            const shouldRetry =
                deciderAbstained || (!deciderPicked && !hasGeneric);
            if (!shouldRetry) return;
            const refinedQuery = buildRefinementQuery(vision, query);
            if (refinedQuery) {
                retryTargets.push({ index, refinedQuery });
            }
        });

        if (retryTargets.length > 0) {
            const retryResults = await Promise.all(
                retryTargets.map(async ({ index, refinedQuery }) => {
                    try {
                        const result = await deps.search(
                            refinedQuery,
                            GROUNDING_RETRIEVAL_LIMIT,
                            { preferGeneric: true },
                        );
                        const retryRanked = rankCandidates(
                            { query: refinedQuery },
                            result.candidates,
                        );
                        return { index, retryRanked };
                    } catch {
                        return { index, retryRanked: [] as FoodCandidate[] };
                    }
                }),
            );

            const retryPickRequests: MealPhotoCandidateChoiceRequest[] = [];
            const retryRankedByIndex = new Map<number, FoodCandidate[]>();
            for (const { index, retryRanked } of retryResults) {
                if (retryRanked.length === 0) continue;
                const prevShortlistIds = new Set(
                    searched[index]!.ranked.slice(
                        0,
                        GROUNDING_DECIDER_SHORTLIST_LIMIT,
                    ).map(encodeFoodCandidateId),
                );
                const retryShortlist = retryRanked.slice(
                    0,
                    GROUNDING_DECIDER_SHORTLIST_LIMIT,
                );
                const hasNewCandidate = retryShortlist.some(
                    (candidate) =>
                        !prevShortlistIds.has(encodeFoodCandidateId(candidate)),
                );
                if (!hasNewCandidate) continue;
                retryRankedByIndex.set(index, retryRanked);
                if (deps.chooseCandidates) {
                    retryPickRequests.push(
                        buildChoiceRequest(
                            `item:${index}`,
                            searched[index]!.vision,
                            retryShortlist,
                        ),
                    );
                } else if (
                    retryRanked.some(
                        (candidate) => candidate.dataKind === "generic",
                    )
                ) {
                    searched[index]!.ranked = retryRanked;
                }
            }

            if (retryPickRequests.length > 0 && deps.chooseCandidates) {
                try {
                    const retryChoices =
                        await deps.chooseCandidates(retryPickRequests);
                    for (const [key, retryChoice] of retryChoices) {
                        const index = Number(key.replace("item:", ""));
                        const retryRanked = retryRankedByIndex.get(index);
                        if (!retryRanked) continue;
                        if (retryChoice.candidateId) {
                            searched[index]!.ranked = retryRanked;
                        }
                        choices.set(key, retryChoice);
                    }
                } catch {
                    // Keep the first pass outcome (abstention stays
                    // abstained — never force a wrong ground).
                }
            }
        }
    }

    // Stage 4b-i: resolve each item's chosen candidate.
    const selectedCandidates = searched.map(({ vision, ranked }, index) => {
        const key = `item:${index}`;
        const choice = !deciderFailed ? choices.get(key) : undefined;
        let candidate: FoodCandidate | undefined = ranked[0];
        let tieBreakUsed = false;
        if (choice) {
            tieBreakUsed = true;
            candidate = choice.candidateId
                ? ranked.find(
                      (entry) =>
                          encodeFoodCandidateId(entry) === choice.candidateId,
                  )
                : undefined;
            if (choice.candidateId && !candidate) {
                // Fabricated ID outside the ranked set: discard and
                // fail open to the deterministic pick.
                candidate = ranked[0];
            }
            if (choice.candidateId === null) candidate = undefined;
        }
        return { vision, ranked, index, key, candidate, tieBreakUsed };
    });

    // Stage 4b-ii: ONE batched portion choice call for all picked
    // candidates, offering ONLY each candidate's REAL portions.
    let portionChoices = new Map<string, MealPhotoPortionChoice>();
    if (deps.choosePortions && !deciderFailed) {
        const portionRequests: MealPhotoPortionChoiceRequest[] = [];
        for (const entry of selectedCandidates) {
            if (!entry.candidate) continue;
            const portions = realPortionOptions(entry.candidate);
            if (portions.length === 0) continue;
            portionRequests.push({
                key: entry.key,
                foodName: entry.candidate.name,
                photographedAmount: `${entry.vision.quantity} ${entry.vision.unit}`,
                portions: portions.map((portion) => ({
                    id: portion.id,
                    label: portion.label,
                    gramWeight: portion.gramWeight ?? null,
                    calories: portion.nutrients.calories ?? null,
                })),
            });
        }
        if (portionRequests.length > 0) {
            try {
                portionChoices = await deps.choosePortions(portionRequests);
            } catch {
                // Portion decider failure fails open to deterministic
                // `resolveGroundedPortion`.
                portionChoices = new Map();
            }
        }
    }

    // Stage 4b-iii: validate & scale each picked candidate's portion,
    // falling back to deterministic `resolveGroundedPortion` whenever
    // the portion choice is absent, unknown, or dimensionally invalid.
    const picks = selectedCandidates.map(
        ({ vision, ranked, index, key, candidate, tieBreakUsed }) => {
            const chosenPortion = portionChoices.get(key);
            let resolution: PortionResolution | null = null;
            if (candidate) {
                if (chosenPortion) {
                    resolution = resolveChosenPortion(
                        vision,
                        candidate,
                        chosenPortion.portionId,
                    );
                }
                if (!resolution) {
                    resolution = resolveGroundedPortion(vision, candidate);
                }
            }
            let countMismatch = false;
            if (candidate && !resolution) {
                if (portionUnitKind(vision.unit) === "count") {
                    const viaDonor = resolveCountViaDonor(
                        vision,
                        candidate,
                        ranked,
                    );
                    if (viaDonor) {
                        candidate = viaDonor.candidate;
                        resolution = viaDonor.resolution;
                    } else {
                        countMismatch = true;
                    }
                }
            }
            return {
                vision,
                index,
                key,
                candidate,
                resolution,
                tieBreakUsed,
                countMismatch,
            };
        },
    );

    // Stage 4c: labelled model-estimate fallback for ungrounded items.
    const estimateRequests: MealPhotoEstimateRequest[] = picks
        .filter((pick) => !(pick.candidate && pick.resolution))
        .map((pick) => ({
            key: pick.key,
            name: pick.vision.name,
            cookingMethod: pick.vision.cooking_method,
            quantity: pick.vision.quantity,
            unit: pick.vision.unit,
            assumptions: [...pick.vision.assumptions],
            ...(pick.countMismatch ? { gramWeightNeeded: true } : {}),
        }));
    let estimates = new Map<string, MealPhotoEstimate>();
    if (estimateRequests.length > 0 && deps.estimateNutrients) {
        try {
            estimates = await deps.estimateNutrients(estimateRequests);
        } catch {
            estimates = new Map();
        }
    }

    // Stage 4d: build draft items. Nutrition from the picked provider
    // candidate, else from the labelled estimate, else nothing at all
    // plus a blocking question — never silently empty.
    return picks.map(
        ({
            vision,
            index,
            key,
            candidate,
            resolution,
            tieBreakUsed,
            countMismatch,
        }) => {
            const portionQuestion = questionFor(vision, index);
            const portionLabel = `${vision.quantity} ${vision.unit}`;
            if (candidate && resolution) {
                const displayName = [candidate.brand, candidate.name]
                    .filter(Boolean)
                    .join(" — ")
                    .slice(0, 500);
                const assumptions = [...vision.assumptions];
                if (resolution.assumption)
                    assumptions.push(resolution.assumption);
                return {
                    vision,
                    draftItem: {
                        name: displayName || vision.name,
                        quantity: vision.quantity,
                        portionLabel,
                        gramWeight: resolution.gramWeight,
                        nutrients: resolution.nutrients,
                        sourceType: candidate.provider,
                        provider: candidate.provider,
                        providerFoodId: candidate.providerFoodId,
                        providerRevision: candidate.sourceUpdatedAt,
                        sourceUrl: candidate.attribution.url,
                        sourceUpdatedAt: candidate.sourceUpdatedAt,
                        confidence: vision.portion_confidence,
                        assumptions: assumptions.slice(0, 20),
                        sourceSnapshot: {
                            resolution_layer: "meal_photo_grounding",
                            vision_name: vision.name,
                            cooking_method: vision.cooking_method,
                            portion_confidence: vision.portion_confidence,
                            candidate_id: encodeFoodCandidateId(candidate),
                            provider: candidate.provider,
                            provider_food_id: candidate.providerFoodId,
                            selected_portion_id: resolution.portionId,
                            tie_break_used: tieBreakUsed,
                            ...(resolution.countConversion
                                ? {
                                      count_conversion:
                                          resolution.countConversion,
                                  }
                                : {}),
                            nutrition_snapshot: resolution.nutrients,
                        },
                    },
                    groundingSource: groundingSourceFor(candidate),
                    grounded: true,
                    estimated: false,
                    candidateId: encodeFoodCandidateId(candidate),
                    tieBreakUsed,
                    needsQuestion: portionQuestion !== null,
                    question: portionQuestion,
                };
            }
            const estimate = estimates.get(key);
            const usableEstimate =
                estimate &&
                Object.values(estimate.nutrients).some(
                    (value) => value !== undefined,
                ) &&
                (estimate.nutrients.calories ?? 0) > 0
                    ? estimate
                    : undefined;
            if (usableEstimate) {
                const assumptions = [...vision.assumptions];
                let question = portionQuestion;
                if (countMismatch) {
                    if (usableEstimate.gramWeight !== undefined) {
                        const perPiece =
                            vision.quantity > 0
                                ? round2(
                                      usableEstimate.gramWeight /
                                          vision.quantity,
                                  )
                                : usableEstimate.gramWeight;
                        assumptions.push(
                            `Estimated weight: ${vision.quantity} ${vision.unit} ≈ ${usableEstimate.gramWeight} g (about ${perPiece} g each) — model estimate; the food database entry for this item only reports per-100 g values.`,
                        );
                    } else if (!question) {
                        question = {
                            questionKey: `photo_portion_${index}`,
                            prompt: `How much does one ${vision.unit} of ${vision.name} weigh in grams? The draft uses estimated nutrition for ${vision.quantity} ${vision.unit}, but the item's database entry only reports per-100 g values and no gram weight could be derived.`,
                            impactScore: 85,
                            blocking: false,
                        };
                    }
                }
                return {
                    vision,
                    draftItem: {
                        name: vision.name,
                        quantity: vision.quantity,
                        portionLabel,
                        gramWeight: usableEstimate.gramWeight,
                        nutrients: usableEstimate.nutrients,
                        sourceType: "model_estimate" as const,
                        confidence: vision.portion_confidence,
                        assumptions: assumptions.slice(0, 20),
                        sourceSnapshot: {
                            resolution_layer: "meal_photo_grounding",
                            vision_name: vision.name,
                            cooking_method: vision.cooking_method,
                            portion_confidence: vision.portion_confidence,
                            candidate_id: null,
                            tie_break_used: tieBreakUsed,
                            estimate_origin: "model_estimate",
                            estimate_step: "meal_photo_estimate",
                            ...(countMismatch ? { count_mismatch: true } : {}),
                            ...(usableEstimate.gramWeight !== undefined
                                ? {
                                      estimate_gram_weight:
                                          usableEstimate.gramWeight,
                                  }
                                : {}),
                            nutrition_snapshot: usableEstimate.nutrients,
                        },
                    },
                    groundingSource: "model_estimate" as const,
                    grounded: false,
                    estimated: true,
                    candidateId: null,
                    tieBreakUsed,
                    needsQuestion: question !== null,
                    question,
                };
            }
            const blocking = blockingQuestionFor(vision, index);
            return {
                vision,
                draftItem: {
                    name: vision.name,
                    quantity: vision.quantity,
                    portionLabel,
                    nutrients: {},
                    sourceType: "model_estimate" as const,
                    confidence: vision.portion_confidence,
                    assumptions: [...vision.assumptions].slice(0, 20),
                    sourceSnapshot: {
                        resolution_layer: "meal_photo_grounding",
                        vision_name: vision.name,
                        cooking_method: vision.cooking_method,
                        portion_confidence: vision.portion_confidence,
                        candidate_id: null,
                        tie_break_used: tieBreakUsed,
                        estimate_origin: "model_estimate",
                        estimate_step: "meal_photo_estimate",
                        estimate_status: "unavailable",
                        blocking_question_key: blocking!.questionKey,
                    },
                },
                groundingSource: "model_estimate" as const,
                grounded: false,
                estimated: false,
                candidateId: null,
                tieBreakUsed,
                needsQuestion: true,
                question: blocking,
            };
        },
    );
}
