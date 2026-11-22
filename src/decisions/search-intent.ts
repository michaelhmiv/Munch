/**
 * Search Intent seat (approved brief 2026-11-22 — SEAT-BRIEF.md in
 * the search-intent-eval-2026-11-22 evidence package; Michael's
 * directive: the seat fires on EVERY web/app search, "even like
 * Aldi milk etc or different brands").
 *
 * What it does: given a query and the deterministic ranked
 * candidate list, a Decisions model picks (1) the single candidate
 * the user most likely intends to log and (2) the portion of that
 * candidate a person would most likely log. The pick is pinned to
 * the top of the list and the picked portion becomes that
 * candidate's default portion (applied by the caller through
 * `summarizeFoodCandidate`'s `defaultPortionId`). Nothing is hidden
 * or removed; the rest of the list keeps its ranked order.
 *
 * Measured before it shipped (2026-11-22 eval, 64 labelled queries,
 * production call shape): pick accuracy 62.1% for today's rank #1 →
 * 96.6% Perplexity / 93.1% Jev; natural-portion rate 25.9% →
 * 44.8% / 41.4%. The lane is therefore Perplexity-led with Jev as
 * the availability fallback (`searchIntentModelOrder`) — the same
 * lead/backup arrangement as A1 plausibility. Fallback law holds:
 * model swaps, never deterministic code.
 *
 * Call shape: the eval's, verbatim — same instruction text, same
 * state and criteria construction, same fabrication bar (an answer
 * key outside the offered options is discarded). The eval harness
 * this mirrors lives in the evidence package's run_eval.py; the
 * fixture is re-runnable in-repo via scripts/search-intent-eval.ts.
 *
 * Cached pins: a decision is stored keyed by the normalized query
 * (db/updates/0050, `FoodCatalogRepository` pin methods) and repeat
 * searches apply it with NO model call. A pin whose candidate no
 * longer appears in a fresh candidate list is stale — ignored and
 * re-decided. A recorded abstention ("none") is cached too: it only
 * suppresses the model call, never alters the list, and a later
 * provider-side fix still surfaces through deterministic ranking.
 *
 * Fail-open, always: seat off / no key, timeout (hard total budget
 * for BOTH calls — `searchIntentTimeoutMs`, default 3 s), chain
 * exhaustion, an unparseable answer, or a pin-store error all
 * return the ranked list untouched and record nothing. Search never
 * fails or hangs because of this seat.
 *
 * Wiring: `searchAppFoods` in `src/app/meal-entry.ts` — the web/app
 * search surface ONLY, the same territory as Seat B2. The MCP
 * `search_foods` path is deliberately NOT wired: the host-AI
 * boundary law (src/host-ai-boundary.test.ts) forbids the MCP
 * dependency graph from reaching the website model clients, and in
 * MCP the host model performs the selection itself.
 *
 * Relationship to B2 (`applyAmbiguousMatchDecider`): the seats
 * never double-decide a list. `applySearchSeats` runs this seat
 * first; when it applies a pin, B2 does not run. When this seat is
 * off, abstains, or fails open, B2 runs on the untouched list with
 * exactly its current behaviour.
 *
 * Privacy: the model sees query text + candidate metadata only —
 * no user identity, no history.
 */
import {
    FoodCatalogRepository,
    normalizeFoodText,
    type SearchIntentPinRecord,
} from "../food-providers/catalog-repository.js";
import { foodCatalogConfig } from "../food-providers/catalog-config.js";
import {
    deduplicatePortions,
    naturalPortion,
    per100gPortion,
    sortPortionsNaturalFirst,
} from "../food-providers/portions.js";
import { canonicalizeFoodSearchQuery } from "../food-providers/query-normalization.js";
import { encodeFoodCandidateId } from "../food-providers/service.js";
import type { FoodCandidate, FoodPortion } from "../food-providers/types.js";
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    decisionsConfig,
    searchIntentEnabled,
    searchIntentModelOrder,
    searchIntentTimeoutMs,
    type DecisionsConfig,
} from "./config.js";
import {
    applyAmbiguousMatchDecider,
    type MatchDeciderDependencies,
} from "./match.js";

/** Candidates shown to the model (the surfaces return a top 10). */
export const SEARCH_INTENT_SHORTLIST_LIMIT = 10;
/** Portions shown to the model for the picked candidate. */
export const SEARCH_INTENT_PORTION_LIMIT = 6;

/**
 * Instruction text, verbatim from the 2026-11-22 eval — the shipped
 * seat is the thing that was measured, so these strings do not get
 * paraphrased.
 */
