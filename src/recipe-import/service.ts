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
    RecipeImportCandidateChoice,
    RecipeImportCandidateChoiceRequest,
    RecipeImportDraft,
    RecipeImportResolution,
    RecipeImportSemanticResolver,
    RecipeImportWarning,
} from "./types.js";
import { recipeImportDraftOutputSchema } from "./types.js";

const MATCH_CANDIDATE_LIMIT = 3;
const AUTO_MATCH_MIN_CONFIDENCE = 0.84;
const AUTO_MATCH_MIN_SIMILARITY = 0.72;
const AUTO_MATCH_MIN_MARGIN = 0.08;
const MAX_CONCURRENT_FOOD_MATCHES = 4;
const MAX_SEMANTIC_SEARCH_QUERIES = 4;

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

function warning(
    code: string,
    message: string,
    field?: string,
): RecipeImportWarning {
    return { code, message, severity: "warning", ...(field ? { field } : {}) };
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
        cups: "cup",
        grams: "g",
        gram: "g",
        kilograms: "kg",
        kilogram: "kg",
        milliliters: "ml",
        millilitres: "ml",
        ounces: "oz",
        ounce: "oz",
        pounds: "lb",
        pound: "lb",
        tablespoons: "tbsp",
        tablespoon: "tbsp",
        teaspoons: "tsp",
        teaspoon: "tsp",
        servings: "serving",
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

function unresolvedIngredient(
    ingredient: ParsedRecipeIngredient,
    sourceUrl: string,
    candidates: FoodCandidate[],
    resolution: RecipeImportResolution,
    semanticLabel?: string,
): EnrichedIngredient {
    const warningCode =
        resolution === "ambiguous"
            ? "ambiguous_food_match"
            : "food_match_unresolved";
    const message =
        resolution === "ambiguous"
            ? `Nutrition for “${ingredient.name}” has multiple plausible matches and needs review.`
            : `No confident nutrition match was found for “${ingredient.name}”.`;
    return {
        ingredient: {
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            preparation: ingredient.preparation,
            optional: ingredient.optional,
            source_type: "user_supplied",
            source_url: sourceUrl,
            source_snapshot: {
                resolution_layer: "recipe_url",
                resolution,
                raw_ingredient: ingredient.rawText,
                imported_source_url: sourceUrl,
                ...(semanticLabel
                    ? {
                          semantic_resolution_layer: semanticLabel,
                          semantic_confidence:
                              ingredient.semanticConfidence ?? null,
                      }
                    : {}),
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
        warning: warning(warningCode, message, "ingredients"),
    };
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

function lowImpactIngredient(
    ingredient: ParsedRecipeIngredient,
    sourceUrl: string,
    strategy: string,
    semanticLabel: string,
): EnrichedIngredient {
    const assumption = ingredientAssumption(ingredient) ?? {
        position: ingredient.sourcePosition ?? 0,
        raw_text: ingredient.rawText,
        message:
            "An unspecified low-impact ingredient was excluded from the nutrition total.",
        impact: "low" as const,
        source: "website_ai" as const,
    };
    return {
        ingredient: {
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            preparation: ingredient.preparation,
            optional: ingredient.optional,
            source_type: "model_estimate",
            source_url: sourceUrl,
            confidence: ingredient.semanticConfidence,
            source_snapshot: {
                resolution_layer: "recipe_url",
                resolution: "assumed",
                parser_strategy: strategy,
                semantic_resolution_layer: semanticLabel,
                semantic_confidence: ingredient.semanticConfidence ?? null,
                raw_ingredient: ingredient.rawText,
                normalized_ingredient: ingredient.name,
                imported_source_url: sourceUrl,
                assumption: assumption.message,
                impact: "low",
                nutrition_treatment: "excluded_low_impact_unknown_quantity",
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

function isLowImpactUnmeasurable(ingredient: ParsedRecipeIngredient): boolean {
    return (
        ingredient.impact === "low" &&
        (ingredient.quantity === undefined ||
            (ingredient.searchQueries?.length ?? 0) === 0 ||
            /\bto taste\b/i.test(ingredient.rawText))
    );
}

function enrichIngredient(
    ingredient: ParsedRecipeIngredient,
    sourceUrl: string,
    candidates: FoodCandidate[],
    strategy: string,
    semanticLabel: string | undefined,
    choice: RecipeImportCandidateChoice | undefined,
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
    if (!ingredient.name.trim() || /\bto taste\b/i.test(ingredient.rawText)) {
        const result = unresolvedIngredient(
            ingredient,
            sourceUrl,
            candidates,
            "unresolved",
            semanticLabel,
        );
        result.warning = warning(
            "food_match_unresolved",
            `Nutrition for “${ingredient.name}” was left unresolved because the source did not provide a measurable portion.`,
            "ingredients",
        );
        return result;
    }
    if (candidates.length === 0) {
        const unresolved = unresolvedIngredient(
            ingredient,
            sourceUrl,
            [],
            "unresolved",
            semanticLabel,
        );
        unresolved.warning = searchUnavailable
            ? warning(
                  "food_provider_unavailable",
                  `Nutrition lookup for “${ingredient.name}” was unavailable; the ingredient can still be reviewed and saved.`,
                  "ingredients",
              )
            : unresolved.warning;
        return unresolved;
    }

    const ranked = rankedCandidates(ingredient, candidates);
    const top = ranked[0]!;
    const second = ranked[1];
    let selected = choice?.candidateId
        ? candidates.find(
              (candidate) => candidateKey(candidate) === choice.candidateId,
          )
        : undefined;
    let selectedByModel = Boolean(selected && choice);
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
    const portion = selectPortion(ingredient, selected.portions);
    const scale = portion ? portionScale(ingredient, portion) : null;
    if (
        (!deterministicMatch && !semanticMatch) ||
        !portion ||
        !scale ||
        !Number.isFinite(scale.factor)
    ) {
        return unresolvedIngredient(
            ingredient,
            sourceUrl,
            candidates,
            candidates.length > 1 ? "ambiguous" : "unresolved",
            semanticLabel,
        );
    }
    const nutrients = nutrientFacts(portion, scale.factor);
    const provider = selected.provider;
    const providerFoodId = selected.providerFoodId;
    const assumption = ingredientAssumption(ingredient);
    const resolution = assumption || selectedByModel ? "assumed" : "matched";
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
                      }
                    : {}),
                ...(assumption ? { assumption: assumption.message } : {}),
                ...(choice?.rationale
                    ? { candidate_selection_rationale: choice.rationale }
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

async function searchIngredientCandidates(
    ingredient: ParsedRecipeIngredient,
    foodSearch: Pick<FoodSearchService, "search">,
    cache: Map<
        string,
        Promise<{ candidates: FoodCandidate[]; unavailable: boolean }>
    >,
): Promise<{ candidates: FoodCandidate[]; unavailable: boolean }> {
    if (isLowImpactUnmeasurable(ingredient)) {
        return { candidates: [], unavailable: false };
    }
    const queries = [ingredient.name, ...(ingredient.searchQueries ?? [])]
        .map((query) => query.trim())
        .filter(Boolean)
        .filter((query, index, all) => all.indexOf(query) === index)
        .slice(0, MAX_SEMANTIC_SEARCH_QUERIES);
    if (queries.length === 0) return { candidates: [], unavailable: false };
    const candidates: FoodCandidate[] = [];
    let unavailable = false;
    for (const query of queries) {
        let request = cache.get(query.toLowerCase());
        if (!request) {
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
        const ranked = rankedCandidates(ingredient, candidates);
        if (
            ranked[0] &&
            ranked[0].candidate.confidence >= AUTO_MATCH_MIN_CONFIDENCE &&
            ranked[0].score >= AUTO_MATCH_MIN_SIMILARITY
        ) {
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
) {
    const searched: SearchedIngredient[] = [];
    const cache = new Map<
        string,
        Promise<{ candidates: FoodCandidate[]; unavailable: boolean }>
    >();
    let next = 0;
    const worker = async () => {
        while (next < ingredients.length) {
            const index = next++;
            const ingredient = ingredients[index]!;
            const result = await searchIngredientCandidates(
                ingredient,
                foodSearch,
                cache,
            );
            searched[index] = { ingredient, ...result };
        }
    };
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

    const rerankRequests: RecipeImportCandidateChoiceRequest[] = searched
        .filter(
            (entry) =>
                Boolean(semanticResolver?.chooseCandidates) &&
                entry.candidates.length > 1 &&
                !isLowImpactUnmeasurable(entry.ingredient),
        )
        .map((entry) => ({
            key:
                entry.ingredient.semanticKey ??
                `ingredient:${entry.ingredient.sourcePosition ?? 0}`,
            ingredient: entry.ingredient,
            candidates: entry.candidates,
        }));
    let choices = new Map<string, RecipeImportCandidateChoice>();
    const warnings: RecipeImportWarning[] = [];
    if (rerankRequests.length > 0 && semanticResolver?.chooseCandidates) {
        try {
            choices = await semanticResolver.chooseCandidates(rerankRequests);
        } catch {
            warnings.push(
                warning(
                    "semantic_ai_rerank_unavailable",
                    "The website AI could not choose among some nutrition matches; conservative matching was used instead.",
                    "ingredients",
                ),
            );
        }
    }
    const results = searched.map((entry) =>
        enrichIngredient(
            entry.ingredient,
            sourceUrl,
            entry.candidates,
            strategy,
            semanticResolver?.label,
            choices.get(
                entry.ingredient.semanticKey ??
                    `ingredient:${entry.ingredient.sourcePosition ?? 0}`,
            ),
            entry.unavailable,
        ),
    );
    return { results, warnings };
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
    const fetchPage = options.fetchPage ?? fetchRecipePage;
    const page = await fetchPage(submittedUrl, {
        rateLimitKey: options.rateLimitKey,
    });
    let parsed;
    try {
        parsed = parseRecipeHtml(page.html);
    } catch (error) {
        throw new Error(
            `Recipe import could not parse the page: ${error instanceof Error ? error.message : "unsupported recipe structure."}`,
        );
    }
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
    if (options.semanticResolver) {
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
        } catch {
            semanticWarning = warning(
                "semantic_ai_unavailable",
                "The website AI could not interpret the ingredient language, so Munch used conservative database matching instead.",
                "ingredients",
            );
        }
    }
    const enrichedResult = await enrichIngredients(
        ingredients,
        sourceUrl,
        foodSearch,
        parsed.strategy,
        semanticWarning ? undefined : options.semanticResolver,
    );
    const warnings = [
        ...(semanticWarning
            ? parsed.warnings
            : options.semanticResolver
              ? parsed.warnings.filter(
                    (entry) =>
                        !["quantity_range", "quantity_unparsed"].includes(
                            entry.code,
                        ),
                )
              : parsed.warnings),
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
        );
    const hasBlockingReview = ingredientReview.some(
        (entry) =>
            entry.resolution === "ambiguous" ||
            entry.resolution === "unresolved",
    );
    const requiresReview =
        hasBlockingReview ||
        warnings.length > 0 ||
        parsed.instructions.length === 0 ||
        parsed.servings === 1;
    return recipeImportDraftOutputSchema.parse({
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
}
