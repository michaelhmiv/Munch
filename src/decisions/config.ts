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

/** Designated by the Nov 11 fallback bake-off (PR #247;
 * ~/workspace/munch-evidence/fallback-bakeoff/report.md). */
export const DEFAULT_DECIDER_FALLBACK_MODELS =
    "perplexity/pplx-decider-v1.2,liquid/d1-ultra";

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
}

export const DECISION_MODEL_THRESHOLDS: Record<
    string,
    DecisionModelThresholds
> = {
    // Probe (30 real meals + 12 negatives): positives min 0.71 / median
    // 0.98; headline negatives median 0.01 with two warm outliers that
    // still pass by design (a menu at 0.38, the receipt fixture at 0.60
    // — it routes to the receipt flow). 0 false rejects at 0.10.
    "typesafe/jev-1.14": { gateFoodMin: 0.1 },
    // Bake-off: positives min 0.90 / median 0.99; negatives ALL ≤ 0.011
    // — the widest separation of the three, so 0.10 transfers with the
    // most headroom. 0/30 false rejects, 8/8 negatives rejected.
    "perplexity/pplx-decider-v1.2": { gateFoodMin: 0.1 },
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
