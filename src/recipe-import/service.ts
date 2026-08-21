import {
    encodeFoodCandidateId,
    getFoodSearchService,
    summarizeFoodCandidate,
    type FoodSearchService,
} from "../food-providers/service.js";
import { normalizeFoodText } from "../food-providers/catalog-repository.js";
import { scaleNutrients } from "../food-providers/nutrients.js";
import type { FoodCandidate, FoodPortion } from "../food-providers/types.js";
import {
    calculateNutrition,
    type NutrientFacts,
    type RecipeInput,
} from "../planning/repository.js";
import {
    assertSafeRecipeUrl,
    fetchRecipePage,
    type RecipeUrlFetchDependencies,
} from "./fetch.js";
import { parseRecipeHtml, RECIPE_IMPORT_PARSER_VERSION } from "./parser.js";
import type {
    FetchedRecipePage,
    ParsedRecipeIngredient,
    RecipeImportAssumption,
    RecipeImportIngredientAssignment,
    RecipeImportIngredientAssignmentRequest,
    RecipeImportCandidateChoice,
    RecipeImportCandidateChoiceRequest,
    RecipeImportDraft,
    RecipeImportSemanticResolver,
    RecipeImportWarning,
} from "./types.js";
import { recipeImportDraftOutputSchema } from "./types.js";

const MATCH_CANDIDATE_LIMIT = 3;
const AUTO_MATCH_MIN_CONFIDENCE = 0.84;
const AUTO_MATCH_MIN_SIMILARITY = 0.72;
const AUTO_MATCH_MIN_MARGIN = 0.08;
const MAX_CONCURRENT_FOOD_MATCHES = 4;
const MAX_SEMANTIC_SEARCH_QUERIES = 2;
const LOW_IMPACT_INGREDIENT_PATTERN =
    /\b(salt|pepper|thyme|parsley|bay leaves?|oregano|basil|rosemary|sage|cumin|paprika|seasoning|spice|herb)\b/i;

export interface RecipeImportDependencies {
    fetchPage?: (
        url: string,
        options?: RecipeUrlFetchDependencies & { rateLimitKey?: string },
    ) => Promise<FetchedRecipePage>;
    foodSearch?: Pick<FoodSearchService, "search">;
    semanticResolver?: RecipeImportSemanticResolver;
}

type EnrichedIngredient = {
    ingredient: RecipeImportDraft["recipe"]["ingredients"][number];
    review: RecipeImportDraft["ingredient_review"][number];
    warning?: RecipeImportWarning;
    assumption?: RecipeImportAssumption;
};

type RecipeImportSearchStats = {
    queryAttempts: number;
    uniqueSearches: number;
    cacheHits: number;
    rerankRequests: number;
    assignmentRequests: number;
    searchMs: number;
    rerankMs: number;
    assignmentMs: number;
};

function warning(
    code: string,
    message: string,
    field?: string,
    blocking = true,
): RecipeImportWarning {
    return {
        code,
        message,
        severity: "warning",
        ...(field ? { field } : {}),
        ...(blocking ? {} : { blocking: false }),
    };
}

function safeImportLogValue(value: string | number | boolean): string {
    return String(value)
        .replace(/[^a-zA-Z0-9._:-]/g, "_")
        .slice(0, 120);
}

function importErrorCode(error: unknown): string {
    if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
    ) {
        return error.code;
    }
    return error instanceof Error ? error.name : "unknown";
}

function logRecipeImportSummary(
    fields: Record<string, string | number | boolean>,
) {
    console.info(
        `[recipe_import] ${Object.entries(fields)
            .map(([key, value]) => `${key}=${safeImportLogValue(value)}`)
            .join(" ")}`,
    );
}

function round(value: number): number {
    return Number(value.toFixed(2));
}

function similarity(query: string, candidate: FoodCandidate): number {
    const normalizedQuery = normalizeFoodText(query);
    const candidateNames = [candidate.name, candidate.brand]
        .filter(Boolean)
        .map((value) => normalizeFoodText(value!));
    if (candidateNames.includes(normalizedQuery)) return 1;
    const queryTokens = new Set(normalizedQuery.split(" ").filter(Boolean));
    if (queryTokens.size === 0) return 0;
    const candidateTokens = new Set(
        candidateNames.join(" ").split(" ").filter(Boolean),
    );
    let overlap = 0;
    for (const token of queryTokens) {
        if (candidateTokens.has(token)) overlap += 1;
    }
    return overlap / queryTokens.size;
}

function normalizePortionUnit(value: string): string {
    const aliases: Record<string, string> = {
        bottles: "bottle",
        cans: "can",
        cups: "cup",
        cloves: "clove",
        dashes: "dash",
        drops: "drop",
        heads: "head",
        grams: "g",
        gram: "g",
        inches: "inch",
        kilograms: "kg",
        kilogram: "kg",
        liters: "l",
        litres: "l",
        milliliters: "ml",
        millilitres: "ml",
        ounces: "oz",
        ounce: "oz",
        packages: "package",
        pounds: "lb",
        pound: "lb",
        pints: "pint",
        quarts: "quart",
        servings: "serving",
        slices: "slice",
        sprigs: "sprig",
        stalks: "stalk",
        sticks: "stick",
        tablespoons: "tbsp",
        tablespoon: "tbsp",
        teaspoons: "tsp",
        teaspoon: "tsp",
    };
    const normalized = value.trim().toLowerCase();
    return aliases[normalized] ?? normalized;
}

