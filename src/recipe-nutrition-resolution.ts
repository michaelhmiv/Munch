import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    getFoodSearchService,
    type FoodSearchService,
} from "./food-providers/service.js";
import { scaleNutrients } from "./food-providers/nutrients.js";
import type {
    FoodCandidate,
    FoodPortion,
    NutrientValues,
} from "./food-providers/types.js";

const CORE_NUTRIENTS = ["calories", "protein_g", "carbs_g", "fat_g"] as const;
const SUPPORTED_NUTRIENTS = [
    ...CORE_NUTRIENTS,
    "fiber_g",
    "sugar_g",
    "sodium_mg",
] as const;
const LOW_IMPACT_PATTERN =
    /\b(salt|pepper|seasoning|spice|thyme|parsley|bay leaves?|oregano|basil|rosemary|sage|paprika)\b/i;
const COUNT_UNITS = new Set([
    "each",
    "piece",
    "item",
    "whole",
    "breast",
    "crust",
    "clove",
    "stalk",
    "sprig",
    "slice",
]);
const MIN_CANDIDATE_SCORE = 0.52;
const RESOLVER_VERSION = 1;

export type RecipeNutrientFacts = Partial<
    Record<(typeof SUPPORTED_NUTRIENTS)[number], number>
>;

export interface RecipeNutritionIngredientPayload {
    name: string;
    quantity?: number;
    unit?: string;
    preparation?: string;
    optional?: boolean;
    gram_weight?: number;
    nutrients?: RecipeNutrientFacts;
    provider?: string;
    provider_food_id?: string;
    source_type: string;
    source_url?: string;
    confidence?: number;
    source_snapshot?: Record<string, unknown>;
}

export interface RecipeNutritionPayload {
    name: string;
    servings: number;
    ingredients: RecipeNutritionIngredientPayload[];
    [key: string]: unknown;
}

export interface RecipeNutritionResolution {
    recipe: RecipeNutritionPayload;
    providerMatches: number;
    lowImpactEstimates: number;
    unresolved: number;
    estimatedPositions: number[];
    unresolvedPositions: number[];
}

export interface RecipeNutritionResolutionDependencies {
    foodSearch?: Pick<FoodSearchService, "search">;
}

type ToolServer = {
    registerTool: (
        name: string,
        config: Record<string, any>,
        handler: (args: Record<string, any>) => Promise<any> | any,
    ) => unknown;
};

type SearchPlan = {
    query: string;
    assumptions: string[];
};

type PortionResolution = {
    gramWeight?: number;
    nutrients: RecipeNutrientFacts;
    portionId: string;
    portionLabel: string;
    factor: number;
    assumption?: string;
};

function normalizeText(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function singularToken(token: string): string {
    if (token.endsWith("ies") && token.length > 4)
        return `${token.slice(0, -3)}y`;
    if (token.endsWith("ses") && token.length > 4) return token.slice(0, -2);
    if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
        return token.slice(0, -1);
    }
    return token;
}

function tokens(value: string): Set<string> {
    return new Set(
        normalizeText(value).split(" ").filter(Boolean).map(singularToken),
    );
}

function normalizeUnit(value: string | undefined): string {
    const normalized = normalizeText(value ?? "");
    const aliases: Record<string, string> = {
        cups: "cup",
        tablespoons: "tbsp",
        tablespoon: "tbsp",
        tbsp: "tbsp",
        teaspoons: "tsp",
        teaspoon: "tsp",
        tsp: "tsp",
        ounces: "oz",
        ounce: "oz",
        grams: "g",
        gram: "g",
        kilograms: "kg",
        kilogram: "kg",
        pounds: "lb",
        pound: "lb",
        breasts: "breast",
        crusts: "crust",
        cloves: "clove",
        slices: "slice",
        pieces: "piece",
        items: "item",
    };
    return aliases[normalized] ?? singularToken(normalized);
}

function unitTerms(unit: string): string[] {
    const terms: Record<string, string[]> = {
        cup: ["cup"],
        tbsp: ["tbsp", "tablespoon"],
        tsp: ["tsp", "teaspoon"],
        oz: ["oz", "ounce"],
        lb: ["lb", "pound"],
        g: ["g", "gram"],
        kg: ["kg", "kilogram"],
        breast: ["breast", "piece"],
        crust: ["crust", "piece"],
        clove: ["clove", "piece"],
        slice: ["slice"],
        piece: ["piece", "item"],
        each: ["each", "piece", "item", "whole"],
        whole: ["whole", "piece", "item"],
    };
    return terms[unit] ?? [unit];
}

