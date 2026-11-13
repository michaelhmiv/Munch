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
    matchTimeoutMs: number;
    gateEnabled: boolean;
    deciderEnabled: boolean;
    outlierTimeoutMs: number;
    outlierEnabled: boolean;
    /** Seat C3 — chat-agent unsourced-claim check (log-only). */
    chatClaimsEnabled: boolean;
    chatClaimsTimeoutMs: number;
    matchEnabled: boolean;
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
    draftReviewTimeoutMs: number;
    draftReviewEnabled: boolean;
    /** A1 plausibility (the shared checker, src/decisions/
     * plausibility.ts — live seat A1 and the stored-data sweep run
     * the same module behind this one flag). Required, matching the
     * sweep's shape, so both branches' configs are identical. */
    plausibilityTimeoutMs: number;
    plausibilityEnabled: boolean;
    /** A1 lane order (Michael's ruling, 2026-11-13 — the seat is
     * Perplexity-led; see `plausibilityModelOrder`). Optional so
     * existing config literals in sibling seats/tests stay valid;
     * `decisionsConfig()` always populates it, and the seat derives
     * it from `models` when a literal omits it. */
    plausibilityModels?: string[];
    /** A2 estimate rung (audit §2 Tier 1). Optional so existing
     * config literals in sibling seats/tests stay valid;
     * `decisionsConfig()` always populates both fields. The timeout
     * serves the A2 defensibility call. */
    resolutionReviewTimeoutMs?: number;
    estimateRungEnabled?: boolean;
    /** A2b yield estimate seat. Optional/additive like the other
     * seats; `decisionsConfig()` always populates both fields. */
    yieldEstimateEnabled?: boolean;
    yieldEstimateTimeoutMs?: number;
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
 * A1 plausibility lane (Michael's ruling, 2026-11-13, on the
 * three-model bake-off — ~/workspace/munch-prep/jev-bakeoff-2026-11-13.md):
 * the plausibility seat is Perplexity-led. Perplexity separated
 * perfectly on both fixture sets (every defect caught, ZERO false
 * accusations) while Jev false-accused sound data (honey, a
 * correctly resolved milk). Jev stays in the lane as the
 * AVAILABILITY fallback only: it answers when Perplexity cannot,
 * never instead of it. Every other seat keeps the shared chain
 * order (`models`) — this lane belongs to the plausibility seat
 * alone (the stored-data sweep runs the same checker module, so
 * it judges through the same lane).
 */
export const PLAUSIBILITY_LEAD_MODEL = "perplexity/pplx-decider-v1.2";

/**
 * The plausibility seat's lane: the configured chain re-ordered so
 * the designated lead answers first and the remaining models
 * follow in their configured order. A chain that does not contain
 * the lead (an operator removed it from the model list) is
 * returned unchanged — config still governs which models exist.
 */