function nutrientFacts(portion: FoodPortion, factor: number): NutrientFacts {
    return Object.fromEntries(
        Object.entries(scaleNutrients(portion.nutrients, factor)).filter(
            ([key]) =>
                [
                    "calories",
                    "protein_g",
                    "carbs_g",
                    "fat_g",
                    "fiber_g",
                    "sugar_g",
                    "sodium_mg",
                ].includes(key),
        ),
    ) as NutrientFacts;
}

function portionScale(
    ingredient: ParsedRecipeIngredient,
    portion: FoodPortion,
): { factor: number; gramWeight?: number; reason: string } | null {
    if (ingredient.quantity === undefined) return null;
    if (!Number.isFinite(portion.amount) || portion.amount <= 0) return null;
    const quantity = ingredient.quantity;
    const unit = normalizePortionUnit(ingredient.unit ?? "");
    const portionUnit = normalizePortionUnit(portion.unit);
    if (
        unit === "g" &&
        portion.gramWeight !== undefined &&
        portion.gramWeight > 0
    ) {
        return {
            factor: quantity / portion.gramWeight,
            gramWeight: quantity,
            reason: "gram_weight",
        };
    }
    if (
        unit === "kg" &&
        portion.gramWeight !== undefined &&
        portion.gramWeight > 0
    ) {
        return {
            factor: (quantity * 1_000) / portion.gramWeight,
            gramWeight: quantity * 1_000,
            reason: "kilogram_weight",
        };
    }
    if (
        unit === "oz" &&
        portion.gramWeight !== undefined &&
        portion.gramWeight > 0
    ) {
        return {
            factor: (quantity * 28.3495) / portion.gramWeight,
            gramWeight: quantity * 28.3495,
            reason: "ounce_weight",
        };
    }
    if (!unit || unit === "each" || unit === "piece" || unit === "pieces") {
        return {
            factor: quantity / portion.amount,
            gramWeight:
                portion.gramWeight === undefined
                    ? undefined
                    : portion.gramWeight * (quantity / portion.amount),
            reason: "default_portion_count",
        };
    }
    if (unit === portionUnit || unit === "serving") {
        return {
            factor: quantity / portion.amount,
            gramWeight:
                portion.gramWeight === undefined
                    ? undefined
                    : portion.gramWeight * (quantity / portion.amount),
            reason: "matching_portion_unit",
        };
    }
    if (portion.label.toLowerCase().includes(unit)) {
        return {
            factor: quantity / portion.amount,
            gramWeight:
                portion.gramWeight === undefined
                    ? undefined
                    : portion.gramWeight * (quantity / portion.amount),
            reason: "portion_label_match",
        };
    }
    return null;
}

function selectPortion(
    ingredient: ParsedRecipeIngredient,
    portions: FoodPortion[],
): FoodPortion | undefined {
    if (portions.length === 0) return undefined;
    const unit = normalizePortionUnit(ingredient.unit ?? "");
    if (unit === "g" || unit === "kg" || unit === "oz") {
        return (
            portions.find(
                (portion) =>
                    portion.gramWeight !== undefined && portion.gramWeight > 0,
            ) ?? portions[0]
        );
    }
    if (!unit || unit === "each" || unit === "piece" || unit === "pieces") {
        return (
            portions.find((portion) => {
                const portionUnit = normalizePortionUnit(portion.unit);
                return (
                    portionUnit === "each" ||
                    portionUnit === "piece" ||
                    /\b(each|piece|item)\b/i.test(portion.label)
                );
            }) ?? portions[0]
        );
    }
    return (
        portions.find((portion) => {
            const portionUnit = normalizePortionUnit(portion.unit);
            return (
                portionUnit === unit ||
                portion.label.toLowerCase().includes(unit)
            );
        }) ?? portions[0]
    );
}

function candidateKey(candidate: FoodCandidate): string {
    return encodeFoodCandidateId(candidate);
}

function candidateScore(
    ingredient: ParsedRecipeIngredient,
    candidate: FoodCandidate,
): number {
    const queries = [
        ingredient.name,
        ...(ingredient.searchQueries ?? []),
    ].filter(Boolean);
    return Math.max(...queries.map((query) => similarity(query, candidate)), 0);
}

function rankedCandidates(
    ingredient: ParsedRecipeIngredient,
    candidates: FoodCandidate[],
) {
    return candidates
        .map((candidate) => ({
            candidate,
            score: candidateScore(ingredient, candidate),
        }))
        .sort((left, right) => right.score - left.score);
}

function hasStrongDeterministicMatch(
    ingredient: ParsedRecipeIngredient,
    candidates: FoodCandidate[],
): boolean {
    const ranked = rankedCandidates(ingredient, candidates);
    const top = ranked[0];
    const second = ranked[1];
    if (!top || top.candidate.confidence < AUTO_MATCH_MIN_CONFIDENCE) {
        return false;
    }
    return (
        top.score === 1 ||
        (top.score >= AUTO_MATCH_MIN_SIMILARITY &&
            (!second || top.score - second.score >= AUTO_MATCH_MIN_MARGIN))
    );
}