function hasCoreNutrition(nutrients: RecipeNutrientFacts | undefined): boolean {
    return CORE_NUTRIENTS.every((key) => nutrients?.[key] !== undefined);
}

function supportedNutrients(values: NutrientValues): RecipeNutrientFacts {
    const result: RecipeNutrientFacts = {};
    for (const key of SUPPORTED_NUTRIENTS) {
        const value = values[key];
        if (value !== undefined && Number.isFinite(value) && value >= 0) {
            result[key] = Number(value.toFixed(2));
        }
    }
    return result;
}

function searchPlan(ingredient: RecipeNutritionIngredientPayload): SearchPlan {
    const name = normalizeText(ingredient.name);
    const preparation = normalizeText(ingredient.preparation ?? "");
    const assumptions: string[] = [];

    if (/\bpie crust\b/.test(name)) {
        assumptions.push(
            "Unspecified pie crust resolved as a standard refrigerated regular unbaked pie crust.",
        );
        return { query: "pie crust refrigerated regular unbaked", assumptions };
    }
    if (/^milk$/.test(name)) {
        assumptions.push("Unspecified milk resolved as generic whole milk.");
        return { query: "milk whole", assumptions };
    }
    if (
        /\bmixed vegetable\b/.test(name) &&
        /\bfrozen\b/.test(`${name} ${preparation}`)
    ) {
        assumptions.push(
            "Frozen mixed vegetables resolved as a generic classic frozen mix cooked without added fat.",
        );
        return {
            query: "classic mixed vegetables frozen cooked no added fat",
            assumptions,
        };
    }
    if (
        /\bchicken breast\b/.test(name) &&
        /\bcooked\b/.test(`${name} ${preparation}`)
    ) {
        assumptions.push(
            "Unspecified cooked chicken breasts resolved as generic cooked boneless skinless chicken breast pieces.",
        );
        return {
            query: "chicken breast skinless boneless cooked braised",
            assumptions,
        };
    }
    if (/\bchicken broth\b/.test(name)) {
        assumptions.push(
            "Chicken broth resolved as generic ready-to-serve chicken broth.",
        );
        return { query: "chicken broth ready to serve", assumptions };
    }
    if (/\ball purpose flour\b/.test(name)) {
        assumptions.push(
            "All-purpose flour resolved as generic enriched white all-purpose flour.",
        );
        return { query: "wheat flour white all-purpose enriched", assumptions };
    }
    if (/^onions?$/.test(name)) {
        assumptions.push("Unspecified onion resolved as generic raw onion.");
        return { query: "onions raw", assumptions };
    }

    const form = preparation.match(
        /\b(raw|cooked|grilled|roasted|boiled|frozen)\b/,
    )?.[1];
    return {
        query: [ingredient.name, form].filter(Boolean).join(" "),
        assumptions,
    };
}

function candidateScore(query: string, candidate: FoodCandidate): number {
    const queryTokens = tokens(query);
    const candidateTokens = tokens(candidate.name);
    if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
    let overlap = 0;
    for (const token of queryTokens) {
        if (candidateTokens.has(token)) overlap += 1;
    }
    const recall = overlap / queryTokens.size;
    const precision = overlap / candidateTokens.size;
    const lexical =
        recall + precision === 0
            ? 0
            : (2 * recall * precision) / (recall + precision);
    const exact =
        normalizeText(query) === normalizeText(candidate.name) ? 0.2 : 0;
    const generic = candidate.dataKind === "generic" ? 0.14 : 0;
    const packagedPenalty =
        candidate.dataKind === "packaged" || candidate.dataKind === "branded"
            ? 0.08
            : 0;
    return (
        lexical +
        exact +
        generic +
        candidate.confidence * 0.08 -
        packagedPenalty
    );
}

