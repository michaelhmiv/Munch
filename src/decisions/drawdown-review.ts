/**
 * B4 — draw-down anomaly review (jev-accountability-audit 2026-11-13
 * §2, seat B4).
 *
 * Where: `src/inventory/drawdown.ts`, invoked from cook logging. A
 * draw computed against a wrong match or an approximate quantity
 * silently depletes (or never depletes) stock; #283's law already
 * forbids presence-only stock from proving a shortfall — the hole
 * B4 watches is exact-stock draws against a bad B3-class match, and
 * approximate stock whose remainder category flips.
 *
 * Check: the seat engages ONLY on anomaly (detection is
 * deterministic, in `detectDrawdownAnomalies`): a draw exceeding the
 * recorded exact stock, or a draw that flips an approximate item's
 * remainder category to nearly-gone. Jev reviews the match + quantity
 * INPUTS — is the pantry item really the ingredient, and is the
 * amount a plausible draw? It never reviews the arithmetic: scaling
 * math stays code's job (standing law).
 *
 * FAIL-OPEN: the draw proceeds exactly as today in every failure
 * mode. The review's product is the accountability trail — a
 * `jev_review` annotation on the affected draw-down line plus the
 * client log (seat, model, probabilities, `cost_usd` from the
 * Decisions client) — never a block.
 */
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    drawdownMatchThresholdForModel,
    drawdownQuantityThresholdForModel,
    type DecisionsConfig,
} from "./config.js";
import { noulProbability } from "./gate.js";
import type { DrawdownAnomaly } from "../inventory/drawdown.js";

export interface DrawdownReview {
    model: string;
    pMatchCorrect: number;
    pQuantityPlausible: number;
    reportedCostUsd: number | null;
    durationMs: number;
}

export interface DrawdownReviewDependencies {
    fetcher?: DecisionsFetcher;
}

/** Plain-style question set: descriptions, not commands. */
export function drawdownReviewQuestions(): Record<string, unknown> {
    return {
        match_correct: {
            type: "noul",
            instructions:
                "Is the pantry item the same food as the recipe ingredient whose usage was drawn from it? Minor wording differences for the same underlying ingredient count as the same food; a different food, or a prepared product made from the ingredient, does not.",
        },
        quantity_plausible: {
            type: "noul",
            instructions:
                "Is the total amount drawn a plausible amount of this food to use when cooking, given the ingredient amount the recipe called for? Amounts a home cook could plausibly use for a large batch, a holiday meal, or preserving count as plausible even when they exceed the recorded stock; amounts no ordinary cooking would use (many cups of a spice, many litres of oil for one recipe) do not.",
        },
    };
}

export function drawdownReviewState(anomaly: DrawdownAnomaly): unknown {
    return {
        task: "Review a pantry draw-down anomaly: a cook log drew stock from a pantry item under conditions code flagged as unusual. Judge only whether the match and the quantity look right; the arithmetic is not in question.",
        anomaly: anomaly.kind,
        recipe_ingredient: {
            name: anomaly.ingredient,
            quantity: anomaly.ingredientQuantity,
            unit: anomaly.ingredientUnit,
        },
        pantry_item: {
            name: anomaly.pantryName,
            recorded_quantity: anomaly.recordedQuantity,
            unit: anomaly.recordedUnit,
            quantity_mode: anomaly.quantityMode,
        },
        total_drawn: {
            quantity: anomaly.requestedQuantity,
            unit: anomaly.requestedUnit,
        },
    };
}

/**
 * Ask the Decisions chain about one anomaly. Throws on chain
 * exhaustion or an unparseable answer — the caller degrades to
 * `unchecked` and the draw stands (fail-open).
 */
export async function reviewDrawdownAnomaly(
    anomaly: DrawdownAnomaly,
    config: DecisionsConfig,
    dependencies: DrawdownReviewDependencies = {},
): Promise<DrawdownReview> {
    const result = await callDecisionsWithFallback(config, {
        seat: "drawdown_review",
        timeoutMs: config.drawdownReviewTimeoutMs,
        includeImageHeader: false,
        fetcher: dependencies.fetcher,
        state: drawdownReviewState(anomaly),
        questions: drawdownReviewQuestions(),
    });
    const pMatchCorrect = noulProbability(result.answers.match_correct);
    const pQuantityPlausible = noulProbability(
        result.answers.quantity_plausible,
    );
    if (pMatchCorrect === null || pQuantityPlausible === null) {
        throw new Error("Draw-down review returned an unparseable answer");
    }
    return {
        model: result.model,
        pMatchCorrect,
        pQuantityPlausible,
        reportedCostUsd: result.reportedCostUsd,
        durationMs: result.durationMs,
    };
}

/** Flagged when either input judgment falls below the serving
 * model's own calibrated threshold. */
export function drawdownAnomalyFlagged(review: DrawdownReview): boolean {
    return (
        review.pMatchCorrect < drawdownMatchThresholdForModel(review.model) ||
        review.pQuantityPlausible <
            drawdownQuantityThresholdForModel(review.model)
    );
}