function ingredientAssumption(
    ingredient: ParsedRecipeIngredient,
): RecipeImportAssumption | undefined {
    if (!ingredient.assumption) return undefined;
    const position = ingredient.sourcePosition ?? 0;
    return {
        position,
        raw_text: ingredient.rawText,
        message:
            ingredient.assumption ??
            "An unspecified low-impact ingredient was excluded from the nutrition total.",
        impact: ingredient.impact ?? "low",
        source: "website_ai",
    };
}

function isLowImpactIngredient(ingredient: ParsedRecipeIngredient): boolean {
    return (
        ingredient.impact === "low" ||
        LOW_IMPACT_INGREDIENT_PATTERN.test(
            `${ingredient.name} ${ingredient.rawText}`,
        )
    );
}

function lowImpactDefaults(ingredient: ParsedRecipeIngredient): {
    quantity: number;
    unit: string;
} {
    const text = `${ingredient.name} ${ingredient.rawText}`.toLowerCase();
    if (text.includes("pepper")) return { quantity: 0.125, unit: "tsp" };
    if (text.includes("salt")) return { quantity: 0.25, unit: "tsp" };
    return { quantity: 0.25, unit: "tsp" };
}

function lowImpactEstimate(ingredient: ParsedRecipeIngredient): NutrientFacts {
    const text = `${ingredient.name} ${ingredient.rawText}`.toLowerCase();
    const estimate: NutrientFacts = {
        calories: 0,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
    };
    if (text.includes("salt")) estimate.sodium_mg = 575;
    if (text.includes("pepper")) {
        estimate.calories = 1;
        estimate.carbs_g = 0.2;
        estimate.protein_g = 0.05;
    }
    return estimate;
}

function lowImpactIngredient(
    ingredient: ParsedRecipeIngredient,
    sourceUrl: string,
    strategy: string,
    semanticLabel?: string,
): EnrichedIngredient {
    const defaults = lowImpactDefaults(ingredient);
    const quantity = ingredient.quantity ?? defaults.quantity;
    const unit = ingredient.unit ?? defaults.unit;
    const assumption = ingredientAssumption(ingredient) ?? {
        position: ingredient.sourcePosition ?? 0,
        raw_text: ingredient.rawText,
        message: `The source did not specify a measurable amount; retained the ingredient and estimated ${quantity} ${unit} for nutrition.`,
        impact: "low" as const,
        source: semanticLabel ? ("website_ai" as const) : ("parser" as const),
    };
    return {
        ingredient: {
            name: ingredient.name,
            quantity,
            unit,
            preparation: ingredient.preparation,
            optional: ingredient.optional,
            source_type: "model_estimate",
            source_url: sourceUrl,
            confidence: ingredient.semanticConfidence,
            nutrients: lowImpactEstimate(ingredient),
            source_snapshot: {
                resolution_layer: "recipe_url",
                resolution: "assumed",
                parser_strategy: strategy,
                ...(semanticLabel
                    ? { semantic_resolution_layer: semanticLabel }
                    : {}),
                semantic_confidence: ingredient.semanticConfidence ?? null,
                raw_ingredient: ingredient.rawText,
                normalized_ingredient: ingredient.name,
                imported_source_url: sourceUrl,
                assumption: assumption.message,
                impact: "low",
                nutrition_treatment: "low_impact_quantity_estimate",
                estimated_quantity: quantity,
                estimated_unit: unit,
            },
        },
        review: {
            position: 0,
            raw_text: ingredient.rawText,
            resolution: "assumed",
            candidates: [],
        },
        assumption,
    };
}

function modelEstimatedIngredient(
    ingredient: ParsedRecipeIngredient,
    sourceUrl: string,
    strategy: string,
    semanticLabel?: string,
    candidates: FoodCandidate[] = [],
    reason = "No provider candidate was available after bounded search.",
): EnrichedIngredient {
    if (isLowImpactIngredient(ingredient)) {
        return lowImpactIngredient(
            ingredient,
            sourceUrl,
            strategy,
            semanticLabel ?? "bounded_fallback",
        );
    }
    const assumption: RecipeImportAssumption = {
        position: ingredient.sourcePosition ?? 0,
        raw_text: ingredient.rawText,
        message: ingredient.assumption ?? reason,
        impact: ingredient.impact ?? "high",
        source: ingredient.assumption ? "website_ai" : "provider",
    };
    return {
        ingredient: {
            name: ingredient.name || ingredient.rawText,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            preparation: ingredient.preparation,
            optional: ingredient.optional,
            source_type: "model_estimate",
            source_url: sourceUrl,
            confidence: ingredient.semanticConfidence ?? 0.35,
            source_snapshot: {
                resolution_layer: "recipe_url",
                resolution: "assumed",
                parser_strategy: strategy,
                ...(semanticLabel
                    ? { semantic_resolution_layer: semanticLabel }
                    : {}),
                semantic_confidence: ingredient.semanticConfidence ?? null,
                raw_ingredient: ingredient.rawText,
                normalized_ingredient: ingredient.name,
                imported_source_url: sourceUrl,
                assumption: assumption.message,
                nutrition_treatment: "provider_unavailable_model_estimate",
                candidate_count: candidates.length,
            },
        },
        review: {
            position: 0,
            raw_text: ingredient.rawText,
            resolution: "assumed",
            candidates: candidates
                .slice(0, MATCH_CANDIDATE_LIMIT)
                .map(summarizeFoodCandidate),
        },
        assumption,
    };
}

