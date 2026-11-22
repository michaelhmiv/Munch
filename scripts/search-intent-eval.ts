/**
 * Search Intent seat eval (approved brief 2026-11-22; model_eval_validity
 * skill). EVAL-ONLY — not wired into CI; run manually against the live
 * Decisions endpoint.
 *
 * Call shape: the PRODUCTION shape end to end — the fixture's real
 * candidate lists (collected 2026-11-22 through the production
 * search path) are fed to the production `applySearchIntentSeat`,
 * once per model as a single-model lane (the lane is config, so
 * this is still the production call shape). A fresh in-memory pin
 * store per query keeps every run a live decision (pins would
 * otherwise serve repeats with no call). The observing fetcher is a
 * transparent pass-through that only tallies latency + reported
 * cost; it never alters a request or response.
 *
 * Fixture: scripts/search-intent-fixture.json — 64 labelled queries
 * in 8 categories (bare, store-brand, national-brand, prepared,
 * ambiguous, form-specified, produce-pantry, drinks-snacks),
 * trimmed from the evidence package's fixture.json
 * (~/workspace/munch-evidence/search-intent-eval-2026-11-22/).
 * Ground truth was fixed BEFORE any model call: expected_id is the
 * candidate a person issuing the query most plausibly intends to
 * log; acceptable_ids also score as correct. 6 queries are provider
 * recall misses (no defensible candidate in the top 10) — reported,
 * never scored; no picker can fix them.
 *
 * Scoring mirrors the original eval (score.py): BEFORE = production
 * rank #1 and its default portion. AFTER = the seat's outcome with
 * the production fallback law — pinned candidate + pinned portion,
 * failing open to the picked candidate's default portion, then to
 * rank #1's default. Portion naturalness uses the same deterministic
 * classifier as the original fixture builder (a count/size unit a
 * person would log; any label containing "cup" or "undetermined" is
 * NOT natural — a documented simplification that understates fit
 * for milk / mac & cheese).
 *
 * Result of record (2026-11-22, the run that set the lane): pick
 * accuracy 62.1% before → 96.6% Perplexity, 93.1% Jev; natural
 * portion 25.9% → 44.8% / 41.4%; cost $0.027 (Perplexity) /
 * $0.085 (Jev) per 1,000 queries for both calls. Pass bar for
 * re-runs: each model must beat the deterministic baseline on pick
 * accuracy and on natural-portion rate; a model under the baseline
 * fails the run.
 *
 * Fixture candidates carry summary-shaped portions (id, label,
 * gram weight, calories); amount/unit are re-derived from the label
 * for the production portion ranking. The production seat operates
 * on real FoodCandidate objects — this derivation is eval
 * scaffolding only.
 *
 * Requires OPENROUTER_API_KEY. Run: bun scripts/search-intent-eval.ts
 */
import { readFileSync } from "node:fs";
import { applySearchIntentSeat } from "../src/decisions/search-intent.js";
import {
    decisionsConfig,
    type DecisionsConfig,
} from "../src/decisions/config.js";
import type { DecisionsFetcher } from "../src/decisions/client.js";
import type { SearchIntentPinRecord } from "../src/food-providers/catalog-repository.js";
import type {
    FoodCandidate,
    FoodPortion,
} from "../src/food-providers/types.js";

const MODELS = ["perplexity/pplx-decider-v1.2", "typesafe/jev-1.14"];

interface FixturePortion {
    id: string;
    label: string;
    gram_weight: number | null;
    calories: number | null;
}

interface FixtureCandidate {
    candidate_id: string;
    name: string;
    brand: string | null;
    provider: string;
    provider_label: string;
    data_kind: string;
    confidence: number;
    default_portion: { label: string };
    portions: FixturePortion[];
}

interface FixtureQuery {
    query: string;
    category: string;
    recall_miss: boolean;
    expected_id: string;
    acceptable_ids: string[];
    candidates: FixtureCandidate[];
}

const fixture = JSON.parse(
    readFileSync(
        new URL("./search-intent-fixture.json", import.meta.url),
        "utf8",
    ),
) as { queries: FixtureQuery[] };

const FALSE_SUBSTR = [
    "cup",
    "undetermined",
    "quantity not specified",
    "guideline",
];
const DISCRETE = [
    "medium",
    "large",
    "small",
    "egg",
    "slice",
    "piece",
    "breast",
    "can",
    "container",
    "pouch",
    "bag",
    "bar",
    "cookie",
    "bottle",
    "box",
    "packet",
    "portion",
    "serving",
    "stick",
    "pat",
    "tablespoon",
    "tbsp",
    "tbs",
    "teaspoon",
    "tsp",
    "scoop",
    "cone",
    "sundae",
    "fruit",
    "banana",
    "roll",
    "waffle",
    "bagel",
    "nut",
    "cracker",
    "tube",
    "jar",
    "wedge",
    "item",
    "drink",
    "wing",
    "thigh",
    "drumstick",
    "kernel",
    "berry",
    "berries",
    "package",
    "loaf",
    "cake",
    "pie",
    "salad",
    "ball",
];