function chooseCandidate(
    query: string,
    candidates: FoodCandidate[],
): FoodCandidate | undefined {
    return candidates
        .map((candidate) => ({
            candidate,
            score: candidateScore(query, candidate),
        }))
        .filter(
            ({ candidate, score }) =>
                score >= MIN_CANDIDATE_SCORE && candidate.confidence >= 0.75,
        )
        .sort((left, right) => right.score - left.score)[0]?.candidate;
}

function portionText(portion: FoodPortion): string {
    return normalizeText(`${portion.unit} ${portion.label}`);
}

function portionForUnit(
    portions: FoodPortion[],
    unit: string,
): FoodPortion | undefined {
    if (!unit) {
        return portions.find((portion) => portion.id !== "100g") ?? portions[0];
    }
    const terms = unitTerms(unit);
    const exact = portions.find(
        (portion) => normalizeUnit(portion.unit) === unit,
    );
    if (exact) return exact;
    const labelMatch = portions.find((portion) => {
        const text = portionText(portion);
        return terms.some((term) =>
            text.split(" ").includes(singularToken(term)),
        );
    });
    if (labelMatch) return labelMatch;
    if (COUNT_UNITS.has(unit)) {
        return portions.find((portion) => {
            const text = portionText(portion);
            return /\b(each|piece|item|whole)\b/.test(text);
        });
    }
    return undefined;
}

function resolvePortion(
    ingredient: RecipeNutritionIngredientPayload,
    candidate: FoodCandidate,
): PortionResolution | null {
    const quantity = ingredient.quantity;
    if (ingredient.gram_weight !== undefined && candidate.nutrientsPer100g) {
        return {
            gramWeight: ingredient.gram_weight,
            nutrients: supportedNutrients(
                scaleNutrients(
                    candidate.nutrientsPer100g,
                    ingredient.gram_weight / 100,
                ),
            ),
            portionId: "100g",
            portionLabel: `${ingredient.gram_weight} g`,
            factor: ingredient.gram_weight / 100,
        };
    }
    if (quantity === undefined) return null;

    const unit = normalizeUnit(ingredient.unit);
    const weightGrams =
        unit === "g"
            ? quantity
            : unit === "kg"
              ? quantity * 1_000
              : unit === "oz"
                ? quantity * 28.349523125
                : unit === "lb"
                  ? quantity * 453.59237
                  : null;
    if (weightGrams !== null && candidate.nutrientsPer100g) {
        return {
            gramWeight: Number(weightGrams.toFixed(2)),
            nutrients: supportedNutrients(
                scaleNutrients(candidate.nutrientsPer100g, weightGrams / 100),
            ),
            portionId: "100g",
            portionLabel: `${Number(weightGrams.toFixed(2))} g`,
            factor: weightGrams / 100,
        };
    }

    const portion = portionForUnit(candidate.portions, unit);
    if (!portion || !Number.isFinite(portion.amount) || portion.amount <= 0)
        return null;
    const factor = quantity / portion.amount;
    const scaled = supportedNutrients(
        scaleNutrients(portion.nutrients, factor),
    );
    if (!hasCoreNutrition(scaled)) return null;
    return {
        gramWeight:
            portion.gramWeight === undefined
                ? undefined
                : Number((portion.gramWeight * factor).toFixed(2)),
        nutrients: scaled,
        portionId: portion.id,
        portionLabel: portion.label,
        factor,
        assumption:
            unit && normalizeUnit(portion.unit) !== unit
                ? `Used provider portion \"${portion.label}\" to interpret ${quantity} ${ingredient.unit ?? unit}.`
                : undefined,
    };
}

function lowImpactEstimate(
    ingredient: RecipeNutritionIngredientPayload,
): RecipeNutritionIngredientPayload {
    const assumption =
        "No measurable amount was supplied for this low-impact seasoning; calories and core macros were treated as zero and sodium was left unknown.";
    return {
        ...ingredient,
        nutrients: {
            calories: 0,
            protein_g: 0,
            carbs_g: 0,
            fat_g: 0,
            fiber_g: 0,
            sugar_g: 0,
        },
        source_type: "model_estimate",
        confidence: Math.max(ingredient.confidence ?? 0, 0.85),
        source_snapshot: {
            ...(ingredient.source_snapshot ?? {}),
            automatic_nutrition: {
                resolver_version: RESOLVER_VERSION,
                resolution: "low_impact_zero",
                estimated: true,
                assumptions: [assumption],
            },
        },
    };
}