export function plausibilityModelOrder(models: string[]): string[] {
    if (!models.includes(PLAUSIBILITY_LEAD_MODEL)) return [...models];
    return [
        PLAUSIBILITY_LEAD_MODEL,
        ...models.filter((model) => model !== PLAUSIBILITY_LEAD_MODEL),
    ];
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
    const models = modelChain(env);
    return {
        apiKey,
        apiUrl: env.MUNCH_DECIDER_API_URL?.trim() || DECISIONS_API_URL,
        models,
        plausibilityModels: plausibilityModelOrder(models),
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
        outlierTimeoutMs: boundedInteger(
            env.MUNCH_JEV_OUTLIER_TIMEOUT_MS,
            2_000,
            100,
            15_000,
        ),
        outlierEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_OUTLIER_ENABLED),
        ),
        chatClaimsEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_CHAT_CLAIMS_ENABLED),
        ),
        chatClaimsTimeoutMs: boundedInteger(
            env.MUNCH_JEV_CHAT_CLAIMS_TIMEOUT_MS,
            3_000,
            100,
            15_000,
        ),
        matchTimeoutMs: boundedInteger(
            env.MUNCH_JEV_MATCH_TIMEOUT_MS,
            2_000,
            100,
            15_000,
        ),
        matchEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_MATCH_ENABLED),
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
        draftReviewTimeoutMs: boundedInteger(
            env.MUNCH_JEV_DRAFT_REVIEW_TIMEOUT_MS,
            2_000,
            100,
            15_000,
        ),
        draftReviewEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_DRAFT_REVIEW_ENABLED),
        ),
        plausibilityTimeoutMs: boundedInteger(
            env.MUNCH_JEV_PLAUSIBILITY_TIMEOUT_MS,
            5_000,
            100,
            30_000,
        ),
        plausibilityEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_PLAUSIBILITY_ENABLED),
        ),
        resolutionReviewTimeoutMs: boundedInteger(
            env.MUNCH_JEV_RESOLUTION_TIMEOUT_MS,
            3_000,
            100,
            15_000,
        ),
        estimateRungEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_ESTIMATE_RUNG_ENABLED),
        ),
        yieldEstimateEnabled: seatEnabled(
            master,
            flagState(env.MUNCH_JEV_YIELD_ESTIMATE_ENABLED),
        ),
        yieldEstimateTimeoutMs: boundedInteger(
            env.MUNCH_JEV_YIELD_ESTIMATE_TIMEOUT_MS,
            3_000,
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
    /**
     * Seat C3: minimum p(supported) at or above which a numeric claim
     * in a chat reply counts as sourced. Calibrated per model from
     * the C3 eval's own score distributions (see
     * scripts/chat-claims-eval.ts) — never borrowed across models.
     */
    chatClaimsSupportedMin: number;
    /** A2: an unresolved ingredient (or an A1-flagged one) may be
     * filled by the labelled estimate rung when the model's
     * p(estimate defensible) is at or above this value. Calibrated
     * per model from the A2 eval — never borrowed. */
    estimateDefensibleMin?: number;
    /** A2b: an estimated yield is stored only when the model's
     * p(yield estimate defensible) is at or above this value.
     * Calibrated per model from the A2b eval — never borrowed. */
    yieldDefensibleMin?: number;
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
    // eval report in the PR body); the calibrated values
    // from that run's distributions are recorded per model below.
    // B3/B4 thresholds calibrated by scripts/jev-b3-b4-eval.ts
    // (2026-11-13), per model from its own score distribution:
    // Jev B3 same-item p: true-same >= 0.77, true-different <= 0.30;
    // units: compatible >= 0.92, incompatible <= 0.32. B4 quantity p:
    // genuine anomalies <= 0.53, benign draws >= 0.93 (the 20-cup-milk
    // fixture scored 0.83 -- both models judge it plausible; it is
    // the eval's named miss, not a threshold failure).
    // C3 eval (2026-11-13, scripts/chat-claims-eval.ts; 22 fixtures,
    // 46 scored claims/model): Jev p(supported) — planted-unsourced
    // max 0.26, sourced min 0.78 → 0.5 sits mid-band. Perplexity —
    // planted-unsourced max 0.19, sourced min 0.58 (the mg→g
    // conversion) → 0.4, weighted toward the false-accusation side,
    // the seat's headline metric. Both models: catch 8/8, false
    // accusations 0/38 at these thresholds.
    "typesafe/jev-1.14": {
        gateFoodMin: 0.1,
        estimateDefensibleMin: 0.5,
        // A2b eval (2026-11-13, scripts/yield-estimate-eval.ts):
        // defensible cases p >= 0.62, the no-method control p = 0.02
        // — 0.5 sits between, from this model's own distribution.
        yieldDefensibleMin: 0.5,
        shortfallContradictionMin: 0.5,
        pantrySameItemMin: 0.55,
        pantryUnitsCompatibleMin: 0.6,
        drawdownMatchMin: 0.5,
        drawdownQuantityMin: 0.7,
        chatClaimsSupportedMin: 0.5,
    },
    // Bake-off: positives min 0.90 / median 0.99; negatives ALL ≤ 0.011
    // — the widest separation of the three, so 0.10 transfers with the
    // most headroom. 0/30 false rejects, 8/8 negatives rejected.
    // C2 eval (same run as the Jev entry above): pplx planted
    // contradictions scored p >= 0.99, consistent rows p <= 0.007 —
    // 0.5 is again the empty middle; thresholds were NOT borrowed
    // across models, the two distributions independently support it.
    // B3/B4 eval (2026-11-13): same-item p true-same >= 0.52,
    // true-different <= 0.24 (a narrower band than Jev's, hence the
    // lower threshold -- never borrowed across models); units:
    // incompatible <= 0.05, compatible >= 0.99. B4 quantity p:
    // genuine <= 0.39, benign >= 0.99 (20-cup milk 0.97: named miss).
    "perplexity/pplx-decider-v1.2": {
        gateFoodMin: 0.1,
        estimateDefensibleMin: 0.5,
        // A2b eval (same run as the Jev entry above): defensible
        // cases p >= 0.99, the no-method control p = 0.026 — 0.5
        // independently supported by this model's distribution.
        yieldDefensibleMin: 0.5,
        shortfallContradictionMin: 0.5,
        pantrySameItemMin: 0.4,
        pantryUnitsCompatibleMin: 0.5,
        drawdownMatchMin: 0.5,
        drawdownQuantityMin: 0.7,
        chatClaimsSupportedMin: 0.4,
    },
    // Bake-off: positives min 0.84 / median 0.99; hottest negative 0.071
    // — 0.10 sits above it, but with the thinnest margin of the three;
    // watch the production logs before ever lowering this.
    "liquid/d1-ultra": { gateFoodMin: 0.1, chatClaimsSupportedMin: 0.5 },
};

