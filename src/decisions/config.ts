/**
 * Model-integration seats S1/S2 (approved brief:
 * munch-prep/parity-program/model-integration-brief.md) — configuration
 * for the OpenRouter Decisions-API client.
 *
 * FALLBACK LAW (Michael, Nov 11): the decision model is a CONFIG value,
 * never a code path. A provider failure changes a slug in
 * `MUNCH_DECIDER_FALLBACK_MODELS`, not the selection logic; the terminal
 * state (whole chain down) is the behaviour production already had.
 *
 * Flags ship OFF: with `MUNCH_JEV_ENABLED` unset the seats are inert and
 * the meal-photo pipeline is byte-identical to the pre-integration code.
 * Production enablement is per seat, with Michael's explicit confirmation
 * per seat (brief "Config").
 */

export const DECISIONS_API_URL = "https://openrouter.ai/api/alpha/decisions";

export const DEFAULT_DECIDER_MODEL = "typesafe/jev-1.14";

/** Fallback #1 designated by the Nov 11 fallback bake-off (PR #247;
 * ~/workspace/munch-evidence/fallback-bakeoff/report.md).
 * liquid/d1-ultra was fallback #2 in that designation and was
 * REMOVED on Nov 11 by Michael's ruling: Liquid's terms permit
 * retention and training use of request data, which Munch's privacy
 * policy forbids. Do not re-add it without a fresh ruling and
 * evidence its endpoint terms have changed. Its calibrated gate
 * threshold below is retained as measurement data only. */
export const DEFAULT_DECIDER_FALLBACK_MODELS = "perplexity/pplx-decider-v1.2";

export interface DecisionsConfig {
    apiKey: string;
    /** Full Decisions endpoint URL (override exists for tests/drills). */
    apiUrl: string;
    /** Ordered model chain: primary first, then fallbacks. */
    models: string[];
    gateTimeoutMs: number;
    deciderTimeoutMs: number;
    gateEnabled: boolean;
    deciderEnabled: boolean;
    /** C2 shortfall-contradiction seat (audit §2 C2). Optional so
     * existing config literals in sibling seats/tests stay valid;
     * `decisionsConfig()` always populates both fields. */
    shortfallCheckEnabled?: boolean;
    shortfallCheckTimeoutMs?: number;
    /** Seat B3 — pantry identity / duplicate review (audit §2). */
    pantryMatchEnabled: boolean;
    pantryMatchTimeoutMs: number;
    /** Seat B4 — draw-down anomaly review (audit §2). */
    drawdownReviewEnabled: boolean;
    drawdownReviewTimeoutMs: number;
}

type FlagState = "on" | "off" | "unset";

function flagState(value: string | undefined): FlagState {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (["true", "1", "on", "yes"].includes(normalized)) return "on";
    if (["false", "0", "off", "no"].includes(normalized)) return "off";
    return "unset";
}

/**
 * A seat is enabled when it is explicitly on, or when it is unset and
 * the master flag is on. An explicit seat "off" wins over the master —
 * each seat enables (and can be killed) independently.
 */
function seatEnabled(master: FlagState, seat: FlagState): boolean {
    if (seat === "off") return false;
    if (seat === "on") return true;
    return master === "on";
}

function boundedInteger(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    const parsed = Number(value);
    return Number.isInteger(parsed)
        ? Math.min(max, Math.max(min, parsed))
        : fallback;
}

function modelChain(env: Record<string, string | undefined>): string[] {
    const primary = env.MUNCH_DECIDER_MODEL?.trim() || DEFAULT_DECIDER_MODEL;
    const fallbackRaw =
        env.MUNCH_DECIDER_FALLBACK_MODELS === undefined
            ? DEFAULT_DECIDER_FALLBACK_MODELS
            : env.MUNCH_DECIDER_FALLBACK_MODELS;
    const chain = [primary];
    for (const slug of fallbackRaw.split(",")) {
        const trimmed = slug.trim();
        if (trimmed && !chain.includes(trimmed)) chain.push(trimmed);
    }
    return chain;
}

