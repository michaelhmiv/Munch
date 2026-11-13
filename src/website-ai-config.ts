export const DEFAULT_WEBSITE_AI_MODEL = "meta/muse-ember";

export function websiteAiModel(
    env: Record<string, string | undefined> = process.env,
): string {
    return env.MUNCH_AI_MODEL?.trim() || DEFAULT_WEBSITE_AI_MODEL;
}

/**
 * Reasoning parameter for an OpenRouter chat-completions request.
 *
 * Some models cannot disable reasoning: the OpenRouter catalog marks
 * them `reasoning.mandatory` (the whole meta/muse-* family, including
 * the default meta/muse-ember), and their endpoints reject
 * `reasoning: { enabled: false }` with HTTP 400 ("Reasoning is
 * mandatory for this endpoint and cannot be disabled"). For those
 * models, request the floor effort instead — "minimal" is in
 * muse-ember's supported efforts and keeps these extraction calls
 * behaving like reasoning-off: fast, cheap, JSON-focused. Every other
 * model keeps the explicit disable.
 */
export function openRouterReasoningParam(model: string): {
    reasoning: { enabled: false } | { effort: "minimal" };
} {
    if (model.startsWith("meta/muse-")) {
        return { reasoning: { effort: "minimal" } };
    }
    return { reasoning: { enabled: false } };
}

/**
 * Bounded single-line excerpt of a provider error body, for error
 * messages and logs. Provider rejections used to be undiagnosable
 * because call sites threw the body away; OpenRouter error bodies are
 * JSON like {"error":{"message":"...","code":400}} and never contain
 * the caller's credentials. Returns "" when there is nothing readable.
 */
export async function providerErrorDetail(response: Response): Promise<string> {
    try {
        const text = await response.text();
        const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 500);
        return excerpt ? `: ${excerpt}` : "";
    } catch {
        return "";
    }
}

export interface WebsiteGuidanceAiConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    maxTokens: number;
    appUrl?: string;
}

export function websiteGuidanceAiConfig(
    env: Record<string, string | undefined> = process.env,
): WebsiteGuidanceAiConfig | null {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    const enabled = env.MUNCH_GUIDANCE_AI_ENABLED?.trim().toLowerCase();
    if (!apiKey || enabled === "false" || enabled === "0") return null;
    let baseUrl =
        env.MUNCH_AI_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
            return null;
        parsed.pathname = parsed.pathname.replace(/\/+$/, "");
        parsed.search = "";
        parsed.hash = "";
        baseUrl = parsed.toString().replace(/\/+$/, "");
    } catch {
        return null;
    }
    const boundedInteger = (
        value: string | undefined,
        fallback: number,
        min: number,
        max: number,
    ) => {
        const parsed = Number(value);
        return Number.isInteger(parsed)
            ? Math.max(min, Math.min(max, parsed))
            : fallback;
    };
    const appUrl = env.MUNCH_APP_BASE_URL?.trim();
    return {
        apiKey,
        baseUrl,
        model: websiteAiModel(env),
        timeoutMs: boundedInteger(
            env.MUNCH_GUIDANCE_AI_TIMEOUT_MS,
            25_000,
            5_000,
            60_000,
        ),
        maxTokens: boundedInteger(
            env.MUNCH_GUIDANCE_AI_MAX_TOKENS,
            3_500,
            500,
            8_000,
        ),
        ...(appUrl && /^https:\/\//.test(appUrl) ? { appUrl } : {}),
    };
}
// ---------------------------------------------------------------------------
// Generative-seat fallback chains (model-integration brief, "Fallback
// law" — approved Nov 11): fallbacks are MODEL SWAPS, never new code
// paths. Every generative seat sits behind one client whose model is
// a config value; a provider failure changes the slug, not the logic.
// The chain walk below mirrors the Decisions-API client
// (src/decisions/client.ts): primary first, at most one retry per
// model on transient failures only (transport error / timeout /
// HTTP 5xx / 429 / a 200 whose body cannot be parsed into the seat's
// schema), a hard HTTP 4xx moves to the next model immediately, and
// every retry / fallback / exhaustion is logged — silent degradation
// is a defect (brief: "Every fallback engagement is logged").
// ---------------------------------------------------------------------------

/** One classified failure of a single model attempt. */
export interface AiAttemptFailure {
    retryable: boolean;
    reason: string;
}

/**
 * Outcome of one attempt against one model: a value, or a classified
 * provider failure. Non-provider outcomes (a parsed "no food"
 * answer, request validation) are thrown by the attempt, never
 * returned — they are answers, not outages, and must not engage the
 * chain.
 */