function isLowImpactUnmeasurable(ingredient: ParsedRecipeIngredient): boolean {
    return (
        isLowImpactIngredient(ingredient) &&
        (ingredient.quantity === undefined ||
            (ingredient.searchQueries?.length ?? 0) === 0)
    );
}

function enrichIngredient(
    ingredient: ParsedRecipeIngredient,
    sourceUrl: string,
    candidates: FoodCandidate[],
    strategy: string,
    semanticLabel: string | undefined,
    choice: RecipeImportCandidateChoice | undefined,
    assignment: RecipeImportIngredientAssignment | undefined,
    searchUnavailable: boolean,
): EnrichedIngredient {
    if (semanticLabel && isLowImpactUnmeasurable(ingredient)) {
        return lowImpactIngredient(
            ingredient,
            sourceUrl,
            strategy,
            semanticLabel,
        );
    }
    if (!ingredient.name.trim()) {
        return modelEstimatedIngredient(
            ingredient,
            sourceUrl,
            strategy,
            semanticLabel,
            candidates,
        );
    }
    if (candidates.length === 0) {
        return modelEstimatedIngredient(
            ingredient,
            sourceUrl,
            strategy,
            semanticLabel,
            [],
            searchUnavailable
                ? "Nutrition providers were unavailable after bounded search; the ingredient was retained as a model estimate."
                : "No provider candidate was available after bounded search; the ingredient was retained as a model estimate.",
        );
    }

    const ranked = rankedCandidates(ingredient, candidates);
    const top = ranked[0]!;
    const second = ranked[1];
    const requestedCandidateId =
        assignment?.candidateId ?? choice?.candidateId ?? null;
    let selected = requestedCandidateId
        ? candidates.find(
              (candidate) => candidateKey(candidate) === requestedCandidateId,
          )
        : undefined;
    let selectedByModel = Boolean(selected && (choice || assignment));
    if (!selected) {
        selected = top.candidate;
        selectedByModel = false;
    }
    const selectedScore = candidateScore(ingredient, selected);
    const exact = top.score === 1;
    const deterministicMatch =
        selected === top.candidate &&
        top.candidate.confidence >= AUTO_MATCH_MIN_CONFIDENCE &&
        (exact ||
            (top.score >= AUTO_MATCH_MIN_SIMILARITY &&
                (!second ||
                    top.score - second.score >= AUTO_MATCH_MIN_MARGIN)));
    const semanticMatch =
        Boolean(semanticLabel) &&
        selectedScore >= 0.5 &&
        selected.confidence >= 0.65 &&
        (selectedByModel
            ? (choice?.confidence ?? 0) >= 0.55
            : ingredient.semanticConfidence !== undefined &&
              ingredient.semanticConfidence >= 0.8 &&
              selected === top.candidate);
    const assignedMatch =
        assignment?.decision === "provider_match" &&
        assignment.candidateId === candidateKey(selected) &&
        assignment.confidence >= 0.55;
    const portion = selectPortion(ingredient, selected.portions);
    const scale = portion ? portionScale(ingredient, portion) : null;
    if (!portion || !scale || !Number.isFinite(scale.factor)) {
        return modelEstimatedIngredient(
            ingredient,
            sourceUrl,
            strategy,
            semanticLabel,
            candidates,
            "The selected food did not expose a compatible portion; the ingredient was retained as a model estimate.",
        );
    }
    const nutrients = nutrientFacts(portion, scale.factor);
    const provider = selected.provider;
    const providerFoodId = selected.providerFoodId;
    const assumption =
        ingredientAssumption(ingredient) ??
        ((!deterministicMatch && !semanticMatch && !assignedMatch) ||
        assignment?.decision === "assumed" ||
        assignment?.decision === "model_estimate"
            ? {
                  position: ingredient.sourcePosition ?? 0,
                  raw_text: ingredient.rawText,
                  message:
                      assignment?.assumption ??
                      "Selected the highest-confidence available nutrition match after bounded matching.",
                  impact: ingredient.impact ?? "medium",
                  source: assignment
                      ? ("website_ai" as const)
                      : ("provider" as const),
              }
            : undefined);
    const resolution = assumption ? "assumed" : "matched";
    const result: EnrichedIngredient = {
        ingredient: {
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            preparation: ingredient.preparation,
            optional: ingredient.optional,
            gram_weight: scale.gramWeight,
            nutrients,
            provider,
            provider_food_id: providerFoodId,
            source_type: provider,
            source_url: selected.attribution.url,
            confidence: Math.min(
                selected.confidence,
                ingredient.semanticConfidence ?? selected.confidence,
                assignment?.confidence ?? 1,
            ),
            source_snapshot: {
                resolution_layer: "recipe_url",
                resolution,
                parser_strategy: strategy,
                raw_ingredient: ingredient.rawText,
                normalized_ingredient: ingredient.name,
                imported_source_url: sourceUrl,
                ...(semanticLabel
                    ? {
                          semantic_resolution_layer: semanticLabel,
                          semantic_confidence:
                              ingredient.semanticConfidence ?? null,
                          search_queries: ingredient.searchQueries ?? [],
                          candidate_selection_method: selectedByModel
                              ? "semantic_ai"
                              : assignment
                                ? "semantic_assignment"
                                : "deterministic",
                      }
                    : {}),
                ...(assumption ? { assumption: assumption.message } : {}),
                ...(choice?.rationale
                    ? { candidate_selection_rationale: choice.rationale }
                    : {}),
                ...(assignment?.rationale
                    ? { ingredient_assignment_rationale: assignment.rationale }
                    : {}),
                candidate_id: candidateKey(selected),
                selected_portion_id: portion.id,
                selected_portion_label: portion.label,
                scaling_factor: round(scale.factor),
                scaling_reason: scale.reason,
                nutrition_snapshot: nutrients,
            },
        },
        review: {
            position: 0,
            raw_text: ingredient.rawText,
            resolution,
            candidates: candidates
                .slice(0, MATCH_CANDIDATE_LIMIT)
                .map(summarizeFoodCandidate),
        },
        ...(assumption ? { assumption } : {}),
    };
    return result;
}

