/**
 * C1 — water/weight outlier judgment (jev-accountability-audit
 * 2026-11-13, §2 seat C1; Tier 3, outlier-only form).
 *
 * Honest fit (audit): a deterministic check against the user's own
 * history does the first pass for free. A water entry is an outlier
 * only when it exceeds 3x the user's median entry; a weight entry
 * only when it jumps more than 5% from the user's most recent prior
 * weight. Normal entries NEVER engage a model (zero calls).
 *
 * Only on an outlier does the decision chain make the semantic read
 * a ratio cannot: "2,500 ml at 7 AM from a user whose usual entry is
 * a 500 ml bottle" is likelier an oz/ml slip or a whole day's total
 * entered as one entry than a real drink; a 10 lb overnight weight
 * jump is likelier a decimal slip than physiology — while an
 * athlete's 2 L post-race entry or a genuine post-illness weight
 * change is unusual but real, and must NOT be nagged.
 *
 * SOFT PROMPT ONLY: the seat's only action is an advisory prompt the
 * client surfaces after the entry has already saved ("This looks
 * like… log it anyway?" — keep it, or remove it). It never blocks,
 * never edits, and never rewrites an entry. FAIL-OPEN everywhere:
 * flag off, no config, too little history, chain down, unparseable
 * answer, or a model that says "genuine" all resolve to no prompt
 * and the entry stands exactly as logged today.
 */
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    decisionsConfig,
    outlierMistakeThresholdForModel,
    type DecisionsConfig,
} from "./config.js";
import { noulProbability } from "./gate.js";

export type OutlierKind = "water" | "weight";

export interface OutlierSeriesPoint {
    /** Water: amount_ml. Weight: weight_g. */
    value: number;
    logged_at: string;
}

export interface OutlierCandidate {
    kind: OutlierKind;
    entry: OutlierSeriesPoint;
    /** Prior entries only (never including the candidate), newest last. */
    recent: OutlierSeriesPoint[];
}

export interface OutlierDetection {
    isOutlier: boolean;
    /** Water: entry / median. Weight: entry / previous. */
    ratio: number | null;
    /** Water: median of prior entries. Weight: most recent prior value. */
    baseline: number | null;
    reason: "water_over_3x_median" | "weight_over_5pct_jump" | null;
}

export type OutlierPromptVerdict =
    | { action: "none"; reason: string }
    | {
          action: "prompt";
          reason: string;
          model: string;
          pMistake: number;
          threshold: number;
          explanation: string | null;
          message: string;
          /** API-reported cost of the deciding call (auditable, §4). */
          reportedCostUsd: number | null;
          durationMs: number;
      };

export interface OutlierDependencies {
    fetcher?: DecisionsFetcher;
    /** Test/drill seam: supply a config instead of reading the env. */
    config?: DecisionsConfig | null;
}

/** Water outliers need a real median; below this, no baseline exists. */
export const WATER_MIN_SERIES = 3;
export const WATER_OUTLIER_RATIO = 3;
export const WEIGHT_OUTLIER_JUMP = 0.05;