function isNatural(label: string | null): boolean {
    if (!label) return false;
    const lower = label.toLowerCase();
    if (FALSE_SUBSTR.some((s) => lower.includes(s))) return false;
    if (lower.includes("juice of")) return true;
    return DISCRETE.some((token) => lower.includes(token));
}

function toPortion(raw: FixturePortion): FoodPortion {
    const match = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(raw.label.trim());
    const amount = match ? Number.parseFloat(match[1]!) : 1;
    const unit = (match?.[2] ?? "").split(/\s+/)[0] || "serving";
    return {
        id: raw.id,
        amount,
        unit,
        label: raw.label,
        gramWeight: raw.gram_weight ?? undefined,
        nutrients: raw.calories === null ? {} : { calories: raw.calories },
    };
}

function toCandidate(raw: FixtureCandidate): FoodCandidate {
    const separator = raw.candidate_id.indexOf(":");
    return {
        provider: raw.provider as FoodCandidate["provider"],
        providerFoodId: decodeURIComponent(
            raw.candidate_id.slice(separator + 1),
        ),
        name: raw.name,
        brand: raw.brand ?? undefined,
        dataKind: raw.data_kind as FoodCandidate["dataKind"],
        portions: raw.portions.map(toPortion),
        attribution: { label: raw.provider_label },
        confidence: raw.confidence,
    };
}

function observingFetcher(stats: { calls: number; costUsd: number }) {
    const fetcher: DecisionsFetcher = async (input, init) => {
        const response = await fetch(input, init);
        stats.calls += 1;
        try {
            const payload = (await response.clone().json()) as {
                usage?: { cost?: number };
            };
            if (typeof payload.usage?.cost === "number") {
                stats.costUsd += payload.usage.cost;
            }
        } catch {
            // Cost tally is best-effort; the response passes through.
        }
        return response;
    };
    return fetcher;
}

function freshPinStore() {
    const pins = new Map<string, SearchIntentPinRecord>();
    return {
        find: async (normalizedQuery: string) =>
            pins.get(normalizedQuery) ?? null,
        record: async (normalizedQuery: string, pin: SearchIntentPinRecord) => {
            pins.set(normalizedQuery, pin);
        },
    };
}

function pct(part: number, whole: number): string {
    return whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`;
}

async function main() {
    const base = decisionsConfig(process.env);
    if (!base) {
        console.error("OPENROUTER_API_KEY is required.");
        process.exit(2);
    }
    const scored = fixture.queries.filter((q) => !q.recall_miss);
    const recall = fixture.queries.filter((q) => q.recall_miss);

    let beforeCorrect = 0;
    let beforeNatural = 0;
    for (const query of scored) {
        const top = query.candidates[0]!;
        if (query.acceptable_ids.includes(top.candidate_id)) {
            beforeCorrect += 1;
        }
        if (isNatural(top.default_portion.label)) beforeNatural += 1;
    }
    console.log(
        `BEFORE (deterministic rank #1): pick ${pct(beforeCorrect, scored.length)} (${beforeCorrect}/${scored.length}), natural portion ${pct(beforeNatural, scored.length)} (${beforeNatural}/${scored.length})`,
    );
    console.log(
        `Recall misses excluded from scoring: ${recall.length} (${recall.map((q) => q.query).join(", ")})`,
    );

    let failed = false;
    for (const model of MODELS) {
        const config: DecisionsConfig = {
            ...base,
            searchIntentEnabled: true,
            searchIntentModels: [model],
            models: [model],
        };
        const stats = { calls: 0, costUsd: 0 };
        const fetcher = observingFetcher(stats);
        let correct = 0;
        let natural = 0;
        let abstained = 0;
        const started = Date.now();
        for (const query of scored) {
            const candidates = query.candidates.map(toCandidate);
            const result = await applySearchIntentSeat(
                query.query,
                candidates,
                {
                    config,
                    fetcher,
                    pinStore: freshPinStore(),
                },
            );
            const pickedId =
                result.pinnedCandidateId ?? query.candidates[0]!.candidate_id;
            if (query.acceptable_ids.includes(pickedId)) correct += 1;
            if (!result.pinnedCandidateId) abstained += 1;
            const pickedRaw = query.candidates.find(
                (c) => c.candidate_id === pickedId,
            )!;
            let portionLabel: string | null = null;
            if (result.pinnedPortionId) {
                portionLabel =
                    pickedRaw.portions.find(
                        (p) => p.id === result.pinnedPortionId,
                    )?.label ?? null;
            }
            portionLabel ??= pickedRaw.default_portion.label;
            if (isNatural(portionLabel)) natural += 1;
        }
        const elapsedMs = Date.now() - started;
        const beatsPick = correct > beforeCorrect;
        const beatsPortion = natural > beforeNatural;
        if (!beatsPick || !beatsPortion) failed = true;
        console.log(
            `${model}: pick ${pct(correct, scored.length)} (${correct}/${scored.length}), natural portion ${pct(natural, scored.length)} (${natural}/${scored.length}), abstained/no-pin ${abstained}, calls ${stats.calls}, cost $${stats.costUsd.toFixed(4)}, wall ${(elapsedMs / 1000).toFixed(1)}s — ${beatsPick && beatsPortion ? "PASS" : "FAIL (below baseline)"}`,
        );
    }
    process.exit(failed ? 1 : 0);
}

await main();
