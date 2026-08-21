import {
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
    RecipeImportDraft,
    RecipeImportResolution,
    RecipeImportWarning,
} from "./types.js";
import { recipeImportDraftOutputSchema } from "./types.js";

const MATCH_CANDIDATE_LIMIT = 3;
const AUTO_MATCH_MIN_CONFIDENCE = 0.84;
const AUTO_MATCH_MIN_SIMILARITY = 0.72;
const AUTO_MATCH_MIN_MARGIN = 0.08;
const MAX_CONCURRENT_FOOD_MATCHES = 4;

export interface RecipeImportDependencies {
    fetchPage?: (
        url: string,
        options?: RecipeUrlFetchDependencies & { rateLimitKey?: string },
    ) => Promise<FetchedRecipePage>;
    foodSearch?: Pick<FoodSearchService, "search">;
}

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
): {
    ingredient: RecipeImportDraft["recipe"]["ingredients"][number];
    review: RecipeImportDraft["ingredient_review"][number];
    warning?: RecipeImportWarning;
} {
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

async function enrichIngredient(
    ingredient: ParsedRecipeIngredient,
    sourceUrl: string,
    foodSearch: Pick<FoodSearchService, "search">,
    strategy: string,
): Promise<{
    ingredient: RecipeImportDraft["recipe"]["ingredients"][number];
    review: RecipeImportDraft["ingredient_review"][number];
    warning?: RecipeImportWarning;
}> {
    if (!ingredient.name.trim() || /\bto taste\b/i.test(ingredient.rawText)) {
        const result = unresolvedIngredient(
            ingredient,
            sourceUrl,
            [],
            "unresolved",
        );
        result.warning = warning(
            "food_match_unresolved",
            `Nutrition for “${ingredient.name}” was left unresolved because the source did not provide a measurable portion.`,
            "ingredients",
        );
        return result;
    }
    let result;
    try {
        result = await foodSearch.search(
            ingredient.name,
            MATCH_CANDIDATE_LIMIT,
        );
    } catch {
        const unresolved = unresolvedIngredient(
            ingredient,
            sourceUrl,
            [],
            "unresolved",
        );
        unresolved.warning = warning(
            "food_provider_unavailable",
            `Nutrition lookup for “${ingredient.name}” was unavailable; the ingredient can still be reviewed and saved.`,
            "ingredients",
        );
        return unresolved;
    }
    const candidates = result.candidates.slice(0, MATCH_CANDIDATE_LIMIT);
    if (candidates.length === 0) {
        return unresolvedIngredient(ingredient, sourceUrl, [], "unresolved");
    }
    const scored = candidates
        .map((candidate) => ({
            candidate,
            score: similarity(ingredient.name, candidate),
        }))
        .sort((left, right) => right.score - left.score);
    const top = scored[0]!;
    const second = scored[1];
    const exact = top.score === 1;
    const autoMatch =
        top.candidate.confidence >= AUTO_MATCH_MIN_CONFIDENCE &&
        (exact ||
            (top.score >= AUTO_MATCH_MIN_SIMILARITY &&
                (!second ||
                    top.score - second.score >= AUTO_MATCH_MIN_MARGIN)));
    const portion = selectPortion(ingredient, top.candidate.portions);
    const scale = portion ? portionScale(ingredient, portion) : null;
    if (!autoMatch || !portion || !scale || !Number.isFinite(scale.factor)) {
        return unresolvedIngredient(
            ingredient,
            sourceUrl,
            candidates,
            candidates.length > 1 ? "ambiguous" : "unresolved",
        );
    }
    const nutrients = nutrientFacts(portion, scale.factor);
    const provider = top.candidate.provider;
    const providerFoodId = top.candidate.providerFoodId;
    return {
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
            source_url: top.candidate.attribution.url,
            confidence: top.candidate.confidence,
            source_snapshot: {
                resolution_layer: "recipe_url",
                resolution: "matched",
                parser_strategy: strategy,
                raw_ingredient: ingredient.rawText,
                normalized_ingredient: ingredient.name,
                imported_source_url: sourceUrl,
                candidate_id: `${provider}:${providerFoodId}`,
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
            resolution: "matched",
            candidates: candidates
                .slice(0, MATCH_CANDIDATE_LIMIT)
                .map(summarizeFoodCandidate),
        },
    };
}

async function enrichIngredients(
    ingredients: ParsedRecipeIngredient[],
    sourceUrl: string,
    foodSearch: Pick<FoodSearchService, "search">,
    strategy: string,
) {
    const results: Awaited<ReturnType<typeof enrichIngredient>>[] = [];
    let next = 0;
    const worker = async () => {
        while (next < ingredients.length) {
            const index = next++;
            results[index] = await enrichIngredient(
                ingredients[index]!,
                sourceUrl,
                foodSearch,
                strategy,
            );
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
    return results;
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
    const enriched = await enrichIngredients(
        parsed.ingredients,
        sourceUrl,
        foodSearch,
        parsed.strategy,
    );
    const warnings = [...parsed.warnings];
    for (const entry of enriched)
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
        ingredients: enriched.map((entry) => entry.ingredient),
    };
    const calculation = calculateNutrition(toRecipeInput(recipe));
    const ingredientReview = enriched.map((entry, position) => ({
        ...entry.review,
        position,
    }));
    const hasUnresolved = ingredientReview.some(
        (entry) => entry.resolution !== "matched",
    );
    const requiresReview =
        hasUnresolved ||
        warnings.length > 0 ||
        parsed.instructions.length === 0 ||
        parsed.servings === 1;
    return {
        schema_version: 1,
        status: hasUnresolved || warnings.length > 0 ? "partial" : "ready",
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
        warnings,
    };
}
