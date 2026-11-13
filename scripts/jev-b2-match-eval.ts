/**
 * Seat B2 eval (jev-accountability audit §2; model_eval_validity skill).
 *
 * Call shape: the PRODUCTION shape end to end — real provider
 * adapters (USDA + Open Food Facts) produce real candidates,
 * production `rankCandidates` orders them, production
 * `isWithinAmbiguityBand` (AMBIGUITY_MARGIN from grounding) decides
 * engagement, and production `applyAmbiguousMatchDecider` makes the
 * Decisions call (S2 adapter, existing client, cost_usd logged).
 * Each model is scored SEPARATELY via a single-model chain config —
 * the chain is config, so this is still the production call shape.
 *
 * Fixture provenance: live provider responses at run time (real
 * entries, real panels, adapter-assigned confidences), PLUS the
 * canonical generic entry per plain query from the official USDA
 * SR Legacy dataset (scripts/jev-b2-generics.json, FDC IDs and
 * per-100 g panels from the 2018-04 bulk download, retrieved
 * 2026-11-13). The generics are included because production's pool
 * is catalog + providers — the catalog holds these generics — while
 * the USDA search API under DEMO_KEY sorts Branded first and buries
 * Foundation/SR entries beyond any page size; the generic candidate
 * is shaped exactly as the USDA adapter shapes it (dataKind
 * "generic", confidence 0.82 + completeness*0.12 + 0.04 portion,
 * a single per-100 g portion). Provider responses are cached under
 * /tmp so re-runs respect the DEMO_KEY rate limit.
 * Ground truth
 * is definitional, fixed per case BEFORE any model call: for a plain
 * food query the correct top is the unbranded generic entry for
 * exactly that food; for a brand-named query it is that brand's
 * entry. Cases are split for scoring by whether the DETERMINISTIC
 * top was actually wrong or right (not by intent), giving the
 * correction rate and the false-flip rate the seat is judged on.
 *
 * Pass bar (stated before the run): on in-band cases, each model
 * must correct at least half of the deterministic-wrong tops AND
 * flip at most 1 of the deterministic-right tops. Accuracy is
 * reported against deterministic top-1 on the same in-band set.
 *
 * Run history (2026-11-13, reported openly per the eval skill):
 * run 1 scored 5/9 for both models with 2/6 corrections — but its
 * fixture was flawed twice over: the pool was 35 candidates (the
 * surfaces return 10) and the seat's shortlist was a top-5 slice,
 * so in 4 of 6 deterministic-wrong cases the correct generic sat
 * at ranks 6–18 and the model never saw it. Run 2 fixed the call
 * shape (pool = ranked top 10, shortlist = the full returned list,
 * MATCH_SHORTLIST_LIMIT 10) and is the result of record: both
 * models 9/9 seat top-1 vs 3/9 deterministic, 6/6 corrections,
 * 0/3 false flips. Cases whose generic falls outside the returned
 * top 10 (whole milk, brown rice) are ranking misses — reported,
 * never scored; this eval does not support any claim about them.
 *
 * Requires OPENROUTER_API_KEY. USDA uses USDA_FDC_API_KEY or the
 * public DEMO_KEY. Run: bun scripts/jev-b2-match-eval.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { OpenFoodFactsProvider } from "../src/food-providers/open-food-facts.js";
import { nutrientCompleteness } from "../src/food-providers/nutrients.js";
import { per100gPortion } from "../src/food-providers/portions.js";
import { rankCandidates } from "../src/food-providers/ranking.js";
import type {
    FoodCandidate,
    NutrientValues,
} from "../src/food-providers/types.js";
import { UsdaFoodDataCentralProvider } from "../src/food-providers/usda.js";
import {
    applyAmbiguousMatchDecider,
    isWithinAmbiguityBand,
} from "../src/decisions/match.js";
import type { DecisionsConfig } from "../src/decisions/config.js";

interface EvalCase {
    query: string;
    /** Definitional ground truth: is this candidate the right top? */
    isCorrect: (candidate: FoodCandidate) => boolean;
    truthNote: string;
}

const genericName =
    (...needles: string[]) =>
    (candidate: FoodCandidate) =>
        candidate.provider === "usda" &&
        candidate.dataKind === "generic" &&
        needles.every((needle) =>
            candidate.name.toLowerCase().includes(needle),
        );

const branded = (brand: string) => (candidate: FoodCandidate) =>
    (candidate.brand ?? "").toLowerCase().includes(brand);

