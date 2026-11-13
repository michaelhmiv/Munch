/**
 * C2 — plan/shortfall contradiction check (Jev accountability audit
 * 2026-11-13, §2 seat C2).
 *
 * Where it sits: after `computePlanShortfall`
 * (`src/inventory/shortfall.ts`) has produced the rundown rows and the
 * grocery merge fold has attached each row's three-state pantry flag
 * (`pantryFlagForItem` / `attachPantryFlagsForScope`,
 * `src/inventory/grocery-pantry.ts`). Two subsystems write the same
 * rundown the user reads — the shortfall row (quantity math: "buy X
 * more, the pantry has none / not enough") and the pantry flag
 * (presence only: have / none / already on your list). When they
 * disagree, the rundown contradicts itself in front of the user.
 *
 * The check: ONE batched Decisions call per plan over the shortfall
 * rows + their flags — "do any of these rows contradict each other?"
 * — asked as one Noul question per row over a shared state (so
 * cross-row shapes, like a duplicate buy row for an item already on
 * the list, are visible to the model). It rides the existing
 * Decisions client (`callDecisionsWithFallback`), so the Jev →
 * `perplexity/pplx-decider-v1.2` fallback chain and the client's
 * `cost_usd` success logging are inherited, never re-implemented.
 *
 * On a found contradiction the row is recomputed ONCE
 * deterministically (the caller's recompute callback) and only a
 * PERSISTENT contradiction — the recomputed row still carries the
 * same row/flag combination the model flagged — is surfaced, as a
 * `contradiction_flag` annotation on that row. The seat never edits,
 * drops, or reorders a row, and never adds anything to a grocery
 * list.
 *
 * FAIL-OPEN: flag off, no config, an empty rundown, a down chain, or
 * an unparseable answer all return the rows exactly as computed —
 * the rundown renders exactly as it did before this seat existed,
 * and the check is logged `unchecked`.
 *
 * #283 LAW, held throughout: presence-only / approximate stock never
 * proves a shortfall, and flags inform — only explicit Add taps add.
 * This seat reviews CONSISTENCY between the row and the flag; it
 * does not change shortfall semantics. In particular a "short" row
 * whose flag says "have" is CORRECT, not a contradiction: the flag
 * reports presence, the row reports that exact stock falls short.
 * The question wording below teaches exactly that distinction, and
 * the seat's eval scores false alarms on that shape as the headline
 * metric.
 */
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    decisionsConfig,
    shortfallCheckEnabled,
    shortfallCheckTimeoutMs,
    shortfallContradictionThresholdForModel,
    type DecisionsConfig,
} from "./config.js";
import { noulProbability } from "./gate.js";

/** Structural view of a shortfall row + its flag (satisfied by
 * `ShortfallItemWithFlag` in `src/inventory/shortfall.ts`). Only the
 * fields the consistency check reasons over — no user identifiers,
 * no account data: item names, quantities, and flag states are the
 * same anonymous categories the privacy page already discloses for
 * decision-model checking. */
export interface ShortfallCheckRow {
    name: string;
    normalized_name: string;
    need_quantity: number;
    need_unit: string | null;
    have_quantity: number;
    short_quantity: number;
    pantry_state: "none" | "short";
    on_list: boolean;
    pantry_flag: {
        state: "have" | "none" | "listed";
        pantry_item_id: string | null;
        pantry_name: string | null;
    };
}

export interface ShortfallContradictionFlag {
    /** The model that made the call (after any fallback). */
    model: string;
    /** p(contradiction) reported for this row. */
    probability: number;
    /** The serving model's calibrated threshold the probability met. */
    threshold: number;
}

export type ShortfallCheckRowWithFlag<T extends ShortfallCheckRow> = T & {
    contradiction_flag?: ShortfallContradictionFlag;
};

export interface ShortfallCheckResult<T extends ShortfallCheckRow> {
    rows: Array<ShortfallCheckRowWithFlag<T>>;
    /** Rows whose contradiction persisted after one recompute. */
    contradictions: Array<{
        normalized_name: string;
        name: string;
        flag: ShortfallContradictionFlag;
    }>;
    status: "disabled" | "unchecked" | "consistent" | "contradiction";
    /** API-reported cost of the single batched call, when it ran. */
    reportedCostUsd: number | null;
    model: string | null;
}