/** The brief's standard gate threshold for any unlisted slug. */
export const DEFAULT_GATE_FOOD_MIN = 0.1;

export function gateFoodThresholdForModel(model: string): number {
    return (
        DECISION_MODEL_THRESHOLDS[model]?.gateFoodMin ?? DEFAULT_GATE_FOOD_MIN
    );
}

/**
 * Per-model C1 outlier thresholds: `outlierMistakeMin` is the minimum
 * p(likely logging mistake) at or above which the soft prompt is
 * surfaced. Calibrated per model from the C1 eval fixture (see
 * scripts/jev-c1-outlier-eval.ts and the PR evidence), never borrowed
 * across models. Provisional values are set from that eval before
 * the seat ships; the eval report is the authority for any change.
 */
export interface OutlierModelThresholds {
    outlierMistakeMin: number;
}

export const OUTLIER_MODEL_THRESHOLDS: Record<string, OutlierModelThresholds> =
    {
        // C1 eval 2026-11-13 (scripts/jev-c1-outlier-eval.ts, 16
        // constructed production-shaped cases): at 0.50 Jev caught
        // 8/8 slips but false-prompted 4/8 genuine entries — its
        // genuine water cases scored 0.55–0.73 while its weakest
        // slip scored 0.75. 0.74 sits in that (thin) gap: 7/8 slips,
        // 0/8 false prompts on the fixture. The gap is only ~0.02
        // wide, so this threshold is provisional on a small fixture;
        // watch production logs before ever lowering it.
        "typesafe/jev-1.14": { outlierMistakeMin: 0.74 },
        // Same eval: at 0.50 pplx caught 7/8 slips with 2/8 false
        // prompts (genuine water at 0.55 and 0.88). At 0.90: 6/8
        // slips (exactly the 75% bar) and 0/8 false prompts — the
        // false-prompt rate is the headline metric, so it wins.
        "perplexity/pplx-decider-v1.2": { outlierMistakeMin: 0.9 },
    };

/** Unlisted slugs get the conservative end: fewer prompts, not more. */
export const DEFAULT_OUTLIER_MISTAKE_MIN = 0.9;

export function outlierMistakeThresholdForModel(model: string): number {
    return (
        OUTLIER_MODEL_THRESHOLDS[model]?.outlierMistakeMin ??
        DEFAULT_OUTLIER_MISTAKE_MIN
    );
}

/** Standard C3 supported-claim threshold for any unlisted slug. */
export const DEFAULT_CHAT_CLAIMS_SUPPORTED_MIN = 0.5;

