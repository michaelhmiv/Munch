/**
 * A2b — recipe YIELD estimate (Jev accountability program, Michael's
 * ruling 2026-11-13: the yield defaults to an estimate — "people
 * won't do that" — and Jev does the estimating). It serves recipe
 * unit logging: log by cup/grams against the yield.
 *
 * THE SEPARATION (held clean in the state/verdict shape):
 * - The ANCHOR is code's arithmetic: the sum of the resolver's
 *   per-ingredient gram weights, plus the summed volume of the
 *   volume-measured ingredients. Deterministic, exported, pure.
 * - The ADJUSTMENT is the model's judgment: cooking effects the
 *   anchor cannot see — pasta/rice absorbing unlisted parboil water,
 *   sauces reducing, cheese melting into a sauce. Jev picks an
 *   adjustment BAND for weight (and for volume, when an anchor
 *   volume exists); code multiplies. The model never does the
 *   arithmetic; code never invents the adjustment.
 *
 * WHERE: at recipe save/revision, in the same `resolutionReview`
 * hook chain as A1/A2 (composed after them, so the anchor reads the
 * final gram weights, including A2's labelled estimates). Rides the
 * existing Decisions client — Jev → Perplexity fallback, `cost_usd`
 * logging inherited.
 *
 * STORAGE + THE PERMANENCE LAW: the estimate is stored on the recipe
 * as `yield_estimate` with provenance {source: "estimate", model,
 * anchor values, adjustment factors, adjusted values}. It is
 * user-adjustable, and a USER CORRECTION PERMANENTLY REPLACES IT:
 * when the recipe already carries a user-set yield
 * (`source: "user"`), this seat makes ZERO calls and never touches
 * it — no save, revision, or recalculate may overwrite a user yield
 * with a fresh estimate. An estimate may only fill a yield that was
 * never user-set, and may refresh on revision only while it remains
 * an uncorrected estimate. It stays labelled either way.
 *
 * FAIL-OPEN: flag off, no config, no computable anchor, a down
 * chain, an unparseable answer, or a not-defensible verdict → the
 * recipe simply has no (new) yield estimate; nothing blocks a save.
 *
 * PRIVACY: the state carries ingredient names/quantities and the
 * recipe's method/instruction text — the categories the privacy page
 * already discloses for AI features ("food names, quantities,
 * nutrition numbers, and the text of your request"). No identity,
 * no image data.
 */
import type {
    RecipeNutritionResolution,
    RecipeYieldEstimate,
} from "../recipe-nutrition-resolution.js";
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    decisionsConfig,
    yieldDefensibleThresholdForModel,
    yieldEstimateEnabled,
    yieldEstimateTimeoutMs,
    type DecisionsConfig,
} from "./config.js";
import { noulProbability } from "./gate.js";

/** Exact millilitres per volume unit — mirrors the resolver's table
 * so both convert identically. */
const VOLUME_TO_ML: Record<string, number> = {
    ml: 1,
    l: 1_000,
    tsp: 4.92892159,
    tbsp: 14.7867648,
    "fl oz": 29.5735296,
    cup: 236.5882365,
    pint: 473.176473,
    quart: 946.352946,
    gallon: 3785.41178,
};

const VOLUME_UNIT_ALIASES: Record<string, string> = {
    cups: "cup",
    tablespoons: "tbsp",
    tablespoon: "tbsp",
    teaspoons: "tsp",
    teaspoon: "tsp",
    milliliters: "ml",
    millilitres: "ml",
    liters: "l",
    litres: "l",
    "fluid ounce": "fl oz",
    "fluid ounces": "fl oz",
    pints: "pint",
    quarts: "quart",
    gallons: "gallon",
};

function volumeMlFor(
    unit: string | undefined,
    quantity: number,
): number | null {
    if (!unit) return null;
    const normalized = unit.trim().toLowerCase().replace(/\s+/g, " ");
    const key = VOLUME_TO_ML[normalized]
        ? normalized
        : VOLUME_UNIT_ALIASES[normalized];
    if (!key) return null;
    return quantity * VOLUME_TO_ML[key]!;
}