export interface ShortfallCheckDependencies {
    fetcher?: DecisionsFetcher;
    /** Test/drill seam: supply a config instead of reading the env. */
    config?: DecisionsConfig | null;
}

function quantityText(value: number, unit: string | null): string {
    return unit ? `${value} ${unit}` : `${value}`;
}

/**
 * The batched state: every row with BOTH channels spelled out in
 * words, because the model judges the relationship between the two
 * reports, not raw enum values alone.
 */
export function buildShortfallCheckState(rows: ShortfallCheckRow[]): unknown {
    return {
        task: "Check a grocery shortfall rundown for rows whose quantity report contradicts the pantry presence flag attached to the same row, or that duplicate another row.",
        channels: {
            row: "The row is quantity math for one planned item: how much the plan needs, how much exact pantry stock was found, and how much more to buy. pantry_state 'none' means the pantry was found to have none of the item (have_quantity 0). pantry_state 'short' means exact pantry stock exists but is less than the plan needs.",
            flag: "The flag is a presence-only report attached to the row. 'have' means the item is present in the pantry — it says nothing about whether there is enough. 'none' means no matching item is in the pantry. 'listed' means the item is already on the user's open grocery list, so it is already handled.",
        },
        rows: rows.map((row, index) => ({
            row: index,
            item: row.name,
            needs: quantityText(row.need_quantity, row.need_unit),
            pantry_stock_found: quantityText(row.have_quantity, row.need_unit),
            to_buy: quantityText(row.short_quantity, row.need_unit),
            pantry_state: row.pantry_state,
            already_on_grocery_list: row.on_list,
            pantry_flag: row.pantry_flag.state,
            pantry_flag_item: row.pantry_flag.pantry_name,
        })),
    };
}

const CONTRADICTION_INSTRUCTIONS =
    "Does this row contradict the other information in the rundown? " +
    "A contradiction is one of these: " +
    "(1) the row says the pantry has none of the item (pantry_state 'none', pantry_stock_found 0) while its flag says the item is in the pantry ('have'); " +
    "(2) the row says exact pantry stock exists and falls short (pantry_state 'short') while its flag says the item is not in the pantry at all ('none'); " +
    "(3) the same item appears as a row to buy more than once in this rundown, or appears again as a separate row to buy when another row for the same item already shows it on the grocery list ('listed') — a duplicate buy. " +
    "These are NOT contradictions: a 'short' row whose flag says 'have' (the flag reports presence only; exact stock can be present and still not be enough — that pairing is correct); " +
    "a 'none' row whose flag says 'none'; " +
    "an item whose only row is flagged 'listed' (it is already handled, shown for information). " +
    "Judge only whether the row and the flag (or another row) disagree — not whether the quantities are sensible.";

/** One Noul question per row, all in the single batched call. */
export function buildShortfallCheckQuestions(
    rows: ShortfallCheckRow[],
): Record<string, unknown> {
    const questions: Record<string, unknown> = {};
    rows.forEach((row, index) => {
        questions[`r${index}`] = {
            type: "noul",
            instructions: `Row ${index} is for the item "${row.name}". ${CONTRADICTION_INSTRUCTIONS}`,
        };
    });
    return questions;
}

/**
 * Parse the batched answers into per-row p(contradiction). A row
 * whose answer is missing or unparseable is an abstention (null) —
 * never treated as a contradiction (fail-open).
 */
export function parseShortfallCheckAnswers(
    rows: ShortfallCheckRow[],
    answers: Record<string, unknown>,
): Array<number | null> {
    return rows.map((_row, index) => noulProbability(answers[`r${index}`]));
}

export interface ShortfallCheckCallResult {
    model: string;
    reportedCostUsd: number | null;
    durationMs: number;
    probabilities: Array<number | null>;
    flaggedIndexes: number[];
    threshold: number;
}

/**
 * The ONE batched Decisions call for a plan's rundown. Throws
 * (DecisionsChainExhaustedError) when the whole chain is down — the
 * seat wrapper owns the fail-open terminal behaviour.
 */
