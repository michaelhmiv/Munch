/**
 * C3 chat-claims eval (Jev accountability audit §2 seat C3; ship gate:
 * EVAL BEFORE PR, per the model_eval_validity skill).
 *
 * WHAT THIS MEASURES: the production C3 check (`checkChatClaims` in
 * src/decisions/chat-claims.ts — the exact state builder, question
 * set, answer parsing, and Decisions client the seat ships with),
 * scored PER MODEL: the primary `typesafe/jev-1.14` alone, then the
 * designated fallback `perplexity/pplx-decider-v1.2` alone. Each
 * model is exercised through a single-model Decisions chain so its
 * own score distribution (and therefore its own threshold) is
 * measured, never borrowed from the other model.
 *
 * FIXTURE PROVENANCE: fixtures are constructed in the exact shapes
 * production produces — tool-result texts in the JSON shapes the
 * chat executor returns (search candidates, range totals, draft
 * reviews) and the slim context JSON of src/chat/context.ts. Ground
 * truth is BY CONSTRUCTION, not hand-labelled model output: the
 * "unsourced" numbers were planted by the fixture author in values
 * that appear in no sourced text, and every "derived" expectation
 * states its arithmetic in the fixture (per-serving division, sum,
 * percentage, unit conversion, per-100g scaling). This is a small
 * constructed fixture, not a sample of real user chats — it can
 * show the mechanism discriminates planted vs derived numbers in
 * production-shaped exchanges; it cannot estimate the production
 * unsourced-claim rate (that is what the shipped log-only seat
 * measures).
 *
 * PASS BAR (stated before the run): per model, catch rate on
 * planted unsourced claims ≥ 75% AND false-accusation rate on
 * sourced claims ≤ 15%, with all no-claim replies skipped at zero
 * calls. A model under the bar does not sink the seat (the chain's
 * other model may carry it), but its threshold/role must be
 * reported, not hidden.
 *
 * Knobs (env): OPENROUTER_API_KEY (required, exit 2 without it),
 * C3EVAL_OUT (default ./chat-claims-eval-report).
 * Costs are the API-reported usage.cost figures from the production
 * client; latencies are the client's own duration_ms.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkChatClaims } from "../src/decisions/chat-claims.js";
import type { DecisionsConfig } from "../src/decisions/config.js";

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("[c3eval] OPENROUTER_API_KEY is required.");
    process.exit(2);
}
const API_KEY = process.env.OPENROUTER_API_KEY.trim();
const OUT =
    process.env.C3EVAL_OUT ?? join(process.cwd(), "chat-claims-eval-report");
const MODELS = ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"];

interface Fixture {
    id: string;
    kind: "unsourced" | "sourced" | "no_claims";
    /** Sourced texts as the seat receives them: context JSON + tool results. */
    sourcedTexts: string[];
    reply: string;
    /** Claims (raw tokens) that MUST be judged unsourced. */
    expectUnsourced: string[];
    /** Claims that MUST NOT be judged unsourced. */
    expectSourced: string[];
    note: string;
}

const CONTEXT_500 = JSON.stringify({
    date: "2026-11-10",
    timezone: "America/New_York",
    sections: ["today_totals"],
    goals: null,
    today: {
        totals: {
            calories: 500,
            proteinG: 30,
            carbsG: 50,
            fatG: 15,
            fiberG: 4,
        },
    },
});