async function resolveIngredient(
    ingredient: RecipeNutritionIngredientPayload,
    foodSearch: Pick<FoodSearchService, "search">,
): Promise<{
    ingredient: RecipeNutritionIngredientPayload;
    kind: "preserved" | "provider" | "low_impact" | "unresolved";
}> {
    if (hasCoreNutrition(ingredient.nutrients)) {
        return { ingredient, kind: "preserved" };
    }
    if (
        ingredient.quantity === undefined &&
        LOW_IMPACT_PATTERN.test(ingredient.name)
    ) {
        return {
            ingredient: lowImpactEstimate(ingredient),
            kind: "low_impact",
        };
    }
    if (
        ingredient.quantity === undefined &&
        ingredient.gram_weight === undefined
    ) {
        return {
            ingredient: {
                ...ingredient,
                source_snapshot: {
                    ...(ingredient.source_snapshot ?? {}),
                    automatic_nutrition: {
                        resolver_version: RESOLVER_VERSION,
                        resolution: "unresolved",
                        reason: "missing_material_quantity",
                    },
                },
            },
            kind: "unresolved",
        };
    }

    const plan = searchPlan(ingredient);
    try {
        const search = await foodSearch.search(plan.query, 8);
        const selected = chooseCandidate(plan.query, search.candidates);
        if (!selected) {
            return {
                ingredient: {
                    ...ingredient,
                    source_snapshot: {
                        ...(ingredient.source_snapshot ?? {}),
                        automatic_nutrition: {
                            resolver_version: RESOLVER_VERSION,
                            resolution: "unresolved",
                            query: plan.query,
                            reason: "no_defensible_provider_match",
                            candidate_count: search.candidates.length,
                        },
                    },
                },
                kind: "unresolved",
            };
        }
        const portion = resolvePortion(ingredient, selected);
        if (!portion || !hasCoreNutrition(portion.nutrients)) {
            return {
                ingredient: {
                    ...ingredient,
                    source_snapshot: {
                        ...(ingredient.source_snapshot ?? {}),
                        automatic_nutrition: {
                            resolver_version: RESOLVER_VERSION,
                            resolution: "unresolved",
                            query: plan.query,
                            provider: selected.provider,
                            provider_food_id: selected.providerFoodId,
                            reason: "no_compatible_provider_portion",
                        },
                    },
                },
                kind: "unresolved",
            };
        }

        const assumptions = [...plan.assumptions];
        if (portion.assumption) assumptions.push(portion.assumption);
        const confidenceCap = assumptions.length > 0 ? 0.9 : 0.96;
        return {
            ingredient: {
                ...ingredient,
                gram_weight: portion.gramWeight ?? ingredient.gram_weight,
                nutrients: {
                    ...portion.nutrients,
                    ...(ingredient.nutrients ?? {}),
                },
                provider: selected.attribution.label,
                provider_food_id: selected.providerFoodId,
                source_type: selected.provider,
                source_url: selected.attribution.url ?? ingredient.source_url,
                confidence: Math.min(selected.confidence, confidenceCap),
                source_snapshot: {
                    ...(ingredient.source_snapshot ?? {}),
                    automatic_nutrition: {
                        resolver_version: RESOLVER_VERSION,
                        resolution:
                            assumptions.length > 0
                                ? "assumed_provider_match"
                                : "provider_match",
                        estimated: true,
                        query: plan.query,
                        provider: selected.provider,
                        provider_food_id: selected.providerFoodId,
                        provider_food_name: selected.name,
                        provider_data_kind: selected.dataKind,
                        portion_id: portion.portionId,
                        portion_label: portion.portionLabel,
                        portion_factor: Number(portion.factor.toFixed(6)),
                        gram_weight: portion.gramWeight ?? null,
                        assumptions,
                    },
                },
            },
            kind: "provider",
        };
    } catch (error) {
        return {
            ingredient: {
                ...ingredient,
                source_snapshot: {
                    ...(ingredient.source_snapshot ?? {}),
                    automatic_nutrition: {
                        resolver_version: RESOLVER_VERSION,
                        resolution: "unresolved",
                        query: plan.query,
                        reason: "provider_resolution_error",
                        error_name:
                            error instanceof Error ? error.name : "unknown",
                    },
                },
            },
            kind: "unresolved",
        };
    }
}