export function chatClaimsThresholdForModel(model: string): number {
    return (
        DECISION_MODEL_THRESHOLDS[model]?.chatClaimsSupportedMin ??
        DEFAULT_CHAT_CLAIMS_SUPPORTED_MIN
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

/**
 * Per-model A3 draft-review thresholds: `draftPlausibleMin` is the
 * minimum p(plausible) at or above which a grounded item's numbers
 * stand; below it the item is flagged. Calibrated per model from the
 * A3 eval fixture (scripts/jev-a3-draft-review-eval.ts), never
 * borrowed across models. Provisional values below are set from that
 * eval before the seat ships; the eval report is the authority for
 * any change.
 */
export interface DraftReviewModelThresholds {
    draftPlausibleMin: number;
}

export const DRAFT_REVIEW_MODEL_THRESHOLDS: Record<
    string,
    DraftReviewModelThresholds
> = {
    // A3 eval 2026-11-13 (scripts/jev-a3-draft-review-eval.ts, 17
    // constructed production-shaped draft items + 2 bulk sets): Jev
    // insane items scored p(plausible) <= 0.42, correct items >= 0.89
    // — 0.50 sits inside that gap: 7/7 caught, 0/10 false-flagged.
    "typesafe/jev-1.14": { draftPlausibleMin: 0.5 },
    // Same eval: pplx insane <= 0.23, correct >= 0.87 — 0.50 sits
    // inside ITS gap too (independently measured, not borrowed):
    // 7/7 caught, 0/10 false-flagged; bulk 2/2 with 0 false flags.
    "perplexity/pplx-decider-v1.2": { draftPlausibleMin: 0.5 },
};

/** Standard A3 threshold for any unlisted slug. */
export const DEFAULT_DRAFT_PLAUSIBLE_MIN = 0.5;

export function draftReviewPlausibleThresholdForModel(model: string): number {
    return (
        DRAFT_REVIEW_MODEL_THRESHOLDS[model]?.draftPlausibleMin ??
        DEFAULT_DRAFT_PLAUSIBLE_MIN
    );
}

/**
 * Per-model A1 plausibility thresholds: `implausibleMin` is the minimum
 * p(implausible) at or above which a stored/live resolution is confirmed
 * corrupt by the shared checker (`src/decisions/plausibility.ts`, used
 * by seat A1 and by the stored-data sweep). Calibrated per model from
 * the sweep eval fixture (scripts/jev-sweep-eval.ts) — never borrowed
 * across models. Values are set from that eval's measured separation;
 * see the eval report in the sweep PR.
 */
export interface PlausibilityModelThresholds {
    implausibleMin: number;
}

export const PLAUSIBILITY_MODEL_THRESHOLDS: Record<
    string,
    PlausibilityModelThresholds
> = {
    // Sweep eval 2026-11-13 (scripts/jev-sweep-eval.ts; stored-shape
    // specimens, production call shape, 2 repeats): defects scored
    // 0.89–0.97, legitimately-unusual controls 0.15–0.43 — 0.50 sits
    // in the wide empty middle of Jev's own distribution.
    "typesafe/jev-1.14": { implausibleMin: 0.5 },
    // Same eval, scored separately: defects 0.74–1.00, controls
    // 0.08–0.33 — 0.50 is again the middle of pplx's own gap, not a
    // value borrowed from Jev.
    "perplexity/pplx-decider-v1.2": { implausibleMin: 0.5 },
};

/** Unlisted slugs get the conservative end: fewer accusations, not more. */
export const DEFAULT_PLAUSIBILITY_IMPLAUSIBLE_MIN = 0.9;

export function plausibilityThresholdForModel(model: string): number {
    return (
        PLAUSIBILITY_MODEL_THRESHOLDS[model]?.implausibleMin ??
        DEFAULT_PLAUSIBILITY_IMPLAUSIBLE_MIN
    );
}

/** A2 standard defensibility floor for any unlisted slug; listed
 * models carry their own calibrated values (same eval as A1). */
export const DEFAULT_ESTIMATE_DEFENSIBLE_MIN = 0.5;

export function estimateDefensibleThresholdForModel(model: string): number {
    return (
        DECISION_MODEL_THRESHOLDS[model]?.estimateDefensibleMin ??
        DEFAULT_ESTIMATE_DEFENSIBLE_MIN
    );
}

/** Whether the A2 estimate-rung seat is enabled on a resolved
 * config. Absence means off. */
export function estimateRungEnabled(config: DecisionsConfig): boolean {
    return config.estimateRungEnabled === true;
}

export function resolutionReviewTimeoutMs(config: DecisionsConfig): number {
    return config.resolutionReviewTimeoutMs ?? 3_000;
}

/** A2b standard defensibility floor for any unlisted slug; listed
 * models carry values calibrated from the A2b eval
 * (scripts/yield-estimate-eval.ts). */
export const DEFAULT_YIELD_DEFENSIBLE_MIN = 0.5;

export function yieldDefensibleThresholdForModel(model: string): number {
    return (
        DECISION_MODEL_THRESHOLDS[model]?.yieldDefensibleMin ??
        DEFAULT_YIELD_DEFENSIBLE_MIN
    );
}

/** Whether the A2b yield seat is enabled on a resolved config.
 * Absence means off. */
export function yieldEstimateEnabled(config: DecisionsConfig): boolean {
    return config.yieldEstimateEnabled === true;
}

export function yieldEstimateTimeoutMs(config: DecisionsConfig): number {
    return config.yieldEstimateTimeoutMs ?? 3_000;
}