const CASES: EvalCase[] = [
    {
        query: "sharp cheddar cheese",
        isCorrect: genericName("cheddar"),
        truthNote: "plain query -> generic cheddar (the audit specimen)",
    },
    {
        query: "peanut butter",
        isCorrect: genericName("peanut", "butter"),
        truthNote: "plain query -> generic peanut butter",
    },
    {
        query: "greek yogurt",
        isCorrect: genericName("yogurt"),
        truthNote: "plain query -> generic Greek yogurt",
    },
    {
        query: "whole milk",
        isCorrect: genericName("milk", "whole"),
        truthNote: "plain query -> generic whole milk",
    },
    {
        query: "orange juice",
        isCorrect: genericName("orange", "juice"),
        truthNote: "plain query -> generic orange juice",
    },
    {
        query: "oatmeal",
        isCorrect: (c) =>
            c.provider === "usda" &&
            c.dataKind === "generic" &&
            (c.name.toLowerCase().includes("oat") ||
                c.name.toLowerCase().includes("oatmeal")),
        truthNote: "plain query -> generic oats/oatmeal",
    },
    {
        query: "nutella hazelnut spread",
        isCorrect: branded("nutella"),
        truthNote: "brand-named query -> the Nutella entry",
    },
    {
        query: "heinz ketchup",
        isCorrect: branded("heinz"),
        truthNote: "brand-named query -> the Heinz entry",
    },
    {
        query: "brown rice",
        isCorrect: genericName("rice", "brown"),
        truthNote: "plain query -> generic brown rice",
    },
    {
        query: "olive oil",
        isCorrect: (c) =>
            c.provider === "usda" &&
            c.dataKind === "generic" &&
            c.name.toLowerCase().includes("olive"),
        truthNote: "plain query -> generic olive oil",
    },
    {
        query: "chicken breast",
        isCorrect: genericName("chicken", "breast"),
        truthNote: "plain query -> generic chicken breast",
    },
    {
        query: "canned black beans",
        isCorrect: genericName("beans", "black"),
        truthNote: "plain query -> generic black beans",
    },
];

const MODELS = ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"];

function configFor(model: string, apiKey: string): DecisionsConfig {
    return {
        apiKey,
        apiUrl: "https://openrouter.ai/api/alpha/decisions",
        models: [model],
        gateTimeoutMs: 10_000,
        deciderTimeoutMs: 10_000,
        matchTimeoutMs: 10_000,
        gateEnabled: false,
        deciderEnabled: false,
        matchEnabled: true,
    };
}