export async function resolveRecipeNutrition(
    recipe: RecipeNutritionPayload,
    dependencies: RecipeNutritionResolutionDependencies = {},
): Promise<RecipeNutritionResolution> {
    const foodSearch = dependencies.foodSearch ?? getFoodSearchService();
    const settled = await Promise.all(
        recipe.ingredients.map((ingredient) =>
            resolveIngredient(ingredient, foodSearch),
        ),
    );
    let providerMatches = 0;
    let lowImpactEstimates = 0;
    let unresolved = 0;
    const estimatedPositions: number[] = [];
    const unresolvedPositions: number[] = [];
    settled.forEach((result, position) => {
        if (result.kind === "provider") {
            providerMatches += 1;
            estimatedPositions.push(position);
        } else if (result.kind === "low_impact") {
            lowImpactEstimates += 1;
            estimatedPositions.push(position);
        } else if (result.kind === "unresolved") {
            unresolved += 1;
            unresolvedPositions.push(position);
        }
    });
    return {
        recipe: {
            ...recipe,
            ingredients: settled.map((result) => result.ingredient),
        },
        providerMatches,
        lowImpactEstimates,
        unresolved,
        estimatedPositions,
        unresolvedPositions,
    };
}

function enhancedDescription(description: string): string {
    return `${description} If an ordinary ingredient arrives without nutrient facts, Munch automatically attempts provider-backed nutrition resolution before persistence. It preserves explicit nutrition, uses the existing Munch food catalog/USDA/Open Food Facts pipeline, records gram weights, provider IDs, confidence, and assumptions in source_snapshot, and treats unmeasured low-impact seasonings as zero core macros. Ordinary ambiguity should produce an estimate rather than blank nutrition; truly unresolved material ingredients may still produce partial or unavailable nutrition.`;
}

export function withRecipeNutritionResolution(server: McpServer): McpServer {
    const originalRegisterTool = (
        server as unknown as ToolServer
    ).registerTool.bind(server);
    return new Proxy(server, {
        get(target, property) {
            if (property === "registerTool") {
                return (
                    name: string,
                    config: Record<string, any>,
                    handler: (args: Record<string, any>) => Promise<any> | any,
                ) => {
                    if (
                        name !== "save_recipe" &&
                        name !== "save_recipe_and_plan"
                    ) {
                        return originalRegisterTool(name, config, handler);
                    }
                    return originalRegisterTool(
                        name,
                        {
                            ...config,
                            description: enhancedDescription(
                                String(config.description ?? "Save a recipe."),
                            ),
                        },
                        async (args: Record<string, any>) => {
                            const startedAt = performance.now();
                            const resolution = await resolveRecipeNutrition(
                                args.recipe as RecipeNutritionPayload,
                            );
                            const result = await handler({
                                ...args,
                                recipe: resolution.recipe,
                            });
                            console.info(
                                `[recipe_nutrition] operation=${name} provider_matches=${resolution.providerMatches} low_impact_estimates=${resolution.lowImpactEstimates} unresolved=${resolution.unresolved} estimated_positions=${resolution.estimatedPositions.join(",") || "none"} unresolved_positions=${resolution.unresolvedPositions.join(",") || "none"} total_ms=${Math.round(performance.now() - startedAt)}`,
                            );
                            if (
                                Array.isArray(result?.content) &&
                                resolution.estimatedPositions.length > 0
                            ) {
                                const textItem = result.content.find(
                                    (item: any) =>
                                        item?.type === "text" &&
                                        typeof item.text === "string",
                                );
                                if (textItem) {
                                    textItem.text = `${textItem.text}\n\nNutrition: Munch automatically resolved ${resolution.providerMatches} ingredient${resolution.providerMatches === 1 ? "" : "s"} from verified food data and applied ${resolution.lowImpactEstimates} low-impact seasoning estimate${resolution.lowImpactEstimates === 1 ? "" : "s"}. Assumptions and provider provenance are stored with the recipe ingredients.`;
                                }
                            }
                            return result;
                        },
                    );
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as McpServer;
}