const CANDIDATE_INSTRUCTION =
    "A user searched a nutrition app for the query in the state. Choose the single candidate they most likely intend to log. Prefer an exact brand match when the query names a brand or store; otherwise prefer the plain, unprepared, generic form of the food over branded, flavored, or prepared variants, unless the query itself asks for a prepared dish.";
const PORTION_INSTRUCTION =
    "Which portion would a person most likely log for this food? Choose the single portion that represents the amount a person would typically eat and log at one time for the food in the state.";
const NONE_CRITERION =
    "No candidate is a defensible match for this search query.";

export interface SearchIntentPinStore {
    find(normalizedQuery: string): Promise<SearchIntentPinRecord | null>;
    record(normalizedQuery: string, pin: SearchIntentPinRecord): Promise<void>;
}

export interface SearchIntentDependencies {
    fetcher?: DecisionsFetcher;
    /** Defaults to the environment-resolved config. Pass `null` to
     * force the seat off (the no-key shape). */
    config?: DecisionsConfig | null;
    /** Defaults to the catalog-backed pin store. */
    pinStore?: SearchIntentPinStore;
}

export interface SearchIntentResult {
    /** The ranked list with the pinned candidate first — the SAME
     * array reference when no pin applied (fail-open identity, as
     * B2 keeps). */
    candidates: FoodCandidate[];
    /** Encoded id of the pinned candidate; null when no pin. */
    pinnedCandidateId: string | null;
    /** Portion id to headline for the pinned candidate; null means
     * its natural default stands. */
    pinnedPortionId: string | null;
}

let sharedPinStore: SearchIntentPinStore | null = null;

function defaultPinStore(): SearchIntentPinStore {
    if (!sharedPinStore) {
        const repository = new FoodCatalogRepository(foodCatalogConfig());
        sharedPinStore = {
            find: (normalizedQuery) =>
                repository.findSearchIntentPin(normalizedQuery),
            record: (normalizedQuery, pin) =>
                repository.recordSearchIntentPin(normalizedQuery, pin),
        };
    }
    return sharedPinStore;
}

/** The label the surfaces headline today (mirrors
 * `summarizeFoodCandidate`'s default-portion choice) — this is what
 * the eval showed the model for each candidate. */
function defaultPortionLabel(candidate: FoodCandidate): string | null {
    const portion =
        naturalPortion(candidate.portions) ??
        (candidate.nutrientsPer100g
            ? per100gPortion(candidate.nutrientsPer100g)
            : candidate.portions[0]);
    return portion?.label ?? null;
}

/** The portion list the surfaces present (deduplicated,
 * natural-first), capped as the eval capped it. */
function portionOptions(candidate: FoodCandidate): FoodPortion[] {
    return deduplicatePortions(
        sortPortionsNaturalFirst(candidate.portions),
    ).slice(0, SEARCH_INTENT_PORTION_LIMIT);
}

function buildCandidateState(
    query: string,
    shortlist: FoodCandidate[],
): unknown {
    return {
        task: "Choose the food-database candidate a user most likely intends to log for a search query.",
        items: [
            {
                question: "q0",
                search_query: query,
                candidates: shortlist.map((candidate, index) => ({
                    option: `c${index}`,
                    name: candidate.name,
                    brand: candidate.brand ?? null,
                    source_database: candidate.provider,
                    data_kind: candidate.dataKind,
                    default_portion: defaultPortionLabel(candidate),
                })),
            },
        ],
    };
}

function buildCandidateQuestions(
    shortlist: FoodCandidate[],
): Record<string, unknown> {
    const criteria: Record<string, string> = {};
    shortlist.forEach((candidate, index) => {
        criteria[`c${index}`] =
            `${candidate.name}` +
            (candidate.brand ? ` — brand: ${candidate.brand}` : "") +
            ` (source database: ${candidate.provider})`;
    });
    criteria["none"] = NONE_CRITERION;
    return {
        q0: {
            type: "choice",
            instructions: CANDIDATE_INSTRUCTION,
            criteria,
        },
    };
}

function buildPortionState(
    query: string,
    candidate: FoodCandidate,
    portions: FoodPortion[],
): unknown {
    return {
        task: "Choose the portion a person would most likely log for a food.",
        items: [
            {
                question: "q0",
                search_query: query,
                food: candidate.name,
                brand: candidate.brand ?? null,
                portions: portions.map((portion, index) => ({
                    option: `p${index}`,
                    label: portion.label,
                    gram_weight: portion.gramWeight ?? null,
                    calories: portion.nutrients.calories ?? null,
                })),
            },
        ],
    };
}

