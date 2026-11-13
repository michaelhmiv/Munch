/**
 * C3 — the chat-agent unsourced-claim check (Jev accountability audit
 * 2026-11-13, §2 seat C3). Premium surface only: the chat agent is a
 * Premium leg, and this seat runs only on replies the service has
 * already produced for an entitled user.
 *
 * Chat v2 already enforces grounding IN CODE for structured writes
 * (src/chat/tools.ts: the executor rejects meal items carrying
 * nutrition without a provider reference harvested from a tool
 * result; the model never originates values). The residual hole is
 * PROSE: a number in the reply text that appears in no tool result.
 * This seat compares the final reply's numeric claims against the
 * values the model was allowed to quote for that message — the tool
 * results it received, plus the static context and entry seed it was
 * shown (its own grounding rule in src/chat/agent.ts is "quote a
 * number only when it appears in the context object or in a tool
 * result", so both are sourced values here). Pure text state: no
 * user identity, no account id, nothing beyond the reply and the
 * values already sent to the chat model for this message.
 *
 * SCOPE DISCIPLINE — LOG-ONLY, FAIL-OPEN (the C3 brief's absolute
 * scope): this seat observes and logs (claim, verdict, probability,
 * model, cost_usd). It NEVER blocks, hedges, rewrites, or delays a
 * user-visible reply. It runs off the reply path via
 * `scheduleChatClaimCheck` (fire-and-forget after the turn is
 * persisted), and `checkChatClaims` never throws: a down chain, an
 * unparseable answer, or any other failure resolves to "unchecked"
 * and the reply the user already received is untouched. Escalation
 * to a hedge/rewrite pass is a later decision driven by the measured
 * unsourced-claim rate this seat's logs produce.
 *
 * The seat rides the existing Decisions client
 * (`callDecisionsWithFallback`), so the Jev → Perplexity fallback
 * chain and the client's per-call `cost_usd` logging are inherited —
 * no new chain code, model as config (fallback law).
 */
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    chatClaimsThresholdForModel,
    decisionsConfig,
    type DecisionsConfig,
} from "./config.js";
import { noulProbability } from "./gate.js";

/** TypeSafe's per-request question limit (same cap as S2). */
export const MAX_CLAIMS_PER_CALL = 8;

/** Total sourced-text budget carried in the Decisions state. */
const MAX_SOURCED_CHARS = 12_000;
const SNIPPET_RADIUS = 48;

export interface NumericClaim {
    /** Question key within the Decisions call ("c0", "c1", …). */
    key: string;
    /** The numeric token exactly as written in the reply. */
    raw: string;
    /** Short reply excerpt around the token, whitespace-normalized. */
    snippet: string;
    /** How many times this exact token appears in the reply. */
    occurrences: number;
}

/**
 * Thousands-grouped numbers first ("61,200"), then plain numbers.
 * A comma is consumed only as part of a digit group — never a
 * sentence comma ("Oct 7, I see…" extracts "7", not "7,").
 */
const NUMBER_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|\d+(?:\.\d+)?%?/g;

/**
 * Deterministic claim extraction (code's job): every distinct
 * numeric token in the reply, with a short excerpt for the judge.
 * Whether a token is a *sourced claim* is the model's judgment —
 * the question wording below tells it that dates, times, and
 * enumerations are not claims and count as supported.
 */
export function extractNumericClaims(reply: string): NumericClaim[] {
    const byRaw = new Map<string, NumericClaim>();
    for (const match of reply.matchAll(NUMBER_PATTERN)) {
        const raw = match[0];
        const index = match.index ?? 0;
        const existing = byRaw.get(raw);
        if (existing) {
            existing.occurrences += 1;
            continue;
        }
        const snippet = reply
            .slice(
                Math.max(0, index - SNIPPET_RADIUS),
                index + raw.length + SNIPPET_RADIUS,
            )
            .replace(/\s+/g, " ")
            .trim();
        byRaw.set(raw, {
            key: `c${byRaw.size}`,
            raw,
            snippet,
            occurrences: 1,
        });
    }
    return [...byRaw.values()];
}