/**
 * Returns null when no OpenRouter key is configured (the seats cannot
 * run; callers treat this exactly like flags-off). Jev rides the same
 * OpenRouter key as the Ember seats.
 */
export function decisionsConfig(
    env: Record<string, string | undefined> = process.env,
): DecisionsConfig | null {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) return null;
    const master = flagState(env.MUNCH_JEV_ENABLED);
    return {
        apiKey,
        apiUrl: env.MUNCH_DECIDER_API_URL?.trim() || DECISIONS_API_URL,
        models: modelChain(env),
        gateTimeoutMs: boundedInteger(
            env.MUNCH_JEV_GATE_TIMEOUT_MS,
            1_500,
            100,
            10_000,
        ),
        deciderTimeoutMs: boundedInteger(
            env.MUNCH_JEV_DECIDER_TIMEOUT_MS,
            2_000,
            100,
            15_000,
        ),
        gateEnabled: seatEnabled(master, flagState(env.MUNCH_JEV_GATE_ENABLED)),
        deciderEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_DECIDER_ENABLED),
        ),
        shortfallCheckEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_SHORTFALL_CHECK_ENABLED),
        ),
        shortfallCheckTimeoutMs: boundedInteger(
            env.MUNCH_JEV_SHORTFALL_CHECK_TIMEOUT_MS,
            2_000,
            100,
            15_000,
        ),
        pantryMatchEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_PANTRY_MATCH_ENABLED),
        ),
        pantryMatchTimeoutMs: boundedInteger(
            env.MUNCH_JEV_PANTRY_MATCH_TIMEOUT_MS,
            2_000,
            100,
            15_000,
        ),
        drawdownReviewEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_DRAWDOWN_ENABLED),
        ),
        drawdownReviewTimeoutMs: boundedInteger(
            env.MUNCH_JEV_DRAWDOWN_TIMEOUT_MS,
            2_000,
            100,
            15_000,
        ),
    };
}

/**
 * Per-model gate thresholds (TypeSafe docs: "probabilities differ
 * between models on the same question, so pick thresholds again for
 * each model you try"). `gateFoodMin` is the minimum p(food) at or above
 * which a photo passes the S1 gate; below it the photo is confidently
 * not food. Every value below is calibrated from the labelled fixture
 * evidence of the Nov 11 probe + designation bake-off — never borrowed
 * across models without the separation numbers to support it.
 */
export interface DecisionModelThresholds {
    gateFoodMin: number;
    /** C2: minimum p(contradiction) at or above which a shortfall row
     * is recomputed and, if the contradiction persists, surfaced.
     * Calibrated per model from the C2 eval — never borrowed. */
    shortfallContradictionMin?: number;
    /** Seat B3: minimum p(same item) for a grey-band pair to merge. */
    pantrySameItemMin?: number;
    /** Seat B3: minimum p(units compatible) for a grey-band merge. */
    pantryUnitsCompatibleMin?: number;
    /** Seat B4: a reviewed draw is flagged when p(match correct)
     * falls below this for the serving model. */
    drawdownMatchMin?: number;
    /** Seat B4: flagged when p(quantity plausible) falls below this. */
    drawdownQuantityMin?: number;
}

export const DECISION_MODEL_THRESHOLDS: Record<
    string,
    DecisionModelThresholds
