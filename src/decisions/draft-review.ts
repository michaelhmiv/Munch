/**
 * A3 — photo-draft NUMERIC plausibility review (jev-accountability-audit
 * 2026-11-13, §2 seat A3; Tier 1). NOT image verification.
 *
 * Where: after grounding completes in `createMealPhotoDraft`, before
 * the draft is presented — reviewing the grounded draft's NUMBERS
 * only. The image is NEVER sent to this seat: the Decisions payload
 * is built exclusively from text/numeric state (food name, portion
 * label, grams, kcal, implied kcal/100 g, grounding source). This
 * seat exists precisely because Jev IMAGE verification is dead and
 * must not be revived; it has no pixels to verify, by construction
 * (there is no image field anywhere in this module's inputs).
 *
 * The existing deterministic guard (`MAX_GENERIC_PORTION_FACTOR = 20`
 * in src/meal-photo/grounding.ts) catches magnitude; A3 catches
 * wrong-for-this-food — a grounded portion conversion that is under
 * the cap but semantically insane for the food (a "cup" of olive oil
 * grounded at salad grams, a beverage grounded at solid-food grams,
 * a condiment at entrée portions).
 *
 * ONE batched Decisions call per draft (chunked only past the
 * Decisions API's 8-question per-request limit, S2's constraint).
 * FAIL-OPEN everywhere: flag off, no config, chain down, or an
 * unparseable answer all resolve to `unchecked` and the draft
 * presents exactly as it did before this seat existed. A flagged
 * item is handed off by the pipeline to the mechanisms that already
 * exist — the labelled model-estimate path, or a blocking draft
 * question (see src/meal-photo/pipeline.ts). Confirm-before-save
 * stays the verification layer for photos: A3 flags, the human
 * still confirms.
 *
 * Scope: the seat reviews PROVIDER-GROUNDED items. Items already on
 * the labelled model-estimate path are already labelled estimates,
 * and valueless items already carry blocking questions — neither
 * needs a second demotion.
 *
 * Fold-in (audit §2, "Not a new seat"): MCP `bulk_import_meals`
 * batches get one A3-style batched plausibility call per import over
 * deterministically selected outlier rows (same checker, same
 * thresholds; outlier totals across a batch are invisible
 * item-by-item). A flagged import row surfaces as an import warning —
 * bulk import is a direct commit with no draft stage, and the seat
 * never blocks it (fail-open).
 *
 * Privacy: the payloads carry food names and nutrition numbers only
 * — the categories the privacy page already discloses for decision
 * models ("food names, quantities, nutrition numbers"). No name,
 * email, account identifier, or any new data category is sent.
 */
import type { ImportRow } from "../import.js";
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    decisionsConfig,
    draftReviewPlausibleThresholdForModel,
    type DecisionsConfig,
} from "./config.js";
import { noulProbability } from "./gate.js";

/** TypeSafe's per-request question limit (same constraint as S2). */
const MAX_QUESTIONS_PER_CALL = 8;

export interface DraftReviewItem {
    foodName: string;
    portionLabel: string;
    grams: number | null;
    kcal: number | null;
    groundingSource: string;
}

export interface DraftReviewItemVerdict {
    index: number;
    pPlausible: number;
    threshold: number;
    flagged: boolean;
}

export type DraftReviewOutcome =
    | {
          status: "unchecked";
          reason: string;
          verdicts: DraftReviewItemVerdict[];
          model: null;
          reportedCostUsd: null;
      }
    | {
          status: "reviewed";
          reason: string;
          verdicts: DraftReviewItemVerdict[];
          model: string;
          /** Sum of API-reported costs across the seat's calls. */
          reportedCostUsd: number | null;
          durationMs: number;
      };