export interface ChatClaimCheckInput {
    reply: string;
    /** The values the model was allowed to quote for this message. */
    sourcedTexts: string[];
}

export function buildChatClaimsState(
    input: ChatClaimCheckInput,
    claims: NumericClaim[],
): unknown {
    const sourced = input.sourcedTexts.join("\n").slice(0, MAX_SOURCED_CHARS);
    return {
        task: "Check whether each numeric claim in a chat assistant's reply is supported by the sourced values the assistant was given for this message.",
        reply: input.reply,
        sourced_values: sourced,
        claims: claims.map((claim) => ({
            question: claim.key,
            claim: claim.raw,
            excerpt: claim.snippet,
        })),
    };
}

export function buildChatClaimsQuestions(
    claims: NumericClaim[],
): Record<string, unknown> {
    const questions: Record<string, unknown> = {};
    for (const claim of claims) {
        questions[claim.key] = {
            type: "noul",
            instructions:
                `In a nutrition app, a chat assistant wrote a reply. The sourced values in the state are the only numbers the assistant was allowed to use for this message. ` +
                `Is the numeric claim "${claim.raw}" in this excerpt of the reply — "…${claim.snippet}…" — supported by the sourced values? ` +
                `Supported means: the value appears in the sourced values, or it is straightforwardly derived from them by rounding, adding sourced values together, dividing a sourced total by a serving or day count stated in the reply or the sourced values, converting units (for example grams to milligrams, ounces to grams, or a per-100g value scaled to a stated portion), or expressing one sourced value as a percentage of another sourced value. ` +
                `A number that is not a factual nutrition or quantity claim at all — a date, a time, a count of options, steps, or items being listed, or a number the user themselves wrote — also counts as supported. ` +
                `Anything else — a nutrition or quantity figure that neither appears in nor follows from the sourced values — is unsupported.`,
        };
    }
    return questions;
}

export interface ChatClaimVerdict {
    claim: string;
    snippet: string;
    verdict: "sourced" | "unsourced" | "unchecked";
    probability: number | null;
}

export type ChatClaimCheckOutcome =
    | { status: "skipped"; reason: string }
    | {
          status: "unchecked";
          reason: string;
          claims: ChatClaimVerdict[];
      }
    | {
          status: "checked";
          model: string;
          reportedCostUsd: number | null;
          durationMs: number;
          claims: ChatClaimVerdict[];
          /** Distinct claims beyond the per-call cap, not judged. */
          truncatedClaims: number;
      };

function safeLogValue(value: string): string {
    return value.replace(/[^a-zA-Z0-9._/-]+/g, "_").slice(0, 80) || "unknown";
}

/**
 * Run the check for one chat reply. NEVER throws (fail-open): every
 * failure mode resolves to "unchecked"/"skipped" and is logged. The
 * return value is for tests and the eval harness — production
 * callers ignore it; the seat's product is its log lines.
 */