export type AiAttemptOutcome<T> =
    { ok: true; value: T } | { ok: false; failure: AiAttemptFailure };

export interface AiChainAttempt {
    model: string;
    outcome: "retry" | "fallback" | "terminal";
    reason: string;
}

/**
 * Thrown when every model in a seat's chain has failed. The message
 * leads with the last model's failure so existing error surfaces
 * keep reading like the single-model errors they replace.
 */
export class AiChainExhaustedError extends Error {
    readonly attempts: AiChainAttempt[];
    constructor(seat: string, attempts: AiChainAttempt[]) {
        const last = attempts[attempts.length - 1];
        super(
            `${last ? last.reason : "AI provider failure"} (AI fallback chain for seat ${seat} exhausted: ${attempts
                .map((attempt) => `${attempt.model}: ${attempt.reason}`)
                .join("; ")})`,
        );
        this.name = "AiChainExhaustedError";
        this.attempts = attempts;
    }
}

function safeAiLogValue(value: string): string {
    return value.replace(/[^a-zA-Z0-9._/-]+/g, "_").slice(0, 80) || "unknown";
}

/**
 * Build an ordered model chain: the primary first, then fallbacks.
 * `fallbackRaw === undefined` selects the designated default; an
 * explicit empty string disables fallbacks (chain of one). Swapping
 * a fallback in or out is an env change, never a code change — the
 * same rule the Decisions seats ship with.
 */
export function aiModelChain(
    primary: string,
    fallbackRaw: string | undefined,
    designatedFallbacks: string,
): string[] {
    const chain = [primary];
    const raw = fallbackRaw === undefined ? designatedFallbacks : fallbackRaw;
    for (const slug of raw.split(",")) {
        const trimmed = slug.trim();
        if (trimmed && !chain.includes(trimmed)) chain.push(trimmed);
    }
    return chain;
}

/**
 * Walk a seat's model chain. `attempt` performs ONE provider call
 * against the given model and classifies provider failures as
 * outcomes; it throws only for non-provider outcomes, which abort
 * the walk immediately. Returns the answering model alongside the
 * value so the seat can log which model served.
 */
export async function runAiModelChain<T>(input: {
    seat: string;
    models: string[];
    attempt: (model: string) => Promise<AiAttemptOutcome<T>>;
}): Promise<{ value: T; model: string }> {
    const startedAt = Date.now();
    const attempts: AiChainAttempt[] = [];
    const models = input.models;
    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        const model = models[modelIndex]!;
        const isLastModel = modelIndex === models.length - 1;
        // At most one retry on the same model, transient failures only.
        for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
            const outcome = await input.attempt(model);
            if (outcome.ok) {
                return { value: outcome.value, model };
            }
            const { failure } = outcome;
            if (failure.retryable && attemptNumber === 0) {
                console.info(
                    `[ai] seat=${input.seat} event=retry model=${safeAiLogValue(model)} reason=${failure.reason.slice(0, 200)}`,
                );
                continue;
            }
            attempts.push({
                model,
                outcome: isLastModel ? "terminal" : "fallback",
                reason: failure.reason,
            });
            if (!isLastModel) {
                console.info(
                    `[ai] seat=${input.seat} event=fallback model=${safeAiLogValue(model)} next_model=${safeAiLogValue(models[modelIndex + 1]!)} reason=${failure.reason.slice(0, 200)}`,
                );
            }
            break;
        }
    }
    console.info(
        `[ai] seat=${input.seat} event=terminal_exhausted duration_ms=${Math.max(0, Date.now() - startedAt)} attempts=${attempts.length}`,
    );
    throw new AiChainExhaustedError(input.seat, attempts);
}

/**
 * Classify a thrown provider-call error for the chain walk. The HTTP
 * status is read from the seats' existing "provider returned HTTP
 * <status>" error wording; transport failures (fetch rejection,
 * abort/timeout) are transient. Anything else is a model-level
 * failure that moves to the next model without a same-model retry.
 */
export function classifyAiProviderError(error: unknown): AiAttemptFailure {
    const reason = error instanceof Error ? error.message : String(error);
    const httpStatus = /HTTP (\d{3})/.exec(reason)?.[1];
    if (httpStatus) {
        const status = Number(httpStatus);
        return { retryable: status === 429 || status >= 500, reason };
    }
    if (/aborted|abort|fetch|timeout|timed out|network|socket/i.test(reason)) {
        return { retryable: true, reason };
    }
    return { retryable: false, reason };
}