export async function checkShortfallContradictionsViaDecisions(
    rows: ShortfallCheckRow[],
    config: DecisionsConfig,
    dependencies: ShortfallCheckDependencies = {},
): Promise<ShortfallCheckCallResult> {
    const call = await callDecisionsWithFallback(config, {
        seat: "shortfall_check",
        timeoutMs: shortfallCheckTimeoutMs(config),
        includeImageHeader: false,
        fetcher: dependencies.fetcher,
        state: buildShortfallCheckState(rows),
        questions: buildShortfallCheckQuestions(rows),
    });
    const threshold = shortfallContradictionThresholdForModel(call.model);
    const probabilities = parseShortfallCheckAnswers(rows, call.answers);
    const flaggedIndexes = probabilities
        .map((probability, index) => ({ probability, index }))
        .filter(
            (entry) =>
                entry.probability !== null && entry.probability >= threshold,
        )
        .map((entry) => entry.index);
    return {
        model: call.model,
        reportedCostUsd: call.reportedCostUsd,
        durationMs: call.durationMs,
        probabilities,
        flaggedIndexes,
        threshold,
    };
}

/** The row/flag combination the model saw, for persistence comparison. */
function rowSignature(row: ShortfallCheckRow): string {
    return JSON.stringify([
        row.normalized_name,
        row.need_unit,
        row.pantry_state,
        row.have_quantity,
        row.short_quantity,
        row.on_list,
        row.pantry_flag.state,
        row.pantry_flag.pantry_item_id,
    ]);
}

/**
 * The wired seat. NEVER throws.
 *
 * - Seat off / no config / no rows → rows untouched, zero calls.
 * - One batched call per plan when enabled.
 * - Flagged rows are recomputed ONCE via `recompute` (deterministic);
 *   a flag survives only when the recomputed rundown still contains
 *   the same row with the same row/flag combination (persistent).
 * - Chain down or unparseable → rows untouched, status `unchecked`.
 */
export async function reviewShortfallContradictions<
    T extends ShortfallCheckRow,
>(
    rows: T[],
    recompute: () => T[],
    dependencies: ShortfallCheckDependencies = {},
): Promise<ShortfallCheckResult<T>> {
    const untouched = (
        status: ShortfallCheckResult<T>["status"],
    ): ShortfallCheckResult<T> => ({
        rows: [...rows],
        contradictions: [],
        status,
        reportedCostUsd: null,
        model: null,
    });
    const config =
        dependencies.config !== undefined
            ? dependencies.config
            : decisionsConfig();
    if (!config || !shortfallCheckEnabled(config) || rows.length === 0) {
        return untouched("disabled");
    }
    try {
        const call = await checkShortfallContradictionsViaDecisions(
            rows,
            config,
            { fetcher: dependencies.fetcher },
        );
        if (call.flaggedIndexes.length === 0) {
            console.info(
                `[decisions] seat=shortfall_check status=consistent model=${call.model} rows=${rows.length} cost_usd=${call.reportedCostUsd ?? "null"}`,
            );
            return {
                rows: [...rows],
                contradictions: [],
                status: "consistent",
                reportedCostUsd: call.reportedCostUsd,
                model: call.model,
            };
        }
        // Recompute ONCE deterministically; only a contradiction that
        // is still present in the recomputed rundown is surfaced.
        const recomputed = recompute();
        const recomputedBySignature = new Map(
            recomputed.map((row) => [rowSignature(row), row]),
        );
        const contradictions: ShortfallCheckResult<T>["contradictions"] = [];
        const annotated = rows.map((row, index) => {
            if (!call.flaggedIndexes.includes(index)) return row;
            if (!recomputedBySignature.has(rowSignature(row))) return row;
            const flag: ShortfallContradictionFlag = {
                model: call.model,
                probability: call.probabilities[index]!,
                threshold: call.threshold,
            };
            contradictions.push({
                normalized_name: row.normalized_name,
                name: row.name,
                flag,
            });
            return { ...row, contradiction_flag: flag };
        });
        console.info(
            `[decisions] seat=shortfall_check status=${contradictions.length > 0 ? "contradiction" : "consistent"} model=${call.model} rows=${rows.length} flagged=${call.flaggedIndexes.length} persistent=${contradictions.length} cost_usd=${call.reportedCostUsd ?? "null"}`,
        );
        return {
            rows: annotated,
            contradictions,
            status: contradictions.length > 0 ? "contradiction" : "consistent",
            reportedCostUsd: call.reportedCostUsd,
            model: call.model,
        };
    } catch (error) {
        console.info(
            `[decisions] seat=shortfall_check status=unchecked reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
        return untouched("unchecked");
    }
}