function buildPortionQuestions(
    portions: FoodPortion[],
): Record<string, unknown> {
    const criteria: Record<string, string> = {};
    portions.forEach((portion, index) => {
        const extras: string[] = [];
        if (portion.gramWeight !== undefined && portion.gramWeight !== null) {
            extras.push(`${portion.gramWeight} g`);
        }
        if (
            portion.nutrients.calories !== undefined &&
            portion.nutrients.calories !== null
        ) {
            extras.push(`${portion.nutrients.calories} kcal`);
        }
        criteria[`p${index}`] =
            extras.length > 0
                ? `${portion.label} (${extras.join(", ")})`
                : portion.label;
    });
    return {
        q0: {
            type: "choice",
            instructions: PORTION_INSTRUCTION,
            criteria,
        },
    };
}

type ChoiceParse = number | "none" | null;

/**
 * The fabrication bar, mirroring the S2 decider adapter: only an
 * offered option key (or the explicit "none") is honoured; anything
 * else is unusable and the caller fails open WITHOUT recording it —
 * a garbled answer is not a decision.
 */
function parseChoice(
    answers: Record<string, unknown>,
    pattern: RegExp,
    optionCount: number,
    allowNone: boolean,
): ChoiceParse {
    const answer = answers["q0"];
    if (!answer || typeof answer !== "object") return null;
    const record = answer as Record<string, unknown>;
    if (record.type !== "choice" || typeof record.choice !== "string") {
        return null;
    }
    if (allowNone && record.choice === "none") return "none";
    const match = pattern.exec(record.choice);
    if (!match) return null;
    const index = Number.parseInt(match[1]!, 10);
    return index >= 0 && index < optionCount ? index : null;
}

type DecideOutcome =
    | {
          kind: "pick";
          candidateId: string;
          portionId: string | null;
          model: string;
      }
    | { kind: "abstain"; model: string }
    | { kind: "unusable" }
    | { kind: "failed" };

/**
 * The two Decisions calls inside the seat's total budget. The
 * portion call runs only while budget remains, and its failure
 * never undoes the candidate pick (the natural default stands).
 * Throws nothing: chain exhaustion and budget overrun both return
 * `{kind: "failed"}`.
 */
async function decideSearchIntent(
    query: string,
    shortlist: FoodCandidate[],
    config: DecisionsConfig,
    dependencies: SearchIntentDependencies,
    budgetMs: number,
): Promise<DecideOutcome> {
    const deadline = Date.now() + budgetMs;
    const remainingMs = () => Math.max(1, Math.floor(deadline - Date.now()));
    const models =
        config.searchIntentModels ?? searchIntentModelOrder(config.models);
    const work = (async (): Promise<DecideOutcome> => {
        const candidateCall = await callDecisionsWithFallback(config, {
            seat: "search_intent",
            state: buildCandidateState(query, shortlist),
            questions: buildCandidateQuestions(shortlist),
            timeoutMs: remainingMs(),
            includeImageHeader: false,
            fetcher: dependencies.fetcher,
            models,
        });
        const parsed = parseChoice(
            candidateCall.answers,
            /^c(\d+)$/,
            shortlist.length,
            true,
        );
        if (parsed === "none") {
            return { kind: "abstain", model: candidateCall.model };
        }
        if (parsed === null) return { kind: "unusable" };
        const picked = shortlist[parsed]!;
        let portionId: string | null = null;
        const portions = portionOptions(picked);
        if (portions.length > 0 && Date.now() < deadline) {
            try {
                const portionCall = await callDecisionsWithFallback(config, {
                    seat: "search_intent",
                    state: buildPortionState(query, picked, portions),
                    questions: buildPortionQuestions(portions),
                    timeoutMs: remainingMs(),
                    includeImageHeader: false,
                    fetcher: dependencies.fetcher,
                    models,
                });
                const portionIndex = parseChoice(
                    portionCall.answers,
                    /^p(\d+)$/,
                    portions.length,
                    false,
                );
                if (typeof portionIndex === "number") {
                    portionId = portions[portionIndex]!.id;
                }
            } catch {
                portionId = null;
            }
        }
        return {
            kind: "pick",
            candidateId: encodeFoodCandidateId(picked),
            portionId,
            model: candidateCall.model,
        };
    })();
    // Hard total budget: the seat resolves as failed at the deadline
    // even if a chain attempt is still in flight (each attempt is
    // abort-bounded by its own per-call timeout, so nothing lingers
    // unbounded behind the race). Handlers are attached either way,
    // so a late chain failure never surfaces as unhandled.
    return await new Promise<DecideOutcome>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: "failed" }), budgetMs);
        work.then(
            (outcome) => {
                clearTimeout(timer);
                resolve(outcome);
            },
            () => {
                clearTimeout(timer);
                resolve({ kind: "failed" });
            },
        );
    });
}

