/**
 * B2 — the ambiguous-match decider for typed adds (jev-accountability
 * audit 2026-11-13, §2 seat B2).
 *
 * Wiring: `searchAppFoods` in `src/app/meal-entry.ts` — the typed
 * composer search whose ranked list every typed selection flows
 * from (`resolveWebMealItem` consumes the candidate_id the user
 * picked from that list). Photo draft-add (`resolveDraftAdd`) goes
 * through the grounding pipeline, whose candidate pick already
 * spends S2's Jev decider inside a SUPERSET of this band
 * (grounding's `isAmbiguous` = low-confidence OR thin margin) on the
 * same Decisions chain — no second seat is built there.
 *
 * MCP is deliberately NOT wired, and the audit's "covered by
 * construction" claim does not survive verification: the host-AI
 * boundary law (src/host-ai-boundary.test.ts; the MCP server
 * instructions' "never route an MCP request through the standalone
 * website AI layer") forbids the MCP dependency graph from reaching
 * website model clients or the OpenRouter credential at all. In
 * MCP, `search_foods` returns the ranked list and the HOST model
 * performs the selection — its tool description already states
 * candidate order is retrieval relevance, not correctness. Wiring
 * B2 into the shared FoodSearchService would break that boundary
 * (it is what the first draft of this seat did; the boundary test
 * caught it, and the seat moved to the web surface).
 *
 * The seat engages ONLY when the deterministic margin is thin — the
 * top two candidates' identity scores (`scoreCandidate`) fall within
 * the ambiguity band the grounding code already defines,
 * `AMBIGUITY_MARGIN` in `src/meal-photo/grounding.ts`. Inside the
 * band, Jev picks from the shortlist through S2's exact adapter
 * (`chooseCandidatesViaDecisions` — same state shape, same wire
 * shape, same fabrication bar) riding the existing Decisions client,
 * so the Jev → `perplexity/pplx-decider-v1.2` fallback chain and
 * per-call `cost_usd` logging are inherited, not re-implemented.
 * The model's pick is promoted to the head of the list; every other
 * candidate keeps its deterministic relative order.
 *
 * Outside the band, with the seat flag off, or with no Decisions
 * config, the list is returned untouched — byte-identical to the
 * pre-seat behaviour. Fail-open: a down chain (or a "none"/unknown
 * verdict) leaves the deterministic top candidate standing, exactly
 * today's behaviour, and the engagement is logged.
 */
import { scoreCandidate } from "../food-providers/ranking.js";
import { encodeFoodCandidateId } from "../food-providers/service.js";
import type { FoodCandidate } from "../food-providers/types.js";
import { AMBIGUITY_MARGIN } from "../meal-photo/grounding.js";
import type { MealPhotoCandidateChoiceRequest } from "../meal-photo/vision.js";
import type { DecisionsFetcher } from "./client.js";
import { decisionsConfig, type DecisionsConfig } from "./config.js";
import { chooseCandidatesViaDecisions } from "./decider.js";

/** Shortlist depth handed to the decider: the full returned search
 * list at the surfaces' default limit (10). Photo grounding slices
 * its own 10-result search to 5 for the Ember tie-break; B2's list
 * IS the search result list the user/MCP client picks from, and the
 * eval (scripts/jev-b2-match-eval.ts) showed the correct generic
 * routinely sits at ranks 6–10 of that list — a top-5 slice would
 * hide exactly the candidates this seat exists to surface. The
 * Decisions adapter and wire shape are S2's, unchanged. */
export const MATCH_SHORTLIST_LIMIT = 10;

export interface MatchDeciderDependencies {
    fetcher?: DecisionsFetcher;
    /** Test/drill seam: supply a config instead of reading the env. */
    config?: DecisionsConfig | null;
}

/**
 * The B2 band, defined once: at least two candidates, and the top
 * two identity scores within `AMBIGUITY_MARGIN` of each other. This
 * is deliberately the margin half of grounding's `isAmbiguous` only —
 * the audit scopes B2 to thin-margin typed adds; the photo pipeline
 * keeps its own (wider) gate for its S2 seat.
 */
export function isWithinAmbiguityBand(
    query: string,
    ranked: FoodCandidate[],
): boolean {
    const top = ranked[0];
    const second = ranked[1];
    if (!top || !second) return false;
    const margin =
        scoreCandidate({ query }, top) - scoreCandidate({ query }, second);
    return margin < AMBIGUITY_MARGIN;
}

/**
 * Reorder `ranked` by the B2 seat. Returns the SAME array reference
 * whenever the seat does not change the outcome (flag off, no
 * config, outside the band, chain down, model picks the current top,
 * model answers "none" or an unknown candidate), so callers can rely
 * on reference equality to mean "deterministic order stands".
 */
export async function applyAmbiguousMatchDecider(
    query: string,
    ranked: FoodCandidate[],
    dependencies: MatchDeciderDependencies = {},
): Promise<FoodCandidate[]> {
    const config =
        dependencies.config !== undefined
            ? dependencies.config
            : decisionsConfig();
    if (!config || !config.matchEnabled) return ranked;
    if (!isWithinAmbiguityBand(query, ranked)) return ranked;

    const shortlist = ranked.slice(0, MATCH_SHORTLIST_LIMIT);
    const request: MealPhotoCandidateChoiceRequest = {
        key: "match:0",
        itemName: query,
        cookingMethod: null,
        candidates: shortlist.map((candidate) => ({
            candidateId: encodeFoodCandidateId(candidate),
            name: candidate.name,
            brand: candidate.brand ?? null,
            provider: candidate.provider,
        })),
    };
    let choice;
    try {
        const choices = await chooseCandidatesViaDecisions([request], config, {
            fetcher: dependencies.fetcher,
            seat: "match",
        });
        choice = choices.get(request.key);
    } catch (error) {
        // Fail-open (fallback law): the deterministic top candidate
        // stands; the seat never blocks or fails a typed add.
        console.info(
            `[decisions] seat=match event=terminal_fallback target=deterministic_top reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
        return ranked;
    }
    if (!choice || !choice.candidateId) return ranked;
    const pickedIndex = shortlist.findIndex(
        (candidate) => encodeFoodCandidateId(candidate) === choice.candidateId,
    );
    if (pickedIndex <= 0) return ranked;
    const picked = shortlist[pickedIndex]!;
    console.info(
        `[decisions] seat=match event=promoted query=${query.slice(0, 80)} picked=${choice.candidateId} confidence=${choice.confidence}`,
    );
    return [
        picked,
        ...ranked.slice(0, pickedIndex),
        ...ranked.slice(pickedIndex + 1),
    ];
}