> = {
    // Probe (30 real meals + 12 negatives): positives min 0.71 / median
    // 0.98; headline negatives median 0.01 with two warm outliers that
    // still pass by design (a menu at 0.38, the receipt fixture at 0.60
    // — it routes to the receipt flow). 0 false rejects at 0.10.
    // C2 eval (2026-11-13, scripts/shortfall-contradiction-eval.ts;
    // 6 rundowns x 2 repeats, 42 rows/model): Jev planted
    // contradictions scored p >= 0.97, consistent rows p <= 0.07 —
    // 0.5 sits in the empty middle of the distribution.
    // B3/B4 thresholds are calibrated by scripts/jev-b3-b4-eval.ts
    // (2026-11-13, per model from its own score distribution — see the
    // eval report in the PR body); they are placeholders at the
    // neutral 0.5 until that run's numbers land in this table.
    "typesafe/jev-1.14": {
        gateFoodMin: 0.1,
        shortfallContradictionMin: 0.5,
        pantrySameItemMin: 0.5,
        pantryUnitsCompatibleMin: 0.5,
        drawdownMatchMin: 0.5,
        drawdownQuantityMin: 0.5,
    },
    // Bake-off: positives min 0.90 / median 0.99; negatives ALL ≤ 0.011
    // — the widest separation of the three, so 0.10 transfers with the
    // most headroom. 0/30 false rejects, 8/8 negatives rejected.
    // C2 eval (same run as the Jev entry above): pplx planted
    // contradictions scored p >= 0.99, consistent rows p <= 0.007 —
    // 0.5 is again the empty middle; thresholds were NOT borrowed
    // across models, the two distributions independently support it.
    "perplexity/pplx-decider-v1.2": {
        gateFoodMin: 0.1,
        shortfallContradictionMin: 0.5,
        pantrySameItemMin: 0.5,
        pantryUnitsCompatibleMin: 0.5,
        drawdownMatchMin: 0.5,
        drawdownQuantityMin: 0.5,
    },
    // Bake-off: positives min 0.84 / median 0.99; hottest negative 0.071
    // — 0.10 sits above it, but with the thinnest margin of the three;
    // watch the production logs before ever lowering this.
    "liquid/d1-ultra": { gateFoodMin: 0.1 },
};

/** The brief's standard gate threshold for any unlisted slug. */
export const DEFAULT_GATE_FOOD_MIN = 0.1;

export function gateFoodThresholdForModel(model: string): number {
    return (
        DECISION_MODEL_THRESHOLDS[model]?.gateFoodMin ?? DEFAULT_GATE_FOOD_MIN
    );
}

/** C2 standard contradiction threshold for any unlisted slug. The
 * listed models' values are calibrated from the C2 eval
 * (scripts/shortfall-contradiction-eval.ts); see the eval report in
 * the seat's PR for the per-model distributions they rest on. */
export const DEFAULT_SHORTFALL_CONTRADICTION_MIN = 0.5;

export function shortfallContradictionThresholdForModel(model: string): number {
    return (
        DECISION_MODEL_THRESHOLDS[model]?.shortfallContradictionMin ??
        DEFAULT_SHORTFALL_CONTRADICTION_MIN
    );
}

/** Whether the C2 seat is enabled on a resolved config. The field is
 * optional on the interface (additive seat); absence means off. */
export function shortfallCheckEnabled(config: DecisionsConfig): boolean {
    return config.shortfallCheckEnabled === true;
}

export function shortfallCheckTimeoutMs(config: DecisionsConfig): number {
    return config.shortfallCheckTimeoutMs ?? 2_000;
}

/** Neutral default for the B3/B4 thresholds on any unlisted slug. */
export const DEFAULT_PANTRY_REVIEW_MIN = 0.5;

export function pantrySameItemThresholdForModel(model: string): number {
    return (
        DECISION_MODEL_THRESHOLDS[model]?.pantrySameItemMin ??
        DEFAULT_PANTRY_REVIEW_MIN
    );
}

export function pantryUnitsCompatibleThresholdForModel(model: string): number {
    return (
        DECISION_MODEL_THRESHOLDS[model]?.pantryUnitsCompatibleMin ??
        DEFAULT_PANTRY_REVIEW_MIN
    );
}

export function drawdownMatchThresholdForModel(model: string): number {
    return (
        DECISION_MODEL_THRESHOLDS[model]?.drawdownMatchMin ??
        DEFAULT_PANTRY_REVIEW_MIN
    );
}

export function drawdownQuantityThresholdForModel(model: string): number {
    return (
        DECISION_MODEL_THRESHOLDS[model]?.drawdownQuantityMin ??
        DEFAULT_PANTRY_REVIEW_MIN
    );
}