function moveToFront(ranked: FoodCandidate[], index: number): FoodCandidate[] {
    if (index <= 0) return ranked;
    const picked = ranked[index]!;
    return [picked, ...ranked.slice(0, index), ...ranked.slice(index + 1)];
}

function untouched(ranked: FoodCandidate[]): SearchIntentResult {
    return {
        candidates: ranked,
        pinnedCandidateId: null,
        pinnedPortionId: null,
    };
}

async function recordPin(
    store: SearchIntentPinStore,
    normalizedQuery: string,
    pin: SearchIntentPinRecord,
): Promise<void> {
    try {
        await store.record(normalizedQuery, pin);
    } catch (error) {
        console.warn(
            `[decisions] seat=search_intent status=pin_record_failed error=${error instanceof Error ? error.message : "unknown"}`,
        );
    }
}

/**
 * Apply the Search Intent seat to one ranked list. Returns the list
 * untouched (same reference) whenever no pin applies.
 */
export async function applySearchIntentSeat(
    query: string,
    ranked: FoodCandidate[],
    dependencies: SearchIntentDependencies = {},
): Promise<SearchIntentResult> {
    const config =
        dependencies.config !== undefined
            ? dependencies.config
            : decisionsConfig();
    if (!config || !searchIntentEnabled(config) || ranked.length === 0) {
        return untouched(ranked);
    }
    const normalizedQuery = normalizeFoodText(
        canonicalizeFoodSearchQuery(query),
    );
    if (!normalizedQuery) return untouched(ranked);
    const store = dependencies.pinStore ?? defaultPinStore();

    let pin: SearchIntentPinRecord | null = null;
    try {
        pin = await store.find(normalizedQuery);
    } catch (error) {
        console.warn(
            `[decisions] seat=search_intent status=pin_lookup_failed error=${error instanceof Error ? error.message : "unknown"}`,
        );
        pin = null;
    }
    if (pin) {
        if (pin.candidateId === null) {
            // Recorded abstention: the ranked list stands, no call.
            return untouched(ranked);
        }
        const index = ranked.findIndex(
            (candidate) => encodeFoodCandidateId(candidate) === pin.candidateId,
        );
        if (index >= 0) {
            const portionId =
                pin.portionId &&
                ranked[index]!.portions.some(
                    (portion) => portion.id === pin.portionId,
                )
                    ? pin.portionId
                    : null;
            return {
                candidates: moveToFront(ranked, index),
                pinnedCandidateId: pin.candidateId,
                pinnedPortionId: portionId,
            };
        }
        // Stale pin (candidate gone from the fresh list): ignore it
        // and re-decide below.
    }

    const shortlist = ranked.slice(0, SEARCH_INTENT_SHORTLIST_LIMIT);
    const outcome = await decideSearchIntent(
        query,
        shortlist,
        config,
        dependencies,
        searchIntentTimeoutMs(config),
    );
    if (outcome.kind === "pick") {
        await recordPin(store, normalizedQuery, {
            candidateId: outcome.candidateId,
            portionId: outcome.portionId,
            model: outcome.model,
        });
        const index = ranked.findIndex(
            (candidate) =>
                encodeFoodCandidateId(candidate) === outcome.candidateId,
        );
        if (index < 0) return untouched(ranked);
        return {
            candidates: moveToFront(ranked, index),
            pinnedCandidateId: outcome.candidateId,
            pinnedPortionId: outcome.portionId,
        };
    }
    if (outcome.kind === "abstain") {
        await recordPin(store, normalizedQuery, {
            candidateId: null,
            portionId: null,
            model: outcome.model,
        });
    }
    return untouched(ranked);
}

/**
 * The web/app search composition (used by `searchAppFoods`): the
 * Search Intent seat first; B2 only when the intent seat applied no
 * pin — off, abstained, or failed open — in which case B2 sees the
 * untouched list and behaves exactly as it does today. The seats
 * never double-decide the same list.
 */
export async function applySearchSeats(
    query: string,
    ranked: FoodCandidate[],
    dependencies: {
        intent?: SearchIntentDependencies;
        match?: MatchDeciderDependencies;
    } = {},
): Promise<SearchIntentResult> {
    const intent = await applySearchIntentSeat(
        query,
        ranked,
        dependencies.intent,
    );
    if (intent.pinnedCandidateId) return intent;
    const candidates = await applyAmbiguousMatchDecider(
        query,
        intent.candidates,
        dependencies.match,
    );
    return { candidates, pinnedCandidateId: null, pinnedPortionId: null };
}