interface SearchedIngredient {
    ingredient: ParsedRecipeIngredient;
    candidates: FoodCandidate[];
    unavailable: boolean;
}

function assignmentReason(
    ingredient: ParsedRecipeIngredient,
    candidates: FoodCandidate[],
): RecipeImportIngredientAssignmentRequest["reason"] | undefined {
    if (candidates.length === 0) return "no_candidate";
    if (ingredient.quantity === undefined) return "missing_quantity";
    const top = rankedCandidates(ingredient, candidates)[0]?.candidate;
    if (!top || !selectPortion(ingredient, top.portions)) {
        return "missing_portion";
    }
    return hasStrongDeterministicMatch(ingredient, candidates)
        ? undefined
        : "ambiguous_candidate";
}

function applyIngredientAssignment(
    ingredient: ParsedRecipeIngredient,
    assignment: RecipeImportIngredientAssignment,
): ParsedRecipeIngredient {
    return {
        ...ingredient,
        name: assignment.name || ingredient.name,
        ...(assignment.quantity === undefined
            ? {}
            : { quantity: assignment.quantity }),
        ...(assignment.unit ? { unit: assignment.unit } : {}),
        searchQueries:
            assignment.searchQueries.length > 0
                ? assignment.searchQueries
                : (ingredient.searchQueries ?? []),
        ...(assignment.assumption ? { assumption: assignment.assumption } : {}),
        impact:
            assignment.decision === "model_estimate"
                ? (ingredient.impact ?? "medium")
                : ingredient.impact,
        semanticConfidence: assignment.confidence,
    };
}

function mergeCandidates(
    ingredient: ParsedRecipeIngredient,
    existing: FoodCandidate[],
    additional: FoodCandidate[],
): FoodCandidate[] {
    const unique = [...existing];
    for (const candidate of additional) {
        if (
            !unique.some(
                (item) => candidateKey(item) === candidateKey(candidate),
            )
        ) {
            unique.push(candidate);
        }
    }
    return rankedCandidates(ingredient, unique)
        .slice(0, MATCH_CANDIDATE_LIMIT)
        .map(({ candidate }) => candidate);
}

function deterministicSearchQueries(
    ingredient: ParsedRecipeIngredient,
): string[] {
    const base = ingredient.name.trim();
    if (!base) return [];
    const stripped = base
        .replace(
            /,?\s+(?:chopped|diced|minced|grated|halved|sliced|shredded|julienned|cubed|roughly|finely|fresh|dry|dried|divided|melted|softened|such as)\b[\s\S]*$/i,
            "",
        )
        .replace(/\s+/g, " ")
        .trim();
    const components = base
        .split(/\s+(?:or|and|plus)\s+/i)
        .map((part) =>
            part
                .replace(/^\d+(?:[./]\d+)?\s+/i, "")
                .replace(/,.*$/i, "")
                .trim(),
        )
        .filter((part) => part.length >= 2);
    return [...components, stripped, base].filter(
        (query, index, all) => query && all.indexOf(query) === index,
    );
}

async function searchIngredientCandidates(
    ingredient: ParsedRecipeIngredient,
    foodSearch: Pick<FoodSearchService, "search">,
    cache: Map<
        string,
        Promise<{ candidates: FoodCandidate[]; unavailable: boolean }>
    >,
    stats: RecipeImportSearchStats,
): Promise<{ candidates: FoodCandidate[]; unavailable: boolean }> {
    const queries = [
        ...(ingredient.searchQueries ?? []),
        ...deterministicSearchQueries(ingredient),
    ]
        .map((query) => query.trim())
        .filter(Boolean)
        .filter((query, index, all) => all.indexOf(query) === index)
        .slice(0, MAX_SEMANTIC_SEARCH_QUERIES);
    if (queries.length === 0) return { candidates: [], unavailable: false };
    const candidates: FoodCandidate[] = [];
    let unavailable = false;
    for (const query of queries) {
        stats.queryAttempts += 1;
        let request = cache.get(query.toLowerCase());
        if (!request) {
            stats.uniqueSearches += 1;
            request = foodSearch
                .search(query, MATCH_CANDIDATE_LIMIT)
                .then((result) => ({
                    candidates: result.candidates.slice(
                        0,
                        MATCH_CANDIDATE_LIMIT,
                    ),
                    unavailable:
                        result.candidates.length === 0 &&
                        result.failures.length > 0,
                }))
                .catch(() => ({ candidates: [], unavailable: true }));
            cache.set(query.toLowerCase(), request);
        } else {
            stats.cacheHits += 1;
        }
        const result = await request;
        unavailable ||= result.unavailable;
        for (const candidate of result.candidates) {
            if (
                !candidates.some(
                    (existing) =>
                        candidateKey(existing) === candidateKey(candidate),
                )
            ) {
                candidates.push(candidate);
            }
        }
        if (hasStrongDeterministicMatch(ingredient, candidates)) {
            break;
        }
    }
    return {
        candidates: rankedCandidates(ingredient, candidates)
            .slice(0, MATCH_CANDIDATE_LIMIT)
            .map(({ candidate }) => candidate),
        unavailable,
    };
}