async function main() {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
    const usda = new UsdaFoodDataCentralProvider({
        apiKey: process.env.USDA_FDC_API_KEY?.trim() || "DEMO_KEY",
        timeoutMs: 15_000,
    });
    const off = new OpenFoodFactsProvider({
        userAgent: "MunchEval/1.0 (jev-b2-match-eval)",
        timeoutMs: 15_000,
    });

    // Capture the client's own cost_usd log lines as the cost record.
    const costLines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
        const line = args.map(String).join(" ");
        if (line.includes("[decisions]")) costLines.push(line);
        originalInfo(...args);
    };

    interface Prepared {
        evalCase: EvalCase;
        ranked: FoodCandidate[];
        inBand: boolean;
        detTopCorrect: boolean;
        expectedPresent: boolean;
    }
    // Canonical generics (SR Legacy bulk data) shaped as the USDA
    // adapter shapes them — see the provenance note in the header.
    const generics = JSON.parse(
        readFileSync(
            new URL("./jev-b2-generics.json", import.meta.url),
            "utf8",
        ),
    ) as Record<
        string,
        { fdc_id: string; name: string; nutrients_per_100g: NutrientValues }
    >;
    const genericFor = (query: string): FoodCandidate | null => {
        const entry = generics[query];
        if (!entry) return null;
        const nutrients = entry.nutrients_per_100g;
        return {
            provider: "usda",
            providerFoodId: entry.fdc_id,
            name: entry.name.replace(
                " (Includes foods for USDA's Food Distribution Program)",
                "",
            ),
            dataKind: "generic",
            nutrientsPer100g: nutrients,
            portions: [per100gPortion(nutrients)],
            attribution: { label: "USDA FoodData Central" },
            confidence:
                Math.round(
                    (0.82 + nutrientCompleteness(nutrients) * 0.12 + 0.04) *
                        100,
                ) / 100,
        };
    };

    // /tmp cache for provider responses (DEMO_KEY rate limits).
    const cachePath = "/tmp/jev-b2-provider-cache.json";
    const cache: Record<string, FoodCandidate[]> = existsSync(cachePath)
        ? JSON.parse(readFileSync(cachePath, "utf8"))
        : {};
    const cachedSearch = async (
        providerName: string,
        search: () => Promise<FoodCandidate[]>,
        query: string,
    ): Promise<FoodCandidate[]> => {
        const key = `${providerName}:${query}`;
        if (cache[key]) return cache[key];
        const hits = await search();
        if (hits.length > 0) {
            cache[key] = hits;
            writeFileSync(cachePath, JSON.stringify(cache));
        }
        return hits;
    };

    const prepared: Prepared[] = [];
    for (const evalCase of CASES) {
        // Adapter-max page (25): the USDA adapter sorts by dataType
        // (Branded first), so a small page buries the generic
        // Foundation/SR entries that production's catalog+provider
        // pool contains. Fetch errors are logged, never swallowed.
        const [usdaHits, offHits] = await Promise.all([
            cachedSearch(
                "usda",
                () =>
                    usda
                        .search({ query: evalCase.query, limit: 25 })
                        .catch((error) => {
                            originalInfo(
                                `[fixture-error] usda query="${evalCase.query}" ${String(error).slice(0, 160)}`,
                            );
                            return [] as FoodCandidate[];
                        }),
                evalCase.query,
            ),
            cachedSearch(
                "off",
                () =>
                    off
                        .search({ query: evalCase.query, limit: 10 })
                        .catch((error) => {
                            originalInfo(
                                `[fixture-error] off query="${evalCase.query}" ${String(error).slice(0, 160)}`,
                            );
                            return [] as FoodCandidate[];
                        }),
                evalCase.query,
            ),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const generic = genericFor(evalCase.query);
        if (generic) {
            const already = usdaHits.some(
                (c) => c.providerFoodId === generic.providerFoodId,
            );
            if (!already) usdaHits.push(generic);
        }
        // Production-shaped pool: the surfaces call search with the
        // default limit 10, so the seat sees the ranked top 10 —
        // candidates below that are ranking misses the seat cannot
        // address and are reported as such, never scored as flips.
        const ranked = rankCandidates({ query: evalCase.query }, [
            ...usdaHits,
            ...offHits,
        ]).slice(0, 10);
        prepared.push({
            evalCase,
            ranked,
            inBand: isWithinAmbiguityBand(evalCase.query, ranked),
            detTopCorrect: ranked[0] ? evalCase.isCorrect(ranked[0]) : false,
            expectedPresent: ranked.some((c) => evalCase.isCorrect(c)),
        });
        originalInfo(
            `[fixture] query="${evalCase.query}" candidates=${ranked.length} top="${ranked[0]?.brand ?? ""} ${ranked[0]?.name ?? "none"}" det_top_correct=${ranked[0] ? evalCase.isCorrect(ranked[0]) : false} in_band=${isWithinAmbiguityBand(evalCase.query, ranked)} expected_present=${ranked.some((c) => evalCase.isCorrect(c))}`,
        );
    }

    const inBand = prepared.filter((p) => p.inBand && p.expectedPresent);
    originalInfo(
        `\nIn-band scorable cases: ${inBand.length}/${prepared.length} (pass bar: >=50% corrections of det-wrong, <=1 false flip of det-right, per model)`,
    );

    for (const model of MODELS) {
        let correct = 0;
        let corrections = 0;
        let detWrong = 0;
        let flips = 0;
        let detRight = 0;
        let detCorrect = 0;
        const costsBefore = costLines.length;
        const started = Date.now();
        for (const p of inBand) {
            if (p.detTopCorrect) {
                detRight += 1;
                detCorrect += 1;
            } else {
                detWrong += 1;
            }
            const result = await applyAmbiguousMatchDecider(
                p.evalCase.query,
                p.ranked,
                { config: configFor(model, apiKey) },
            );
            const pick = result[0];
            const pickCorrect = pick ? p.evalCase.isCorrect(pick) : false;
            if (pickCorrect) correct += 1;
            if (!p.detTopCorrect && pickCorrect) corrections += 1;
            if (p.detTopCorrect && !pickCorrect) flips += 1;
            originalInfo(
                `[eval] model=${model} query="${p.evalCase.query}" det_top_correct=${p.detTopCorrect} seat_pick="${pick?.brand ?? ""} ${pick?.name ?? "none"}" pick_correct=${pickCorrect}`,
            );
        }
        const modelCosts = costLines
            .slice(costsBefore)
            .map((line) => /cost_usd=([0-9.]+)/.exec(line)?.[1])
            .filter(Boolean)
            .map(Number);
        const totalCost = modelCosts.reduce((a, b) => a + b, 0);
        originalInfo(
            `[summary] model=${model} in_band=${inBand.length} deterministic_top1=${detCorrect}/${inBand.length} seat_top1=${correct}/${inBand.length} corrections=${corrections}/${detWrong} false_flips=${flips}/${detRight} calls=${modelCosts.length} total_cost_usd=${totalCost.toFixed(6)} mean_cost_usd=${modelCosts.length ? (totalCost / modelCosts.length).toFixed(6) : "n/a"} wall_ms=${Date.now() - started}`,
        );
    }
}

await main();