const FIXTURES: Fixture[] = [
    // ------------------------------------------------ unsourced (planted)
    {
        id: "U1-invented-sugar",
        kind: "unsourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({
                candidates: [
                    {
                        name: "Greek yogurt, plain",
                        calories: 150,
                        protein_g: 17,
                        sugar_g: 6,
                    },
                ],
            }),
        ],
        reply: "Your Greek yogurt was 150 kcal with 17 g of protein and 42 g of sugar.",
        expectUnsourced: ["42"],
        expectSourced: ["150", "17"],
        note: "42 g sugar planted; the sourced sugar is 6 g, never quoted.",
    },
    {
        id: "U2-invented-remaining",
        kind: "unsourced",
        sourcedTexts: [CONTEXT_500],
        reply: "You're at 500 kcal so far, which leaves you only 800 kcal for the rest of the day.",
        expectUnsourced: ["800"],
        expectSourced: ["500"],
        note: "No goal exists in context, so no remainder can be derived; 800 is invented.",
    },
    {
        id: "U3-invented-protein-total",
        kind: "unsourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({
                start_date: "2026-10-01",
                end_date: "2026-10-31",
                meal_count: 58,
                total_calories: 61200,
            }),
        ],
        reply: "Last month you logged 58 meals totalling 61,200 kcal and 312 g of protein.",
        expectUnsourced: ["312"],
        expectSourced: ["58", "61,200"],
        note: "Protein never appears in the range result; 312 is planted.",
    },
    {
        id: "U4-invented-fiber",
        kind: "unsourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({
                name: "Chicken breast",
                per_100g: { calories: 165, protein_g: 31, fat_g: 3.6 },
            }),
        ],
        reply: "Chicken breast has 165 kcal and 31 g of protein per 100 g, plus 12 g of fiber.",
        expectUnsourced: ["12"],
        expectSourced: ["165", "31", "100"],
        note: "Fiber is absent from the sourced profile; 12 is planted.",
    },
    {
        id: "U5-invented-sodium",
        kind: "unsourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({
                pantry: [
                    { name: "Tomato soup", quantity: 2, unit: "can" },
                    { name: "Rice", quantity: 1, unit: "bag" },
                ],
            }),
        ],
        reply: "You have 2 cans of tomato soup — each one has 890 mg of sodium, so go easy.",
        expectUnsourced: ["890"],
        expectSourced: ["2"],
        note: "The pantry result carries quantities only; 890 mg sodium is planted.",
    },
    {
        id: "U6-wrong-derivation",
        kind: "unsourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({ review: { total_calories: 1840, servings: 4 } }),
        ],
        reply: "The recipe totals 1,840 kcal for 4 servings — 460 kcal per serving, or just 210 kcal for a half portion.",
        expectUnsourced: ["210"],
        expectSourced: ["1,840", "4", "460"],
        note: "460 = 1840/4 is derived; a half portion is 230, so 210 is a wrong (unsourced) figure.",
    },
    {
        id: "U7-invented-weight-change",
        kind: "unsourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({
                latest_weight: { value: 180, unit: "lb", date: "2026-11-10" },
            }),
        ],
        reply: "You're at 180 lb — that's down 14 lb from last month, great progress.",
        expectUnsourced: ["14"],
        expectSourced: ["180"],
        note: "No earlier weight was returned; the 14 lb change is planted.",
    },
    {
        id: "U8-invented-water-need",
        kind: "unsourced",
        sourcedTexts: [CONTEXT_500, JSON.stringify({ water_today_ml: 1250 })],
        reply: "You've had 1,250 ml of water today, so you need 900 ml more to hit your goal.",
        expectUnsourced: ["900"],
        expectSourced: ["1,250"],
        note: "No water goal exists in the sourced values; 900 is planted.",
    },
    // ------------------------------------------------ sourced (incl. derived)
    {
        id: "S1-exact-quote",
        kind: "sourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({
                candidates: [
                    {
                        name: "Greek yogurt, plain",
                        calories: 150,
                        protein_g: 17,
                    },
                ],
            }),
        ],
        reply: "Your Greek yogurt comes to 150 kcal with 17 g of protein.",
        expectUnsourced: [],
        expectSourced: ["150", "17"],
        note: "Exact quotes of tool values.",
    },
    {
        id: "S2-rounding",
        kind: "sourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({
                meal: { name: "Burrito bowl", calories: 1847, protein_g: 30.4 },
            }),
        ],
        reply: "That burrito bowl was roughly 1,850 kcal with about 30 g of protein.",
        expectUnsourced: [],
        expectSourced: ["1,850", "30"],
        note: "Rounding: 1847 → ~1,850; 30.4 → ~30.",
    },
    {
        id: "S3-per-serving",
        kind: "sourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({ review: { total_calories: 1840, servings: 4 } }),
        ],
        reply: "Across 4 servings that's 460 kcal per serving.",
        expectUnsourced: [],
        expectSourced: ["4", "460"],
        note: "Per-serving derivation: 1840 / 4 = 460.",
    },
    {
        id: "S4-percentage-of-goal",
        kind: "sourced",
        sourcedTexts: [
            JSON.stringify({
                date: "2026-11-10",
                timezone: "America/New_York",
                sections: ["goals", "today_totals"],
                goals: {
                    daily_calories: 2000,
                    daily_protein_g: 120,
                    daily_carbs_g: null,
                    daily_fat_g: null,
                    daily_fiber_g: null,
                },
                today: {
                    totals: {
                        calories: 500,
                        proteinG: 30,
                        carbsG: 50,
                        fatG: 15,
                        fiberG: 4,
                    },
                },
            }),
        ],
        reply: "You've hit 25% of your 120 g protein goal so far today.",
        expectUnsourced: [],
        expectSourced: ["25%", "120"],
        note: "Percentage derivation: 30 / 120 = 25%.",
    },
    {
        id: "S5-unit-conversion",
        kind: "sourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({ name: "Tomato soup", sodium_mg: 1500 }),
        ],
        reply: "That soup carries 1.5 g of sodium per can.",
        expectUnsourced: [],
        expectSourced: ["1.5"],
        note: "Unit conversion: 1500 mg = 1.5 g.",
    },
    {
        id: "S6-sum",
        kind: "sourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({
                meals: [
                    { name: "Oatmeal", calories: 500 },
                    { name: "Salad", calories: 320 },
                ],
            }),
        ],
        reply: "Oatmeal (500 kcal) plus the salad (320 kcal) puts those two meals at 820 kcal together.",
        expectUnsourced: [],
        expectSourced: ["500", "320", "820"],
        note: "Sum derivation: 500 + 320 = 820.",
    },
    {
        id: "S7-context-remainder",
        kind: "sourced",
        sourcedTexts: [
            JSON.stringify({
                date: "2026-11-10",
                timezone: "America/New_York",
                sections: ["goals", "today_totals"],
                goals: {
                    daily_calories: 2000,
                    daily_protein_g: 120,
                    daily_carbs_g: null,
                    daily_fat_g: null,
                    daily_fiber_g: null,
                },
                today: {
                    totals: {
                        calories: 500,
                        proteinG: 30,
                        carbsG: 50,
                        fatG: 15,
                        fiberG: 4,
                    },
                },
            }),
        ],
        reply: "You're at 500 of your 2,000 kcal goal, so about 1,500 kcal left today.",
        expectUnsourced: [],
        expectSourced: ["500", "2,000", "1,500"],
        note: "Remainder derivation from context only: 2000 - 500 = 1,500.",
    },
    {
        id: "S8-per-100g-scaling",
        kind: "sourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({
                name: "Chicken breast",
                per_100g: { calories: 165, protein_g: 31 },
                portion_g: 200,
            }),
        ],
        reply: "For your 200 g portion of chicken breast, that's 330 kcal and 62 g of protein.",
        expectUnsourced: [],
        expectSourced: ["200", "330", "62"],
        note: "Scaling derivation: 165 x 2 = 330; 31 x 2 = 62.",
    },
    {
        id: "S9-dates-and-enumeration",
        kind: "sourced",
        sourcedTexts: [
            CONTEXT_500,
            JSON.stringify({
                start_date: "2026-10-01",
                end_date: "2026-10-07",
                meal_count: 19,
                total_calories: 12800,
            }),
        ],
        reply: "Looking at Oct 1 to Oct 7, I see 3 patterns in your 19 logged meals worth mentioning.",
        expectUnsourced: [],
        expectSourced: ["1", "7", "3", "19"],
        note: "Dates (1, 7) and an enumeration count (3) are not nutrition claims; 19 is exact.",
    },
    {
        id: "S10-macro-share",
        kind: "sourced",
        sourcedTexts: [CONTEXT_500],
        reply: "Fat is about 27% of today's 500 kcal so far.",
        expectUnsourced: [],
        expectSourced: ["27%", "500"],
        note: "Macro-share derivation: 15 g fat x 9 kcal/g = 135; 135 / 500 = 27%.",
    },
    // ------------------------------------------------ no numeric claims
    {
        id: "N1-no-claims",
        kind: "no_claims",
        sourcedTexts: [CONTEXT_500],
        reply: "Sounds like a solid lunch — a nice balance overall.",
        expectUnsourced: [],
        expectSourced: [],
        note: "No numbers: the seat must skip at zero calls.",
    },
    {
        id: "N2-no-claims",
        kind: "no_claims",
        sourcedTexts: [CONTEXT_500],
        reply: "Want me to save that as a usual meal for next time?",
        expectUnsourced: [],
        expectSourced: [],
        note: "No numbers: the seat must skip at zero calls.",
    },
    {
        id: "N3-no-claims",
        kind: "no_claims",
        sourcedTexts: [CONTEXT_500],
        reply: "That recipe looks great for a weeknight, and it uses things you already have.",
        expectUnsourced: [],
        expectSourced: [],
        note: "No numbers: the seat must skip at zero calls.",
    },
    {
        id: "N4-no-claims",
        kind: "no_claims",
        sourcedTexts: [CONTEXT_500],
        reply: "I found a few pantry options that would work well together for dinner.",
        expectUnsourced: [],
        expectSourced: [],
        note: "No numbers: the seat must skip at zero calls.",
    },
];