export interface DraftReviewDependencies {
    fetcher?: DecisionsFetcher;
    /** Test/drill seam: supply a config instead of reading the env. */
    config?: DecisionsConfig | null;
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

export function impliedKcalPer100g(item: DraftReviewItem): number | null {
    if (
        item.kcal === null ||
        item.grams === null ||
        !Number.isFinite(item.kcal) ||
        !Number.isFinite(item.grams) ||
        item.grams <= 0
    ) {
        return null;
    }
    return round2((item.kcal / item.grams) * 100);
}

export function buildDraftReviewState(items: DraftReviewItem[]): unknown {
    return {
        task: "Judge whether each grounded meal-photo draft item's portion conversion is plausible for its food. Numbers and text only; no image was provided or requested.",
        items: items.map((item, index) => ({
            question: `q${index}`,
            food_name: item.foodName,
            portion_label: item.portionLabel,
            grams: item.grams,
            kcal: item.kcal,
            implied_kcal_per_100g: impliedKcalPer100g(item),
            grounding_source: item.groundingSource,
        })),
    };
}

export function draftReviewQuestions(
    items: DraftReviewItem[],
): Record<string, unknown> {
    const questions: Record<string, unknown> = {};
    items.forEach((item, index) => {
        const implied = impliedKcalPer100g(item);
        questions[`q${index}`] = {
            type: "noul",
            instructions:
                `A meal-photo draft item was grounded to a food-database entry: "${item.foodName}", portion "${item.portionLabel}", weighing ${item.grams ?? "unknown"} g with ${item.kcal ?? "unknown"} kcal` +
                (implied !== null ? ` (${implied} kcal per 100 g)` : "") +
                `, grounded from ${item.groundingSource}. ` +
                `Is this portion conversion plausible for this food — could ${item.portionLabel} of ${item.foodName} reasonably weigh that much and carry that many calories? ` +
                "Implausible means the gram weight or calories are wrong for this food and this portion size — for example a cup of a liquid weighing only a few dozen grams, a tablespoon weighing as much as an entree, a beverage weighed like a solid meal, or a condiment portioned like a main course — even when the numbers are internally consistent for some other food. " +
                "Legitimately energy-dense foods (oils, butter, nuts, hard cheese, peanut butter) are plausible when the stated portion genuinely matches their amount: a real cup of olive oil really is about 1,900 kcal.",
        };
    });
    return questions;
}

function chunk<T>(values: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < values.length; i += size) {
        out.push(values.slice(i, i + size));
    }
    return out;
}

/**
 * Review one draft's grounded items. NEVER throws: every failure
 * mode resolves to `unchecked` (fail-open) for the affected items.
 */
export async function reviewDraftNumbers(
    items: DraftReviewItem[],
    dependencies: DraftReviewDependencies = {},
): Promise<DraftReviewOutcome> {
    const unchecked = (reason: string): DraftReviewOutcome => {
        console.info(
            `[decisions] seat=draft_review status=fail_open reason=${reason}`,
        );
        return {
            status: "unchecked",
            reason,
            verdicts: [],
            model: null,
            reportedCostUsd: null,
        };
    };
    const config =
        dependencies.config !== undefined
            ? dependencies.config
            : decisionsConfig();
    if (!config) return unchecked("no_config");
    if (!config.draftReviewEnabled) return unchecked("disabled");
    if (items.length === 0) return unchecked("no_items");
    try {
        const verdicts: DraftReviewItemVerdict[] = [];
        let model: string | null = null;
        let totalCost: number | null = null;
        let durationMs = 0;
        // Indexed chunks so verdict indices stay in draft order. In
        // the normal case (<= 8 grounded items) this is exactly ONE
        // batched call for the whole draft.
        const indexed = items.map((item, index) => ({ item, index }));
        for (const group of chunk(indexed, MAX_QUESTIONS_PER_CALL)) {
            const groupItems = group.map((entry) => entry.item);
            const call = await callDecisionsWithFallback(config, {
                seat: "draft_review",
                timeoutMs: config.draftReviewTimeoutMs,
                includeImageHeader: false,
                fetcher: dependencies.fetcher,
                state: buildDraftReviewState(groupItems),
                questions: draftReviewQuestions(groupItems),
            });
            model = call.model;
            durationMs += call.durationMs;
            if (call.reportedCostUsd !== null) {
                totalCost = (totalCost ?? 0) + call.reportedCostUsd;
            }
            const threshold = draftReviewPlausibleThresholdForModel(call.model);
            group.forEach((entry, groupIndex) => {
                const p = noulProbability(call.answers[`q${groupIndex}`]);
                if (p === null) return; // unparseable per-item: unchecked
                verdicts.push({
                    index: entry.index,
                    pPlausible: p,
                    threshold,
                    flagged: p < threshold,
                });
            });
        }
        if (verdicts.length === 0 || model === null) {
            return unchecked("unparseable_answers");
        }
        const flaggedCount = verdicts.filter((v) => v.flagged).length;
        console.info(
            `[decisions] seat=draft_review status=reviewed model=${model} items=${verdicts.length} flagged=${flaggedCount} cost_usd=${totalCost ?? "null"} duration_ms=${durationMs}`,
        );
        return {
            status: "reviewed",
            reason: "reviewed",
            verdicts,
            model,
            reportedCostUsd: totalCost,
            durationMs,
        };
    } catch {
        return unchecked("decisions_unavailable");
    }
}