async function enrichIngredients(
    ingredients: ParsedRecipeIngredient[],
    sourceUrl: string,
    foodSearch: Pick<FoodSearchService, "search">,
    strategy: string,
    semanticResolver?: RecipeImportSemanticResolver,
    allowSemanticAssignment = true,
) {
    const searched: SearchedIngredient[] = [];
    const cache = new Map<
        string,
        Promise<{ candidates: FoodCandidate[]; unavailable: boolean }>
    >();
    const stats: RecipeImportSearchStats = {
        queryAttempts: 0,
        uniqueSearches: 0,
        cacheHits: 0,
        rerankRequests: 0,
        assignmentRequests: 0,
        searchMs: 0,
        rerankMs: 0,
        assignmentMs: 0,
    };
    let next = 0;
    const worker = async () => {
        while (next < ingredients.length) {
            const index = next++;
            const ingredient = ingredients[index]!;
            const result = await searchIngredientCandidates(
                ingredient,
                foodSearch,
                cache,
                stats,
            );
            searched[index] = { ingredient, ...result };
        }
    };
    const searchStartedAt = Date.now();
    await Promise.all(
        Array.from(
            {
                length: Math.min(
                    MAX_CONCURRENT_FOOD_MATCHES,
                    ingredients.length,
                ),
            },
            worker,
        ),
    );
    stats.searchMs = Math.max(0, Date.now() - searchStartedAt);

    const assignmentRequests: RecipeImportIngredientAssignmentRequest[] =
        allowSemanticAssignment && semanticResolver?.resolveUncertainIngredients
            ? searched.flatMap((entry) => {
                  const reason = assignmentReason(
                      entry.ingredient,
                      entry.candidates,
                  );
                  return reason
                      ? [
                            {
                                key:
                                    entry.ingredient.semanticKey ??
                                    `ingredient:${entry.ingredient.sourcePosition ?? 0}`,
                                ingredient: entry.ingredient,
                                candidates: entry.candidates,
                                reason,
                            },
                        ]
                      : [];
              })
            : [];
    stats.assignmentRequests = assignmentRequests.length;
    let choices = new Map<string, RecipeImportCandidateChoice>();
    let assignments = new Map<string, RecipeImportIngredientAssignment>();
    const warnings: RecipeImportWarning[] = [];
    if (
        assignmentRequests.length > 0 &&
        semanticResolver?.resolveUncertainIngredients
    ) {
        const assignmentStartedAt = Date.now();
        try {
            assignments =
                await semanticResolver.resolveUncertainIngredients(
                    assignmentRequests,
                );
        } catch {
            warnings.push(
                warning(
                    "semantic_ai_assignment_unavailable",
                    "The website AI could not assign every uncertain ingredient; Munch selected the best bounded fallback instead.",
                    "ingredients",
                    false,
                ),
            );
        } finally {
            stats.assignmentMs = Math.max(0, Date.now() - assignmentStartedAt);
        }
    }

    if (
        allowSemanticAssignment &&
        assignments.size === 0 &&
        semanticResolver?.chooseCandidates
    ) {
        const rerankRequests: RecipeImportCandidateChoiceRequest[] = searched
            .filter(
                (entry) =>
                    entry.candidates.length > 1 &&
                    !isLowImpactUnmeasurable(entry.ingredient) &&
                    !hasStrongDeterministicMatch(
                        entry.ingredient,
                        entry.candidates,
                    ),
            )
            .map((entry) => ({
                key:
                    entry.ingredient.semanticKey ??
                    `ingredient:${entry.ingredient.sourcePosition ?? 0}`,
                ingredient: entry.ingredient,
                candidates: entry.candidates,
            }));
        stats.rerankRequests = rerankRequests.length;
        if (rerankRequests.length > 0) {
            const rerankStartedAt = Date.now();
            try {
                choices =
                    await semanticResolver.chooseCandidates(rerankRequests);
            } catch {
                warnings.push(
                    warning(
                        "semantic_ai_rerank_unavailable",
                        "The website AI could not choose among some nutrition matches; Munch selected the best bounded fallback instead.",
                        "ingredients",
                        false,
                    ),
                );
            } finally {
                stats.rerankMs = Math.max(0, Date.now() - rerankStartedAt);
            }
        }
    }

    if (assignments.size > 0) {
        type AssignmentRetryTarget = {
            entry: SearchedIngredient;
            index: number;
            ingredient: ParsedRecipeIngredient;
            skipSearch: boolean;
        };
        const retryTargets = searched.flatMap((entry, index) => {
            const key =
                entry.ingredient.semanticKey ??
                `ingredient:${entry.ingredient.sourcePosition ?? 0}`;
            const assignment = assignments.get(key);
            if (!assignment) return [];
            const ingredient = applyIngredientAssignment(
                entry.ingredient,
                assignment,
            );
            const selectedCandidate = assignment.candidateId
                ? entry.candidates.find(
                      (candidate) =>
                          candidateKey(candidate) === assignment.candidateId,
                  )
                : undefined;
            const shouldRetry =
                entry.candidates.length === 0 ||
                !selectedCandidate ||
                assignment.decision === "model_estimate";
            return [
                {
                    entry,
                    index,
                    ingredient,
                    skipSearch: !shouldRetry,
                } satisfies AssignmentRetryTarget,
            ];
        });
        let retryNext = 0;
        const retryWorker = async () => {
            while (retryNext < retryTargets.length) {
                const target = retryTargets[retryNext++];
                if (!target) continue;
                const assignment = assignments.get(
                    target.ingredient.semanticKey ??
                        `ingredient:${target.ingredient.sourcePosition ?? 0}`,
                );
                if (!assignment) continue;
                if (target.skipSearch) {
                    searched[target.index] = {
                        ...target.entry,
                        ingredient: target.ingredient,
                    };
                    continue;
                }
                const additional = await searchIngredientCandidates(
                    target.ingredient,
                    foodSearch,
                    cache,
                    stats,
                );
                searched[target.index] = {
                    ingredient: target.ingredient,
                    candidates: mergeCandidates(
                        target.ingredient,
                        target.entry.candidates,
                        additional.candidates,
                    ),
                    unavailable:
                        target.entry.unavailable || additional.unavailable,
                };
            }
        };
        await Promise.all(
            Array.from(
                {
                    length: Math.min(
                        MAX_CONCURRENT_FOOD_MATCHES,
                        retryTargets.length,
                    ),
                },
                retryWorker,
            ),
        );
    }

    const results = searched.map((entry) =>
        (() => {
            const key =
                entry.ingredient.semanticKey ??
                `ingredient:${entry.ingredient.sourcePosition ?? 0}`;
            return enrichIngredient(
                entry.ingredient,
                sourceUrl,
                entry.candidates,
                strategy,
                semanticResolver?.label,
                choices.get(key),
                assignments.get(key),
                entry.unavailable,
            );
        })(),
    );
    return { results, warnings, stats };
}