export interface YieldAnchor {
    /** Sum of the resolver's per-ingredient gram weights. */
    weight_g: number | null;
    /** Summed volume of the volume-measured ingredients. */
    volume_ml: number | null;
    /** Ingredients carrying a gram weight / all ingredients. */
    weight_coverage: number;
}

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

/**
 * THE ANCHOR — deterministic, pure, exported for tests and for the
 * unit-logging surface that will display "estimated from
 * ingredients". No model involved.
 */
export function computeYieldAnchor(
    resolution: RecipeNutritionResolution,
): YieldAnchor {
    let weight = 0;
    let weighed = 0;
    let volume = 0;
    let hasVolume = false;
    const ingredients = resolution.recipe.ingredients;
    for (const ingredient of ingredients) {
        if (
            typeof ingredient.gram_weight === "number" &&
            ingredient.gram_weight > 0
        ) {
            weight += ingredient.gram_weight;
            weighed += 1;
        }
        if (
            typeof ingredient.quantity === "number" &&
            ingredient.quantity > 0
        ) {
            const ml = volumeMlFor(ingredient.unit, ingredient.quantity);
            if (ml !== null) {
                volume += ml;
                hasVolume = true;
            }
        }
    }
    return {
        weight_g: weighed > 0 ? round1(weight) : null,
        volume_ml: hasVolume ? round1(volume) : null,
        weight_coverage:
            ingredients.length > 0 ? weighed / ingredients.length : 0,
    };
}

const METHOD_CUE_PATTERNS: Array<[RegExp, string]> = [
    [/\bparboil/i, "parboil"],
    [/\bboil/i, "boil"],
    [/\bsimmer/i, "simmer"],
    [/\breduc/i, "reduce"],
    [/\bbak(e|ing|ed)\b/i, "bake"],
    [/\broast/i, "roast"],
    [/\bmelt/i, "melt"],
    [/\bfry|fried|sauté|saute/i, "fry"],
    [/\bdrain/i, "drain"],
    [/\bsoak/i, "soak"],
    [/\bsteam/i, "steam"],
    [/\bgrill/i, "grill"],
];

/** Deterministic cue extraction: code reports which method words
 * the instructions contain; the model judges what they do to the
 * yield. */
export function extractMethodCues(instructions: string[]): string[] {
    const text = instructions.join("\n");
    const cues: string[] = [];
    for (const [pattern, cue] of METHOD_CUE_PATTERNS) {
        if (pattern.test(text)) cues.push(cue);
    }
    return cues;
}

export function extractPanSize(instructions: string[]): string | null {
    const text = instructions.join(" ");
    const match =
        /(\d+(?:\.\d+)?\s*(?:x|×|by)\s*\d+(?:\.\d+)?\s*(?:inch|in|cm)?)/i.exec(
            text,
        ) ??
        /(\d+(?:\.\d+)?\s*[- ]\s*(?:inch|quart|qt|liter|litre)\b[^,.]*)/i.exec(
            text,
        );
    return match ? match[1]!.trim() : null;
}

/** Adjustment bands the model may pick, as factors of the anchor. */
export const YIELD_ADJUSTMENT_FACTORS = [
    0.35, 0.5, 0.65, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
] as const;

function factorKey(factor: number): string {
    return `f${Math.round(factor * 100)}`;
}

function bandCriteria(): Record<string, string> {
    const descriptions: Record<string, string> = {
        f35: "About a third of the anchor — a hard reduction (a sauce reduced to a glaze) or most of the mass discarded.",
        f50: "About half the anchor — a sauce reduced by half, or heavy draining/discarding.",
        f65: "About two-thirds of the anchor — noticeable reduction or draining losses.",
        f80: "About 80% of the anchor — modest evaporation/reduction during cooking.",
        f90: "About 90% of the anchor — slight evaporation; nearly everything served.",
        f100: "Essentially the anchor — cooking neither adds nor removes meaningful mass/volume (melting, mixing, gentle heating).",
        f110: "About 10% above the anchor — slight absorption of cooking liquid.",
        f125: "About 25% above the anchor — moderate absorption (grains or pasta taking up some unlisted water).",
        f150: "About 50% above the anchor — substantial absorption of unlisted cooking water.",
        f175: "About 75% above the anchor — heavy absorption, typical of parboiled pasta dishes where the pasta's water is not an ingredient.",
        f200: "About double the anchor — very heavy absorption (dry pasta/rice cooked in abundant unlisted water, most of it absorbed).",
        f250: "About two and a half times the anchor — extreme absorption for dry grains.",
        f300: "About triple the anchor — the maximum plausible absorption for dry rice/grains.",
    };
    return descriptions;
}