// ---------- Bulk import fold-in (same seat, same checker) ----------

export interface BulkReviewRow {
    description: string;
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    alcohol_g: number | null;
}

export interface BulkOutlierCandidate {
    index: number;
    row: BulkReviewRow;
    ratioToBatchMedian: number | null;
    atwaterImpliedKcal: number | null;
}

/** Atwater factors — code computes, the model only judges. */
export function atwaterImpliedKcal(row: BulkReviewRow): number | null {
    if (row.protein_g === null || row.carbs_g === null || row.fat_g === null) {
        return null;
    }
    return round2(
        row.protein_g * 4 +
            row.carbs_g * 4 +
            row.fat_g * 9 +
            (row.alcohol_g ?? 0) * 7,
    );
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Deterministic outlier pre-filter for a bulk-import batch (free,
 * no model): a row is a candidate when its calories dwarf the batch
 * median, clear an absolute feast ceiling on their own, or flatly
 * contradict their own macros under Atwater. Capped so the batch
 * fits one Decisions call (7 candidates + headroom under the
 * 8-question limit).
 */
export function selectBulkOutlierCandidates(
    rows: BulkReviewRow[],
): BulkOutlierCandidate[] {
    const kcals = rows
        .map((row) => row.kcal)
        .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    const batchMedian = median(kcals);
    const candidates: BulkOutlierCandidate[] = [];
    rows.forEach((row, index) => {
        if (row.kcal === null || !Number.isFinite(row.kcal) || row.kcal <= 0) {
            return;
        }
        const ratio =
            batchMedian && batchMedian > 0
                ? round2(row.kcal / batchMedian)
                : null;
        const atwater = atwaterImpliedKcal(row);
        const atwaterMismatch =
            atwater !== null &&
            atwater > 0 &&
            Math.abs(row.kcal - atwater) / atwater > 0.6 &&
            Math.abs(row.kcal - atwater) > 200;
        const dwarfsBatch = ratio !== null && ratio > 2.5 && row.kcal >= 1_000;
        const feastCeiling = row.kcal > 4_000;
        if (dwarfsBatch || feastCeiling || atwaterMismatch) {
            candidates.push({
                index,
                row,
                ratioToBatchMedian: ratio,
                atwaterImpliedKcal: atwater,
            });
        }
    });
    return candidates.slice(0, MAX_QUESTIONS_PER_CALL - 1);
}

export function buildBulkReviewState(
    rows: BulkReviewRow[],
    candidates: BulkOutlierCandidate[],
): unknown {
    const kcals = rows
        .map((row) => row.kcal)
        .filter((v): v is number => v !== null && Number.isFinite(v));
    return {
        task: "Judge whether each outlier meal row in a bulk import batch is plausible for the meal it describes. Numbers and text only.",
        surface: "bulk_import_meals",
        batch_row_count: rows.length,
        batch_total_kcal: round2(kcals.reduce((a, b) => a + b, 0)),
        batch_median_kcal: median(kcals),
        items: candidates.map((candidate, index) => ({
            question: `q${index}`,
            food_name: candidate.row.description,
            calories_kcal: candidate.row.kcal,
            protein_g: candidate.row.protein_g,
            carbs_g: candidate.row.carbs_g,
            fat_g: candidate.row.fat_g,
            atwater_implied_kcal: candidate.atwaterImpliedKcal,
            ratio_to_batch_median: candidate.ratioToBatchMedian,
            grounding_source: "bulk_import",
        })),
    };
}

export function bulkReviewQuestions(
    candidates: BulkOutlierCandidate[],
): Record<string, unknown> {
    const questions: Record<string, unknown> = {};
    candidates.forEach((candidate, index) => {
        questions[`q${index}`] = {
            type: "noul",
            instructions:
                `A bulk meal-history import contains this row: "${candidate.row.description}" at ${candidate.row.kcal} kcal` +
                (candidate.ratioToBatchMedian !== null
                    ? `, which is ${candidate.ratioToBatchMedian}x the batch's median meal`
                    : "") +
                (candidate.atwaterImpliedKcal !== null
                    ? `; its own macros (protein ${candidate.row.protein_g} g, carbs ${candidate.row.carbs_g} g, fat ${candidate.row.fat_g} g) imply about ${candidate.atwaterImpliedKcal} kcal`
                    : "") +
                ". Is this calorie total plausible for the meal described — could a person plausibly eat a meal by that name carrying that many calories? " +
                "Implausible means the total looks like a data error for this meal (a mis-mapped column, a decimal slip, a day's total on one meal's row, or macros that contradict the stated calories), not merely a large meal: feasts, whole pizzas, and celebration meals can legitimately exceed 2,000 kcal.",
        };
    });
    return questions;
}

export interface BulkReviewOutcome {
    status: "unchecked" | "reviewed";
    reason: string;
    flagged: Array<{
        index: number;
        description: string;
        kcal: number | null;
        pPlausible: number;
        threshold: number;
    }>;
    model: string | null;
    reportedCostUsd: number | null;
}

/**
 * One A3-style batched plausibility call per bulk import (over the
 * deterministic outlier candidates; zero calls when the batch has
 * no outliers). NEVER throws and never blocks the import: flagged
 * rows are returned for the caller to surface as warnings.
 */
export async function reviewBulkImportRows(
    rows: BulkReviewRow[],
    dependencies: DraftReviewDependencies = {},
): Promise<BulkReviewOutcome> {
    const unchecked = (reason: string): BulkReviewOutcome => {
        console.info(
            `[decisions] seat=draft_review surface=bulk_import status=fail_open reason=${reason}`,
        );
        return {
            status: "unchecked",
            reason,
            flagged: [],
            model: null,
            reportedCostUsd: null,
        };
    };
    const config =
        dependencies.config !== undefined
            ? dependencies.config
            : decisionsConfig();
    if (!config) return unchecked("no_config");
    if (!config.draftReviewEnabled) return unchecked("disabled");
    const candidates = selectBulkOutlierCandidates(rows);
    if (candidates.length === 0) return unchecked("no_outliers");
    try {
        const call = await callDecisionsWithFallback(config, {
            seat: "draft_review",
            timeoutMs: config.draftReviewTimeoutMs,
            includeImageHeader: false,
            fetcher: dependencies.fetcher,
            state: buildBulkReviewState(rows, candidates),
            questions: bulkReviewQuestions(candidates),
        });
        const threshold = draftReviewPlausibleThresholdForModel(call.model);
        const flagged: BulkReviewOutcome["flagged"] = [];
        candidates.forEach((candidate, index) => {
            const p = noulProbability(call.answers[`q${index}`]);
            if (p === null || p >= threshold) return;
            flagged.push({
                index: candidate.index,
                description: candidate.row.description,
                kcal: candidate.row.kcal,
                pPlausible: p,
                threshold,
            });
        });
        console.info(
            `[decisions] seat=draft_review surface=bulk_import status=reviewed model=${call.model} candidates=${candidates.length} flagged=${flagged.length} cost_usd=${call.reportedCostUsd ?? "null"} duration_ms=${call.durationMs}`,
        );
        return {
            status: "reviewed",
            reason: "reviewed",
            flagged,
            model: call.model,
            reportedCostUsd: call.reportedCostUsd,
        };
    } catch {
        return unchecked("decisions_unavailable");
    }
}

/**
 * The import-service hook shape (see registerBulkImportReviewHook in
 * src/import-service.ts): adapt ImportRows to the bulk checker and
 * format flagged rows as import warnings. Registered by the website
 * entry at startup; the seat's own gating applies inside
 * reviewBulkImportRows (flag off / no outliers = zero calls).
 */
export async function bulkImportReviewWarnings(
    rows: ImportRow[],
    dependencies: DraftReviewDependencies = {},
): Promise<string[]> {
    const review = await reviewBulkImportRows(
        rows.map((row) => ({
            description: row.description ?? "",
            kcal: row.calories ?? null,
            protein_g: row.protein_g ?? null,
            carbs_g: row.carbs_g ?? null,
            fat_g: row.fat_g ?? null,
            alcohol_g: row.alcohol_g ?? null,
        })),
        dependencies,
    );
    return review.flagged.map(
        (flag) =>
            `Plausibility review flagged the imported row "${flag.description}" (${flag.kcal} kcal) as implausible for that meal — check for a mis-mapped column or a decimal slip in the source file. The row was imported as sent.`,
    );
}