function toRecipeInput(recipe: RecipeImportDraft["recipe"]): RecipeInput {
    return {
        name: recipe.name,
        servings: recipe.servings,
        description: recipe.description,
        instructions: recipe.instructions,
        preparationMinutes: recipe.preparation_minutes,
        cookingMinutes: recipe.cooking_minutes,
        sourceType: "imported",
        sourceTitle: recipe.source_title,
        sourceUrl: recipe.source_url,
        ingredients: recipe.ingredients.map((ingredient) => ({
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            preparation: ingredient.preparation,
            optional: ingredient.optional,
            gramWeight: ingredient.gram_weight,
            nutrients: ingredient.nutrients,
            provider: ingredient.provider,
            providerFoodId: ingredient.provider_food_id,
            sourceType: ingredient.source_type,
            sourceUrl: ingredient.source_url,
            confidence: ingredient.confidence,
            sourceSnapshot: ingredient.source_snapshot,
        })),
    };
}

export async function previewRecipeUrl(
    submittedUrl: string,
    options: RecipeImportDependencies & { rateLimitKey?: string } = {},
): Promise<RecipeImportDraft> {
    const importStartedAt = Date.now();
    const fetchStartedAt = Date.now();
    const fetchPage = options.fetchPage ?? fetchRecipePage;
    const page = await fetchPage(submittedUrl, {
        rateLimitKey: options.rateLimitKey,
    });
    const fetchMs = Math.max(0, Date.now() - fetchStartedAt);
    const parseStartedAt = Date.now();
    let parsed;
    try {
        parsed = parseRecipeHtml(page.html);
    } catch (error) {
        throw new Error(
            `Recipe import could not parse the page: ${error instanceof Error ? error.message : "unsupported recipe structure."}`,
        );
    }
    const parseMs = Math.max(0, Date.now() - parseStartedAt);
    let canonicalUrl: string | null = null;
    if (parsed.canonicalUrl) {
        try {
            canonicalUrl = assertSafeRecipeUrl(
                new URL(parsed.canonicalUrl, page.finalUrl).toString(),
            ).toString();
        } catch {
            canonicalUrl = null;
        }
    }
    const sourceUrl = canonicalUrl ?? page.finalUrl;
    const foodSearch = options.foodSearch ?? getFoodSearchService();
    let ingredients = parsed.ingredients;
    let semanticWarning: RecipeImportWarning | undefined;
    let semanticMs = 0;
    if (options.semanticResolver) {
        const semanticStartedAt = Date.now();
        try {
            const intents =
                await options.semanticResolver.normalizeRecipe(parsed);
            ingredients = intents.map((intent) => ({
                rawText: intent.rawText,
                name: intent.name,
                quantity: intent.quantity,
                unit: intent.unit,
                preparation: intent.preparation,
                optional: intent.optional,
                semanticKey: `${intent.rawIndex}:${intent.componentIndex}`,
                sourcePosition: intent.rawIndex,
                searchQueries: intent.searchQueries,
                assumption: intent.assumption,
                impact: intent.impact,
                semanticConfidence: intent.confidence,
            }));
        } catch (error) {
            semanticMs = Math.max(0, Date.now() - semanticStartedAt);
            console.warn(
                `[recipe_import_ai] phase=normalize status=fallback duration_ms=${semanticMs} code=${safeImportLogValue(importErrorCode(error))}`,
            );
            semanticWarning = warning(
                "semantic_ai_unavailable",
                "The website AI could not interpret the ingredient language, so Munch used conservative database matching instead.",
                "ingredients",
                false,
            );
        }
        if (semanticMs === 0) {
            semanticMs = Math.max(0, Date.now() - semanticStartedAt);
        }
    }
    const enrichedResult = await enrichIngredients(
        ingredients,
        sourceUrl,
        foodSearch,
        parsed.strategy,
        options.semanticResolver,
        !semanticWarning,
    );
    const warnings = [
        ...parsed.warnings.filter(
            (entry) =>
                !["quantity_range", "quantity_unparsed"].includes(entry.code),
        ),
        ...(semanticWarning ? [semanticWarning] : []),
        ...enrichedResult.warnings,
    ];
    for (const entry of enrichedResult.results)
        if (entry.warning) warnings.push(entry.warning);
    const recipe = {
        name: parsed.name,
        servings: parsed.servings,
        description: parsed.description,
        instructions: parsed.instructions,
        preparation_minutes: parsed.preparationMinutes,
        cooking_minutes: parsed.cookingMinutes,
        source_type: "imported" as const,
        source_title: parsed.sourceTitle,
        source_url: sourceUrl,
        ingredients: enrichedResult.results.map((entry) => entry.ingredient),
    };
    const calculation = calculateNutrition(toRecipeInput(recipe));
    const ingredientReview = enrichedResult.results.map((entry, position) => ({
        ...entry.review,
        position,
    }));
    const assumptions = enrichedResult.results
        .map((entry) => entry.assumption)
        .filter((entry): entry is RecipeImportAssumption => Boolean(entry))
        .filter(
            (entry, index, all) =>
                all.findIndex(
                    (candidate) =>
                        candidate.position === entry.position &&
                        candidate.message === entry.message,
                ) === index,
        )
        .filter((entry) => entry.impact !== "low");
    const hasBlockingReview = ingredientReview.some(
        (entry) =>
            entry.resolution === "ambiguous" ||
            entry.resolution === "unresolved",
    );
    const requiresReview =
        hasBlockingReview ||
        warnings.some(
            (entry) => entry.severity === "error" || entry.blocking !== false,
        ) ||
        parsed.instructions.length === 0 ||
        parsed.servings === 1;
    const draft = recipeImportDraftOutputSchema.parse({
        schema_version: 2,
        status:
            hasBlockingReview ||
            warnings.length > 0 ||
            calculation.nutritionStatus !== "complete"
                ? "partial"
                : "ready",
        requires_review: requiresReview,
        parser: {
            strategy: parsed.strategy,
            version: RECIPE_IMPORT_PARSER_VERSION,
        },
        source: {
            submitted_url: page.submittedUrl,
            final_url: page.finalUrl,
            canonical_url: canonicalUrl,
            title: parsed.sourceTitle ?? null,
            site_name: parsed.siteName ?? null,
            author: parsed.author ?? null,
        },
        recipe,
        nutrition: {
            status: calculation.nutritionStatus,
            total: calculation.totals,
            per_serving: calculation.perServing,
        },
        ingredient_review: ingredientReview,
        assumptions,
        warnings,
    });
    logRecipeImportSummary({
        status: draft.status,
        parsed_ingredients: parsed.ingredients.length,
        normalized_ingredients: ingredients.length,
        resolved_ingredients: draft.ingredient_review.filter(
            (entry) =>
                entry.resolution === "matched" ||
                entry.resolution === "assumed",
        ).length,
        blocking_review: draft.ingredient_review.filter(
            (entry) =>
                entry.resolution === "ambiguous" ||
                entry.resolution === "unresolved",
        ).length,
        assumptions: draft.assumptions.length,
        warnings: draft.warnings.length,
        semantic_enabled: Boolean(options.semanticResolver),
        semantic_fallback: Boolean(semanticWarning),
        fetch_ms: fetchMs,
        parse_ms: parseMs,
        semantic_ms: semanticMs,
        search_ms: enrichedResult.stats.searchMs,
        rerank_ms: enrichedResult.stats.rerankMs,
        assignment_ms: enrichedResult.stats.assignmentMs,
        query_attempts: enrichedResult.stats.queryAttempts,
        unique_searches: enrichedResult.stats.uniqueSearches,
        cache_hits: enrichedResult.stats.cacheHits,
        rerank_requests: enrichedResult.stats.rerankRequests,
        assignment_requests: enrichedResult.stats.assignmentRequests,
        total_ms: Math.max(0, Date.now() - importStartedAt),
    });
    return draft;
}