export interface YieldEstimateDependencies {
    fetcher?: DecisionsFetcher;
    /** Test/drill seam: supply a config instead of reading the env. */
    config?: DecisionsConfig | null;
}

export interface YieldEstimateResult {
    status:
        "disabled" | "user_set" | "unchecked" | "not_defensible" | "estimated";
    yieldEstimate: RecipeYieldEstimate | null;
    model: string | null;
    reportedCostUsd: number | null;
    /** p(defensible) when the model answered, for eval/reporting. */
    probability?: number | null;
}

function choiceFactor(
    answers: Record<string, unknown>,
    question: string,
): number | null {
    const answer = answers[question] as Record<string, unknown> | undefined;
    if (
        !answer ||
        answer.type !== "choice" ||
        typeof answer.choice !== "string"
    ) {
        return null;
    }
    const factor = YIELD_ADJUSTMENT_FACTORS.find(
        (candidate) => factorKey(candidate) === answer.choice,
    );
    return factor ?? null;
}

/**
 * The seat's core: anchor + state → one Decisions call → verdict.
 * Exported for the eval (production call shape) and tests. Never
 * throws.
 */
export async function estimateYieldForResolution(
    resolution: RecipeNutritionResolution,
    dependencies: YieldEstimateDependencies = {},
): Promise<YieldEstimateResult> {
    const unchanged = (
        status: YieldEstimateResult["status"],
    ): YieldEstimateResult => ({
        status,
        yieldEstimate: null,
        model: null,
        reportedCostUsd: null,
    });
    try {
        const existing = resolution.recipe.yield_estimate ?? null;
        if (existing?.source === "user") return unchanged("user_set");
        const config =
            dependencies.config !== undefined
                ? dependencies.config
                : decisionsConfig();
        if (!config || !yieldEstimateEnabled(config)) {
            return unchanged("disabled");
        }
        const anchor = computeYieldAnchor(resolution);
        if (anchor.weight_g === null && anchor.volume_ml === null) {
            return unchanged("unchecked");
        }
        const instructions = resolution.recipe.instructions ?? [];
        const cues = extractMethodCues(instructions);
        const panSize = extractPanSize(instructions);
        const questions: Record<string, unknown> = {
            defensible: {
                type: "noul",
                instructions:
                    "Is a cooking-adjusted yield estimate defensible for this recipe — do the ingredients and the STATED method determine the finished dish's yield closely enough that an estimate would be useful rather than a fabrication? Cooking effects whose method IS stated are exactly what the estimate exists to price: pasta or rice parboiled/boiled by a stated method absorb a fairly standard amount of water, and a sauce the method says to reduce by a stated fraction has a fairly standard outcome. An estimate is not defensible when the recipe gives no method for the step that decides the yield (no cooking instructions at all, or a dish assembled from components whose amounts the recipe leaves entirely open), so that any number would be invented rather than estimated.",
            },
            weight_band: {
                type: "choice",
                instructions:
                    "By what factor should the anchor WEIGHT (the sum of ALL the ingredients' gram weights) be adjusted to estimate the finished dish's total weight, given the cooking effects in the method? The factor applies to the WHOLE dish, not to any single ingredient: dry pasta and grains absorb cooking water that is usually NOT listed as an ingredient, but the sauce, liquid, and other components are already at their full weight — so if a quarter of the anchor's weight is dry pasta that roughly doubles as it cooks, the whole-dish factor is about 1.25, not 2. Sauces reduced or liquids drained push the whole dish below the anchor; melting and mixing leave it near the anchor.",
                criteria: bandCriteria(),
            },
        };
        if (anchor.volume_ml !== null) {
            questions.volume_band = {
                type: "choice",
                instructions:
                    "By what factor should the anchor VOLUME (the summed volume of the volume-measured ingredients) be adjusted to estimate the finished dish's total volume, given the cooking effects in the method? Absorbed water expands grains and pasta beyond their dry volume; reduction shrinks a liquid's volume; melting and mixing leave volume near the anchor.",
                criteria: bandCriteria(),
            };
        }
        const call = await callDecisionsWithFallback(config, {
            seat: "yield_estimate",
            timeoutMs: yieldEstimateTimeoutMs(config),
            includeImageHeader: false,
            fetcher: dependencies.fetcher,
            state: {
                task: "Estimate a recipe's finished yield from its ingredient anchor and cooking method.",
                recipe: resolution.recipe.name,
                servings: resolution.recipe.servings,
                anchor: {
                    weight_g: anchor.weight_g,
                    volume_ml: anchor.volume_ml,
                    weight_coverage: anchor.weight_coverage,
                },
                method_cues: cues,
                pan_size: panSize,
                instructions: instructions.slice(0, 12),
                ingredients: resolution.recipe.ingredients.map(
                    (ingredient) => ({
                        name: ingredient.name,
                        quantity: ingredient.quantity ?? null,
                        unit: ingredient.unit ?? null,
                        gram_weight: ingredient.gram_weight ?? null,
                    }),
                ),
            },
            questions,
        });
        const probability = noulProbability(call.answers.defensible);
        if (probability === null) return unchanged("unchecked");
        const threshold = yieldDefensibleThresholdForModel(call.model);
        if (probability < threshold) {
            console.info(
                `[decisions] seat=yield_estimate status=not_defensible model=${call.model} p=${probability} threshold=${threshold}`,
            );
            return {
                status: "not_defensible",
                yieldEstimate: null,
                model: call.model,
                reportedCostUsd: call.reportedCostUsd,
                probability,
            };
        }
        const weightFactor =
            anchor.weight_g !== null
                ? choiceFactor(call.answers, "weight_band")
                : null;
        const volumeFactor =
            anchor.volume_ml !== null
                ? choiceFactor(call.answers, "volume_band")
                : null;
        if (
            (anchor.weight_g !== null && weightFactor === null) ||
            (anchor.volume_ml !== null && volumeFactor === null)
        ) {
            return unchanged("unchecked");
        }
        const estimate: RecipeYieldEstimate = {
            source: "estimate",
            weight_g:
                anchor.weight_g !== null && weightFactor !== null
                    ? round1(anchor.weight_g * weightFactor)
                    : null,
            volume_ml:
                anchor.volume_ml !== null && volumeFactor !== null
                    ? round1(anchor.volume_ml * volumeFactor)
                    : null,
            anchor: {
                weight_g: anchor.weight_g,
                volume_ml: anchor.volume_ml,
                weight_factor: weightFactor,
                volume_factor: volumeFactor,
            },
            model: call.model,
            probability,
        };
        console.info(
            `[decisions] seat=yield_estimate status=estimated model=${call.model} weight_g=${estimate.weight_g} volume_ml=${estimate.volume_ml} cost_usd=${call.reportedCostUsd ?? "null"}`,
        );
        return {
            status: "estimated",
            yieldEstimate: estimate,
            model: call.model,
            reportedCostUsd: call.reportedCostUsd,
            probability,
        };
    } catch (error) {
        console.info(
            `[decisions] seat=yield_estimate status=unchecked reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
        return unchanged("unchecked");
    }
}

/**
 * The wired hook — same signature as the A1/A2 review hook so the
 * two compose in the `resolutionReview` dependency. Fail-open:
 * returns the input resolution unchanged unless a fresh estimate
 * was produced; a user-set yield short-circuits before any call.
 */
export async function reviewRecipeYield(
    resolution: RecipeNutritionResolution,
    dependencies: YieldEstimateDependencies = {},
): Promise<RecipeNutritionResolution> {
    if (resolution.recipe.yield_estimate?.source === "user") {
        return resolution;
    }
    const result = await estimateYieldForResolution(resolution, dependencies);
    if (result.status !== "estimated" || !result.yieldEstimate) {
        return resolution;
    }
    return {
        ...resolution,
        recipe: { ...resolution.recipe, yield_estimate: result.yieldEstimate },
    };
}
