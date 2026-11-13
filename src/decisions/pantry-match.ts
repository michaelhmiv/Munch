/**
 * B3 — pantry identity / duplicate review (jev-accountability-audit
 * 2026-11-13 §2, seat B3).
 *
 * Where: pantry add + scan-confirm, around `bestInventoryMatch`
 * (`src/inventory/matching.ts`, identity threshold 0.62). A near-
 * threshold pair fragments stock ("cheddar cheese" filed beside
 * "sharp cheddar cheese") or merges strangers, and every presence
 * flag, shortfall line, and draw-down then reasons over a wrong
 * inventory — silently, forever.
 *
 * Check: pairs landing in the 0.50–0.75 grey band get ONE Jev
 * question set — are these the same item, and are the units
 * compatible for a merge? Outside the band behaviour is identical to
 * today: above the band the deterministic match merges with no call;
 * below it nothing merges and no call is made.
 *
 * FAIL-OPEN = NO MERGE: with the seat enabled, a grey pair merges
 * only on a confident model yes to BOTH questions. A down chain, an
 * unparseable answer, or a model no leaves the pair separate —
 * today's conservative grey-pair outcome — and the attempt is logged
 * `unchecked`. With the seat disabled the resolver is exactly
 * `bestInventoryMatch`, byte for byte.
 *
 * One code guard stands above the model: a mass↔volume pair can
 * never merge, because code cannot convert between the families
 * (models judge inputs; arithmetic stays code's job). The model is
 * still asked — its verdict is logged — but the merge is refused.
 *
 * The seat rides the existing Decisions client
 * (`callDecisionsWithFallback`), so the Jev → Perplexity fallback
 * chain and `cost_usd` logging are inherited, never re-implemented.
 */
import {
    bestInventoryMatch,
    crossFamilyInventoryUnits,
    greyBandMatchCandidates,
    inventoryMatchCandidates,
    isPantryGreyBandScore,
    PANTRY_GREY_BAND_MAX,
    type IngredientRequirement,
    type InventoryMatchableItem,
} from "../inventory/matching.js";
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    decisionsConfig,
    pantrySameItemThresholdForModel,
    pantryUnitsCompatibleThresholdForModel,
    type DecisionsConfig,
} from "./config.js";
import { noulProbability } from "./gate.js";

export interface PantryIdentityPair {
    incoming: {
        name: string;
        quantity: number | null;
        unit: string | null;
    };
    existing: {
        id: string;
        name: string;
        quantity: number | null;
        unit: string | null;
        quantityMode: InventoryMatchableItem["quantity_mode"];
    };
    identityScore: number;
}

export interface PantryIdentityReview {
    model: string;
    pSameItem: number;
    pUnitsCompatible: number;
    reportedCostUsd: number | null;
    durationMs: number;
}

export interface PantryIdentityDependencies {
    fetcher?: DecisionsFetcher;
    /** Test/drill seam: supply a config instead of reading the env. */
    config?: DecisionsConfig | null;
}

/** Plain-style question set (descriptions, not commands — the style
 * the S1 probe settled on). Two Noul questions, one call. */
export function pantryMatchQuestions(): Record<string, unknown> {
    return {
        same_item: {
            type: "noul",
            instructions:
                "Are the incoming pantry item and the existing pantry item the same food product, such that stock of one is stock of the other in a home pantry? Minor differences in grade, cut descriptors, brand, or packaging wording for the same underlying ingredient count as the same item; a prepared or derived product made FROM the ingredient (crackers, frosting, patties, cups, dips) is a different item.",
        },
        units_compatible: {
            type: "noul",
            instructions:
                "Could the incoming quantity be added to the existing stock as a single combined amount, because both quantities are expressed in the same unit or in units that measure the same kind of amount (both weights, or both volumes)? Quantities counted in pieces cannot be added to weights or volumes, and a weight cannot be added to a volume.",
        },
    };
}

export function pantryMatchState(pair: PantryIdentityPair): unknown {
    return {
        task: "Decide whether an incoming pantry item should merge into an existing pantry item instead of being stored as a separate item.",
        incoming_item: {
            name: pair.incoming.name,
            quantity: pair.incoming.quantity,
            unit: pair.incoming.unit,
        },
        existing_pantry_item: {
            name: pair.existing.name,
            quantity: pair.existing.quantity,
            unit: pair.existing.unit,
            quantity_mode: pair.existing.quantityMode,
        },
    };
}

/**
 * Ask the Decisions chain about one grey-band pair. Throws on chain
 * exhaustion; an unparseable answer also throws (the caller treats
 * every failure as fail-open). The raw probabilities are returned so
 * callers and the eval harness score the serving model against its
 * own calibrated thresholds.
 */
export async function reviewPantryIdentityPair(
    pair: PantryIdentityPair,
    config: DecisionsConfig,
    dependencies: PantryIdentityDependencies = {},
): Promise<PantryIdentityReview> {
    const result = await callDecisionsWithFallback(config, {
        seat: "pantry_match",
        timeoutMs: config.pantryMatchTimeoutMs,
        includeImageHeader: false,
        fetcher: dependencies.fetcher,
        state: pantryMatchState(pair),
        questions: pantryMatchQuestions(),
    });
    const pSameItem = noulProbability(result.answers.same_item);
    const pUnitsCompatible = noulProbability(result.answers.units_compatible);
    if (pSameItem === null || pUnitsCompatible === null) {
        throw new Error(
            "Pantry identity review returned an unparseable answer",
        );
    }
    return {
        model: result.model,
        pSameItem,
        pUnitsCompatible,
        reportedCostUsd: result.reportedCostUsd,
        durationMs: result.durationMs,
    };
}

/** The merge verdict for one reviewed pair, under the serving
 * model's own calibrated thresholds. */