function median(values: number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The deterministic first pass. Pure and free — this, not the model,
 * decides whether the seat engages at all.
 */
export function detectOutlier(candidate: OutlierCandidate): OutlierDetection {
    const prior = candidate.recent.filter(
        (point) => Number.isFinite(point.value) && point.value > 0,
    );
    if (candidate.kind === "water") {
        if (prior.length < WATER_MIN_SERIES) {
            return {
                isOutlier: false,
                ratio: null,
                baseline: null,
                reason: null,
            };
        }
        const baseline = median(prior.map((point) => point.value));
        if (!baseline || baseline <= 0) {
            return { isOutlier: false, ratio: null, baseline, reason: null };
        }
        const ratio = candidate.entry.value / baseline;
        return {
            isOutlier: ratio > WATER_OUTLIER_RATIO,
            ratio,
            baseline,
            reason: ratio > WATER_OUTLIER_RATIO ? "water_over_3x_median" : null,
        };
    }
    const previous = prior[prior.length - 1];
    if (!previous) {
        return { isOutlier: false, ratio: null, baseline: null, reason: null };
    }
    const ratio = candidate.entry.value / previous.value;
    const jump = Math.abs(ratio - 1);
    return {
        isOutlier: jump > WEIGHT_OUTLIER_JUMP,
        ratio,
        baseline: previous.value,
        reason: jump > WEIGHT_OUTLIER_JUMP ? "weight_over_5pct_jump" : null,
    };
}

const EXPLANATION_OPTIONS = [
    "genuine",
    "unit_slip",
    "day_total_as_single_entry",
    "decimal_slip",
    "other_mistake",
] as const;

export function outlierQuestions(kind: OutlierKind): Record<string, unknown> {
    const unit =
        kind === "water"
            ? "milliliters of water in a single logged entry"
            : "body weight in grams";
    return {
        likely_mistake: {
            type: "noul",
            instructions:
                `A nutrition-tracking user logged a new ${kind} entry that is far outside their own recent pattern. ` +
                `Considering the entry, its time of day, and the user's recent series, is this entry more likely a logging mistake — such as a unit slip (ounces entered as milliliters, pounds and kilograms confused), a whole day's total entered as a single entry, or a misplaced decimal point — than a genuine ${kind} entry the user actually meant to record in these ${unit}? ` +
                "Unusual is not the same as mistaken: athletes, hot days, long events, illness and recovery can all produce genuine entries far from a person's usual pattern.",
        },
        explanation: {
            type: "choice",
            instructions: "Which one of these best explains this entry?",
            criteria: {
                genuine:
                    "A genuine entry the user meant to log, however unusual for them (for example hard exercise, heat, travel, illness, or recovery).",
                unit_slip:
                    "A unit slip: the number fits a different unit than the one recorded (ounces vs milliliters, pounds vs kilograms).",
                day_total_as_single_entry:
                    "A whole day's total entered as one single entry instead of spread across the day.",
                decimal_slip:
                    "A decimal slip: the number is a plausible entry with the decimal point in the wrong place.",
                other_mistake:
                    "Some other logging mistake that fits better than the options above.",
            },
        },
    };
}

export function buildOutlierState(
    candidate: OutlierCandidate,
    detection: OutlierDetection,
): unknown {
    return {
        task: "Judge whether an outlier water/weight log entry is a likely logging mistake or a genuine entry.",
        kind: candidate.kind,
        units: candidate.kind === "water" ? "milliliters" : "grams",
        new_entry: {
            value: candidate.entry.value,
            logged_at: candidate.entry.logged_at,
        },
        recent_series_prior_entries: candidate.recent
            .slice(-14)
            .map((point) => ({
                value: point.value,
                logged_at: point.logged_at,
            })),
        deterministic_baseline: detection.baseline,
        ratio_to_baseline: detection.ratio
            ? Math.round(detection.ratio * 100) / 100
            : null,
        deterministic_trigger: detection.reason,
    };
}

function explanationLabel(
    kind: OutlierKind,
    explanation: string | null,
): string {
    switch (explanation) {
        case "unit_slip":
            return kind === "water"
                ? "This looks like a unit slip — for example ounces entered as milliliters."
                : "This looks like a unit slip — for example pounds and kilograms confused.";
        case "day_total_as_single_entry":
            return "This looks like a whole day's total entered as a single entry.";
        case "decimal_slip":
            return "This looks like a decimal slip — a digit may be in the wrong place.";
        case "other_mistake":
            return "This looks different from what you usually log.";
        default:
            return "This looks different from what you usually log.";
    }
}

export function outlierPromptMessage(
    candidate: OutlierCandidate,
    detection: OutlierDetection,
    explanation: string | null,
): string {
    const detail =
        candidate.kind === "water"
            ? `You logged ${candidate.entry.value} ml; your usual entry is about ${Math.round(detection.baseline ?? 0)} ml.`
            : `This is more than a 5% change from your last logged weight.`;
    return `${explanationLabel(candidate.kind, explanation)} ${detail} Log it anyway?`;
}

/**
 * Evaluate one already-saved entry. NEVER throws and NEVER blocks:
 * every failure mode resolves to `{ action: "none" }`.
 */
export async function evaluateOutlierPrompt(
    candidate: OutlierCandidate,
    dependencies: OutlierDependencies = {},
): Promise<OutlierPromptVerdict> {
    const none = (reason: string): OutlierPromptVerdict => {
        console.info(
            `[decisions] seat=outlier status=no_prompt reason=${reason}`,
        );
        return { action: "none", reason };
    };
    try {
        const detection = detectOutlier(candidate);
        if (!detection.isOutlier) return none("not_outlier");
        const config =
            dependencies.config !== undefined
                ? dependencies.config
                : decisionsConfig();
        if (!config || !config.outlierEnabled) return none("seat_disabled");
        const result = await callDecisionsWithFallback(config, {
            seat: "outlier",
            timeoutMs: config.outlierTimeoutMs,
            includeImageHeader: false,
            fetcher: dependencies.fetcher,
            state: buildOutlierState(candidate, detection),
            questions: outlierQuestions(candidate.kind),
        });
        const pMistake = noulProbability(result.answers.likely_mistake);
        if (pMistake === null) return none("unparseable_mistake_answer");
        const explanationAnswer = result.answers.explanation as
            Record<string, unknown> | undefined;
        const explanation =
            explanationAnswer &&
            explanationAnswer.type === "choice" &&
            typeof explanationAnswer.choice === "string" &&
            (EXPLANATION_OPTIONS as readonly string[]).includes(
                explanationAnswer.choice,
            )
                ? explanationAnswer.choice
                : null;
        const threshold = outlierMistakeThresholdForModel(result.model);
        console.info(
            `[decisions] seat=outlier verdict p_mistake=${pMistake} threshold=${threshold} explanation=${explanation ?? "null"} model=${result.model} cost_usd=${result.reportedCostUsd ?? "null"}`,
        );
        if (pMistake < threshold) return none("model_says_genuine");
        return {
            action: "prompt",
            reason: "likely_logging_mistake",
            model: result.model,
            pMistake,
            threshold,
            explanation,
            message: outlierPromptMessage(candidate, detection, explanation),
            reportedCostUsd: result.reportedCostUsd,
            durationMs: result.durationMs,
        };
    } catch {
        return none("decisions_unavailable");
    }
}