export async function checkChatClaims(
    input: ChatClaimCheckInput,
    config: DecisionsConfig,
    dependencies: { fetcher?: DecisionsFetcher } = {},
): Promise<ChatClaimCheckOutcome> {
    const allClaims = extractNumericClaims(input.reply);
    if (allClaims.length === 0) {
        console.info(
            `[decisions] seat=chat_claims status=skipped reason=no_numeric_claims`,
        );
        return { status: "skipped", reason: "no_numeric_claims" };
    }
    const claims = allClaims.slice(0, MAX_CLAIMS_PER_CALL);
    const truncatedClaims = allClaims.length - claims.length;
    try {
        const result = await callDecisionsWithFallback(config, {
            seat: "chat_claims",
            timeoutMs: config.chatClaimsTimeoutMs,
            includeImageHeader: false,
            fetcher: dependencies.fetcher,
            state: buildChatClaimsState(input, claims),
            questions: buildChatClaimsQuestions(claims),
        });
        const threshold = chatClaimsThresholdForModel(result.model);
        const verdicts: ChatClaimVerdict[] = claims.map((claim) => {
            const probability = noulProbability(result.answers[claim.key]);
            if (probability === null) {
                return {
                    claim: claim.raw,
                    snippet: claim.snippet,
                    verdict: "unchecked" as const,
                    probability: null,
                };
            }
            return {
                claim: claim.raw,
                snippet: claim.snippet,
                verdict: (probability >= threshold
                    ? "sourced"
                    : "unsourced") as "sourced" | "unsourced",
                probability,
            };
        });
        for (const verdict of verdicts) {
            console.info(
                `[decisions] seat=chat_claims claim=${safeLogValue(verdict.claim)} verdict=${verdict.verdict} probability=${verdict.probability ?? "null"} model=${safeLogValue(result.model)} cost_usd=${result.reportedCostUsd ?? "null"}`,
            );
        }
        const unsourced = verdicts.filter(
            (verdict) => verdict.verdict === "unsourced",
        ).length;
        console.info(
            `[decisions] seat=chat_claims status=checked claims=${verdicts.length} unsourced=${unsourced} truncated=${truncatedClaims} model=${safeLogValue(result.model)} cost_usd=${result.reportedCostUsd ?? "null"} duration_ms=${result.durationMs}`,
        );
        return {
            status: "checked",
            model: result.model,
            reportedCostUsd: result.reportedCostUsd,
            durationMs: result.durationMs,
            claims: verdicts,
            truncatedClaims,
        };
    } catch {
        console.info(
            `[decisions] seat=chat_claims status=fail_open reason=decisions_unavailable claims=${claims.length}`,
        );
        return {
            status: "unchecked",
            reason: "decisions_unavailable",
            claims: claims.map((claim) => ({
                claim: claim.raw,
                snippet: claim.snippet,
                verdict: "unchecked" as const,
                probability: null,
            })),
        };
    }
}

export interface ScheduleChatClaimCheckInput {
    reply: string;
    toolResultTexts: string[];
    /** Serialized static context + entry seed the model was shown. */
    contextTexts: string[];
}

export interface ScheduleChatClaimCheckDependencies {
    /** Test/drill seam: supply a config instead of reading the env. */
    config?: DecisionsConfig | null;
    fetcher?: DecisionsFetcher;
    /** Scheduling seam: defaults to fire-and-forget. Tests inject a
     * capturing scheduler to await the task deterministically. */
    schedule?: (task: () => Promise<void>) => void;
    /** Test seam: replace the check itself. */
    runCheck?: typeof checkChatClaims;
}

/**
 * The wired entry point the chat service calls AFTER a reply has
 * been produced and persisted. Returns immediately: the check runs
 * on the scheduled task, never on the reply path, so it cannot add
 * latency to (or alter) the user-visible reply. Flag off (or no
 * OpenRouter key) means zero Decisions calls — the function returns
 * before anything is scheduled.
 */
export function scheduleChatClaimCheck(
    input: ScheduleChatClaimCheckInput,
    dependencies: ScheduleChatClaimCheckDependencies = {},
): void {
    const config =
        dependencies.config !== undefined
            ? dependencies.config
            : decisionsConfig();
    if (!config || !config.chatClaimsEnabled) return;
    const schedule =
        dependencies.schedule ??
        ((task: () => Promise<void>) => {
            void task().catch(() => undefined);
        });
    const runCheck = dependencies.runCheck ?? checkChatClaims;
    schedule(async () => {
        await runCheck(
            {
                reply: input.reply,
                sourcedTexts: [...input.contextTexts, ...input.toolResultTexts],
            },
            config,
            { fetcher: dependencies.fetcher },
        );
    });
}
