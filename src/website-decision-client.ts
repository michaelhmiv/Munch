import { z } from "zod";

export const DEFAULT_DECISION_MODEL = "~typesafe/jev-latest";
export const DEFAULT_DECISION_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_DECISION_TIMEOUT_MS = 10_000;
export const DEFAULT_RECIPE_DECISION_MIN_CONFIDENCE = 0.75;

const answerSchema = z
    .object({
        type: z.literal("choice"),
        choice: z.string().min(1),
        probabilities: z.record(z.number().min(0).max(1)).optional(),
        confidence: z.number().min(0).max(1),
    })
    .passthrough();

const responseSchema = z
    .object({
        model: z.string().optional(),
        answers: z.record(answerSchema),
        usage: z
            .object({
                input_tokens: z.number().nonnegative().optional(),
                output_tokens: z.number().nonnegative().optional(),
                cost: z.number().nonnegative().optional(),
            })
            .passthrough()
            .optional(),
    })
    .passthrough();

export interface WebsiteDecisionConfig {
    apiKey: string;
    model: string;
    endpoint: string;
    timeoutMs: number;
    minConfidence: number;
    appUrl?: string;
}

export interface WebsiteChoiceDecisionRequest {
    key: string;
    instructions: string;
    criteria: Record<string, string>;
}

export interface WebsiteChoiceDecisionResult {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
}

export interface WebsiteDecisionBatchResult {
    results: Map<string, WebsiteChoiceDecisionResult>;
    requestedModel: string;
    resolvedModel: string;
    durationMs: number;
    retries: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
}

export interface OpenRouterDecisionClientDependencies {
    fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    sleep?: (ms: number) => Promise<void>;
}

function boundedInteger(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function boundedNumber(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function enabledFlag(value: string | undefined, fallback: boolean): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return fallback;
    if (["false", "0", "off", "no"].includes(normalized)) return false;
    if (["true", "1", "on", "yes"].includes(normalized)) return true;
    return fallback;
}

function optionalUrl(value: string | undefined): string | undefined {
    if (!value?.trim()) return undefined;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "https:" && url.hostname !== "localhost") {
            return undefined;
        }
        return url.toString().replace(/\/$/, "");
    } catch {
        return undefined;
    }
}

export function websiteDecisionConfig(
    env: Record<string, string | undefined> = process.env,
): WebsiteDecisionConfig | null {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (
        !apiKey ||
        !enabledFlag(env.MUNCH_RECIPE_DECISION_ENABLED, false)
    ) {
        return null;
    }

    return {
        apiKey,
        model: env.MUNCH_DECISION_MODEL?.trim() || DEFAULT_DECISION_MODEL,
        endpoint: DEFAULT_DECISION_ENDPOINT,
        timeoutMs: boundedInteger(
            env.MUNCH_DECISION_TIMEOUT_MS,
            DEFAULT_DECISION_TIMEOUT_MS,
            1_000,
            60_000,
        ),
        minConfidence: boundedNumber(
            env.MUNCH_RECIPE_DECISION_MIN_CONFIDENCE,
            DEFAULT_RECIPE_DECISION_MIN_CONFIDENCE,
            0,
            1,
        ),
        appUrl: optionalUrl(env.MUNCH_APP_BASE_URL),
    };
}

function safeLogValue(value: string | number): string {
    return String(value)
        .replace(/[^a-zA-Z0-9._:~/-]/g, "_")
        .slice(0, 160);
}

function retryableStatus(status: number): boolean {
    return status === 429 || status === 529 || status >= 500;
}

export class OpenRouterDecisionClient {
    private readonly fetcher: (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => Promise<Response>;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(
        readonly config: WebsiteDecisionConfig,
        dependencies: OpenRouterDecisionClientDependencies = {},
    ) {
        this.fetcher = dependencies.fetcher ?? fetch;
        this.sleep =
            dependencies.sleep ??
            ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    async decideChoices(
        state: Record<string, unknown>,
        requests: WebsiteChoiceDecisionRequest[],
    ): Promise<WebsiteDecisionBatchResult> {
        if (requests.length === 0) {
            return {
                results: new Map(),
                requestedModel: this.config.model,
                resolvedModel: this.config.model,
                durationMs: 0,
                retries: 0,
            };
        }

        const questionKeyToRequest = new Map<string, WebsiteChoiceDecisionRequest>();
        const questions: Record<string, unknown> = {};
        requests.forEach((request, index) => {
            const questionKey = `q${index}`;
            questionKeyToRequest.set(questionKey, request);
            questions[questionKey] = {
                type: "choice",
                instructions: request.instructions,
                criteria: request.criteria,
            };
        });

        const startedAt = performance.now();
        let retries = 0;
        let response: Response | undefined;
        let lastError: unknown;

        for (let attempt = 0; attempt < 3; attempt++) {
            const signal = AbortSignal.timeout(this.config.timeoutMs);
            try {
                response = await this.fetcher(this.config.endpoint, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${this.config.apiKey}`,
                        "Content-Type": "application/json",
                        ...(this.config.appUrl
                            ? { "HTTP-Referer": this.config.appUrl }
                            : {}),
                        "X-OpenRouter-Title": "Munch",
                    },
                    body: JSON.stringify({
                        model: this.config.model,
                        state,
                        questions,
                    }),
                    signal,
                });
            } catch (error) {
                lastError = error;
                if (attempt === 2) throw error;
                retries += 1;
                await this.sleep(250 * 2 ** attempt);
                continue;
            }

            if (response.ok || !retryableStatus(response.status) || attempt === 2) {
                break;
            }
            await response.arrayBuffer().catch(() => new ArrayBuffer(0));
            retries += 1;
            await this.sleep(250 * 2 ** attempt);
        }

        if (!response) {
            throw lastError instanceof Error
                ? lastError
                : new Error("OpenRouter decision request failed.");
        }
        if (!response.ok) {
            throw new Error(
                `OpenRouter decision request returned HTTP ${response.status}.`,
            );
        }

        const payload = responseSchema.parse(await response.json());
        const results = new Map<string, WebsiteChoiceDecisionResult>();
        for (const [questionKey, request] of questionKeyToRequest) {
            const answer = payload.answers[questionKey];
            if (!answer) {
                throw new Error("OpenRouter decision response was incomplete.");
            }
            if (!(answer.choice in request.criteria)) {
                throw new Error(
                    "OpenRouter decision response selected an unknown criterion.",
                );
            }
            results.set(request.key, {
                choice: answer.choice,
                confidence: answer.confidence,
                probabilities: answer.probabilities ?? {},
            });
        }

        const durationMs = performance.now() - startedAt;
        const resolvedModel = payload.model ?? this.config.model;
        console.info(
            `[website_decision] status=success requested_model=${safeLogValue(this.config.model)} resolved_model=${safeLogValue(resolvedModel)} questions=${requests.length} retries=${retries} duration_ms=${Math.round(durationMs)}`,
        );

        return {
            results,
            requestedModel: this.config.model,
            resolvedModel,
            durationMs,
            retries,
            ...(payload.usage?.input_tokens === undefined
                ? {}
                : { inputTokens: payload.usage.input_tokens }),
            ...(payload.usage?.output_tokens === undefined
                ? {}
                : { outputTokens: payload.usage.output_tokens }),
            ...(payload.usage?.cost === undefined
                ? {}
                : { costUsd: payload.usage.cost }),
        };
    }
}