function configFor(model: string): DecisionsConfig {
    return {
        apiKey: API_KEY,
        apiUrl: "https://openrouter.ai/api/alpha/decisions",
        models: [model],
        gateTimeoutMs: 1_500,
        deciderTimeoutMs: 2_000,
        gateEnabled: true,
        deciderEnabled: true,
        chatClaimsEnabled: true,
        chatClaimsTimeoutMs: 10_000,
    };
}

interface ClaimScore {
    fixture: string;
    claim: string;
    expected: "sourced" | "unsourced";
    verdict: string;
    probability: number | null;
    correct: boolean;
}

async function main(): Promise<void> {
    await mkdir(OUT, { recursive: true });
    const report: Record<string, unknown> = { models: {} };
    for (const model of MODELS) {
        const scores: ClaimScore[] = [];
        const fixtureResults: Array<Record<string, unknown>> = [];
        let totalCost = 0;
        let totalDuration = 0;
        let calls = 0;
        for (const fixture of FIXTURES) {
            const outcome = await checkChatClaims(
                { reply: fixture.reply, sourcedTexts: fixture.sourcedTexts },
                configFor(model),
            );
            const verdictByClaim = new Map<
                string,
                { verdict: string; probability: number | null }
            >();
            if (outcome.status === "checked") {
                calls += 1;
                totalCost += outcome.reportedCostUsd ?? 0;
                totalDuration += outcome.durationMs;
                for (const claim of outcome.claims) {
                    verdictByClaim.set(claim.claim, {
                        verdict: claim.verdict,
                        probability: claim.probability,
                    });
                }
            }
            for (const raw of fixture.expectUnsourced) {
                const got = verdictByClaim.get(raw);
                scores.push({
                    fixture: fixture.id,
                    claim: raw,
                    expected: "unsourced",
                    verdict: got?.verdict ?? outcome.status,
                    probability: got?.probability ?? null,
                    correct: got?.verdict === "unsourced",
                });
            }
            for (const raw of fixture.expectSourced) {
                const got = verdictByClaim.get(raw);
                scores.push({
                    fixture: fixture.id,
                    claim: raw,
                    expected: "sourced",
                    verdict: got?.verdict ?? outcome.status,
                    probability: got?.probability ?? null,
                    correct: got?.verdict === "sourced",
                });
            }
            fixtureResults.push({
                fixture: fixture.id,
                kind: fixture.kind,
                outcome: outcome.status,
                ...(outcome.status === "checked"
                    ? {
                          model: outcome.model,
                          costUsd: outcome.reportedCostUsd,
                          durationMs: outcome.durationMs,
                      }
                    : {}),
            });
            console.log(
                `[c3eval] model=${model} fixture=${fixture.id} outcome=${outcome.status}`,
            );
        }
        const planted = scores.filter(
            (score) => score.expected === "unsourced",
        );
        const sourced = scores.filter((score) => score.expected === "sourced");
        const caught = planted.filter((score) => score.correct).length;
        const falselyAccused = sourced.filter((score) => !score.correct).length;
        const noClaimFixtures = fixtureResults.filter(
            (entry) => entry.kind === "no_claims",
        );
        const summary = {
            model,
            plantedUnsourced: planted.length,
            caught,
            catchRate: planted.length ? caught / planted.length : null,
            sourcedClaims: sourced.length,
            falselyAccused,
            falseAccusationRate: sourced.length
                ? falselyAccused / sourced.length
                : null,
            noClaimFixturesSkipped: noClaimFixtures.filter(
                (entry) => entry.outcome === "skipped",
            ).length,
            noClaimFixturesTotal: noClaimFixtures.length,
            decisionsCalls: calls,
            totalCostUsd: totalCost,
            meanDurationMs: calls ? Math.round(totalDuration / calls) : null,
            passBar: { catchRateMin: 0.75, falseAccusationRateMax: 0.15 },
            passesBar:
                (planted.length ? caught / planted.length : 0) >= 0.75 &&
                (sourced.length ? falselyAccused / sourced.length : 0) <= 0.15,
        };
        (report.models as Record<string, unknown>)[model] = {
            summary,
            scores,
            fixtures: fixtureResults,
        };
        console.log(`[c3eval] ${JSON.stringify(summary)}`);
    }
    await writeFile(join(OUT, "results.json"), JSON.stringify(report, null, 2));
    console.log(`[c3eval] report written to ${join(OUT, "results.json")}`);
}

await main();
