/**
 * The ONE Decisions-API client for the Jev seats (S1 gate, S2 decider).
 *
 * ONE client, model as config (fallback law): every call walks the
 * ordered chain from `DecisionsConfig.models` — primary first, then the
 * designated fallbacks. Each model gets at most ONE retry, on transient
 * failures only (transport error / timeout / HTTP 5xx / 429 / a 200
 * whose body is not a parseable decisions response); a hard HTTP 4xx
 * (e.g. 404 "No endpoints found" — the inception/mercury-decide shape
 * from the bake-off) moves to the next model immediately. When the whole
 * chain is exhausted the caller falls back to today's behaviour — the
 * client itself never invents a selection.
 *
 * Wire shape (productionized from the harness adapter on PR #235 and
 * the gate probe on scripts/photo-jev-probe.ts — same body, same
 * answer parsing): POST {model, state, questions} to
 * https://openrouter.ai/api/alpha/decisions; image-bearing requests
 * additionally send the `TypeSafe-Danger-Zone-Images: true` header
 * TypeSafe requires for image input.
 */
import { type DecisionsConfig } from "./config.js";

export interface DecisionsFetcher {
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DecisionsCallOptions {
    seat:
        | "gate"
        | "decider"
        | "match"
        | "draft_review"
        | "shortfall_check"
        | "pantry_match"
        | "drawdown_review"
        | "plausibility"
        | "estimate_rung"
        | "yield_estimate"
        | "chat_claims"
        | "outlier";
    state: unknown;
    questions: Record<string, unknown>;
    timeoutMs: number;
    /** True for image-bearing requests (S1 gate). */
    includeImageHeader: boolean;
    fetcher?: DecisionsFetcher;
}

export interface DecisionsCallResult {
    /** The model that actually answered. */
    model: string;
    /** The raw `answers` object exactly as returned. */
    answers: Record<string, unknown>;
    /** API-reported usage.cost (null when the response omits it). */
    reportedCostUsd: number | null;
    /** Total wall time across the whole chain, ms. */
    durationMs: number;
}

export interface DecisionsAttempt {
    model: string;
    /** "retry" | "fallback" | "terminal" — why this attempt ended. */
    outcome: "retry" | "fallback" | "terminal";
    reason: string;
}

export class DecisionsChainExhaustedError extends Error {
    readonly attempts: DecisionsAttempt[];
    constructor(attempts: DecisionsAttempt[]) {
        super(
            `Decisions API chain exhausted (${attempts.length} attempts): ${attempts
                .map((attempt) => `${attempt.model}: ${attempt.reason}`)
                .join("; ")}`,
        );
        this.name = "DecisionsChainExhaustedError";
        this.attempts = attempts;
    }
}

function safeLogValue(value: string): string {
    return value.replace(/[^a-zA-Z0-9._/-]+/g, "_").slice(0, 80) || "unknown";
}

/** Raw-answer excerpt kept in the success log so thresholds can be
 * re-tuned from the Railway logs without new requests (TypeSafe
 * cookbook pattern, brief "Docs best practices"). */
function answersExcerpt(answers: Record<string, unknown>): string {
    return JSON.stringify(answers).slice(0, 600);
}

type AttemptFailure = { retryable: boolean; reason: string };

async function attemptModel(
    config: DecisionsConfig,
    model: string,
    options: DecisionsCallOptions,
    fetcher: DecisionsFetcher,
): Promise<DecisionsCallResult | AttemptFailure> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
        const response = await fetcher(config.apiUrl, {
            method: "POST",
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${config.apiKey}`,
                "content-type": "application/json",
                ...(options.includeImageHeader
                    ? { "TypeSafe-Danger-Zone-Images": "true" }
                    : {}),
            },
            body: JSON.stringify({
                model,
                state: options.state,
                questions: options.questions,
            }),
        });
        const rawText = await response.text();
        let payload: any = null;
        try {
            payload = JSON.parse(rawText);
        } catch {
            payload = null;
        }
        if (!response.ok) {
            const detail =
                typeof payload?.error?.message === "string"
                    ? payload.error.message
                    : rawText.slice(0, 200);
            const retryable = response.status === 429 || response.status >= 500;
            return {
                retryable,
                reason: `HTTP ${response.status}: ${detail}`,
            };
        }
        const answers = payload?.answers;
        if (!answers || typeof answers !== "object") {
            return {
                retryable: true,
                reason: `HTTP 200 with no parseable answers object (${rawText.slice(0, 200)})`,
            };
        }
        const usage = payload?.usage ?? {};
        return {
            model,
            answers: answers as Record<string, unknown>,
            reportedCostUsd: typeof usage.cost === "number" ? usage.cost : null,
            durationMs: 0, // filled in by the chain caller
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { retryable: true, reason: `transport: ${reason}` };
    } finally {
        clearTimeout(timeout);
    }
}

export async function callDecisionsWithFallback(
    config: DecisionsConfig,
    options: DecisionsCallOptions,
): Promise<DecisionsCallResult> {
    const fetcher = options.fetcher ?? fetch;
    const startedAt = Date.now();
    const attempts: DecisionsAttempt[] = [];
    const models = config.models;
    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        const model = models[modelIndex]!;
        const isLastModel = modelIndex === models.length - 1;
        // At most one retry on the same model, transient failures only.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = await attemptModel(config, model, options, fetcher);
            if ("answers" in result) {
                const durationMs = Math.max(0, Date.now() - startedAt);
                console.info(
                    `[decisions] seat=${options.seat} status=success model=${safeLogValue(result.model)} duration_ms=${durationMs} cost_usd=${result.reportedCostUsd ?? "null"} raw=${answersExcerpt(result.answers)}`,
                );
                return { ...result, durationMs };
            }
            const isLastAttempt = attempt === 1;
            if (result.retryable && !isLastAttempt) {
                console.info(
                    `[decisions] seat=${options.seat} event=retry model=${safeLogValue(model)} reason=${result.reason.slice(0, 200)}`,
                );
                continue;
            }
            const outcome = isLastModel ? "terminal" : "fallback";
            attempts.push({ model, outcome, reason: result.reason });
            if (!isLastModel) {
                const nextModel = models[modelIndex + 1]!;
                console.info(
                    `[decisions] seat=${options.seat} event=fallback model=${safeLogValue(model)} next_model=${safeLogValue(nextModel)} reason=${result.reason.slice(0, 200)}`,
                );
            }
            break;
        }
    }
    const durationMs = Math.max(0, Date.now() - startedAt);
    console.info(
        `[decisions] seat=${options.seat} event=terminal_exhausted duration_ms=${durationMs} attempts=${attempts.length}`,
    );
    throw new DecisionsChainExhaustedError(attempts);
}