export function pantryPairMerges(
    pair: PantryIdentityPair,
    review: PantryIdentityReview,
): boolean {
    if (
        crossFamilyInventoryUnits(pair.incoming.unit, pair.existing.unit)
    ) {
        return false;
    }
    return (
        review.pSameItem >= pantrySameItemThresholdForModel(review.model) &&
        review.pUnitsCompatible >=
            pantryUnitsCompatibleThresholdForModel(review.model)
    );
}

export type PantryIdentityResolution =
    | {
          action: "merge";
          item: InventoryMatchableItem;
          score: number;
          via: "deterministic" | "jev";
          review: PantryIdentityReview | null;
      }
    | {
          action: "separate";
          reason:
              | "no_candidate"
              | "below_band"
              | "model_declined"
              | "units_cross_family"
              | "unchecked";
          /** True when the Decisions chain actually reviewed a pair. */
          checked: boolean;
          review: PantryIdentityReview | null;
      };

/**
 * Resolve an incoming pantry item against existing stock: merge into
 * at most one existing item, or stay separate.
 *
 * Seat disabled (or no config): exactly today's `bestInventoryMatch`.
 * Seat enabled: an above-band unit-compatible match merges with no
 * model call; the top grey-band candidate (unit-incompatible pairs
 * included — compatibility is one of the questions) gets one review;
 * everything else stays separate with no call.
 */
export async function resolvePantryIdentity(
    items: InventoryMatchableItem[],
    requirement: IngredientRequirement,
    dependencies: PantryIdentityDependencies = {},
): Promise<PantryIdentityResolution> {
    const config =
        dependencies.config !== undefined
            ? dependencies.config
            : decisionsConfig();
    if (!config || !config.pantryMatchEnabled) {
        const match = bestInventoryMatch(items, requirement);
        if (match) {
            return {
                action: "merge",
                item: match.item,
                score: match.score,
                via: "deterministic",
                review: null,
            };
        }
        return {
            action: "separate",
            reason: "no_candidate",
            checked: false,
            review: null,
        };
    }

    const candidates = inventoryMatchCandidates(items, requirement);
    const aboveBand = candidates.find(
        (candidate) =>
            candidate.score > PANTRY_GREY_BAND_MAX && candidate.unitsCompatible,
    );
    if (aboveBand) {
        return {
            action: "merge",
            item: aboveBand.item,
            score: aboveBand.score,
            via: "deterministic",
            review: null,
        };
    }
    const grey = greyBandMatchCandidates(items, requirement)[0];
    if (!grey) {
        const top = candidates[0];
        return {
            action: "separate",
            reason:
                top && !isPantryGreyBandScore(top.score)
                    ? "below_band"
                    : "no_candidate",
            checked: false,
            review: null,
        };
    }
    const pair: PantryIdentityPair = {
        incoming: {
            name: requirement.name,
            quantity: requirement.quantity ?? null,
            unit: requirement.unit ?? null,
        },
        existing: {
            id: grey.item.id,
            name: grey.item.name,
            quantity: grey.item.quantity,
            unit: grey.item.unit,
            quantityMode: grey.item.quantity_mode,
        },
        identityScore: grey.score,
    };
    let review: PantryIdentityReview;
    try {
        review = await reviewPantryIdentityPair(pair, config, dependencies);
    } catch (error) {
        console.info(
            `[decisions] seat=pantry_match status=unchecked reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
        return {
            action: "separate",
            reason: "unchecked",
            checked: false,
            review: null,
        };
    }
    console.info(
        `[decisions] seat=pantry_match verdict p_same_item=${review.pSameItem} p_units_compatible=${review.pUnitsCompatible} model=${review.model} score=${grey.score}`,
    );
    if (crossFamilyInventoryUnits(pair.incoming.unit, pair.existing.unit)) {
        return {
            action: "separate",
            reason: "units_cross_family",
            checked: true,
            review,
        };
    }
    if (pantryPairMerges(pair, review)) {
        return {
            action: "merge",
            item: grey.item,
            score: grey.score,
            via: "jev",
            review,
        };
    }
    return {
        action: "separate",
        reason: "model_declined",
        checked: true,
        review,
    };
}

/**
 * Scan-confirm wiring: review a batch of confirmed-able lines
 * (receipt / pantry-scan preview lines) against the live pantry and
 * return, per line index, the identity resolution for lines that had
 * any candidate at all. Lines with no candidate are omitted — the
 * confirm UI treats them exactly as today (a fresh item). Never
 * throws: a seat failure leaves every line unchecked.
 */
export async function attachPantryIdentityReviews<
    T extends {
        name: string;
        quantity?: number | null;
        unit?: string | null;
        is_food?: boolean;
    },
>(
    lines: readonly T[],
    pantryItems: InventoryMatchableItem[],
    dependencies: PantryIdentityDependencies = {},
): Promise<Record<number, PantryIdentityResolution>> {
    const reviews: Record<number, PantryIdentityResolution> = {};
    // Cap the batch: scan previews are user-confirmed line by line,
    // and anomaly volume is small; the cap bounds worst-case latency.
    // Indices always refer to the caller's original line order.
    const limit = Math.min(lines.length, 15);
    for (let index = 0; index < limit; index += 1) {
        const line = lines[index]!;
        if (line.is_food === false) continue;
        try {
            const resolution = await resolvePantryIdentity(
                pantryItems,
                {
                    name: line.name,
                    quantity: line.quantity ?? null,
                    unit: line.unit ?? null,
                },
                dependencies,
            );
            if (resolution.action === "merge" || resolution.checked) {
                reviews[index] = resolution;
            }
        } catch (error) {
            console.info(
                `[decisions] seat=pantry_match status=unchecked line=${index} reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
            );
        }
    }
    return reviews;
}
