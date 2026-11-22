import type { MatchDeciderDependencies } from "../decisions/match.js";
import {
    applySearchSeats,
    type SearchIntentDependencies,
} from "../decisions/search-intent.js";
import {
    naturalPortion,
    per100gPortion,
    sortPortionsNaturalFirst,
} from "../food-providers/portions.js";
import {
    encodeFoodCandidateId,
    getFoodSearchService,
    summarizeFoodCandidate,
} from "../food-providers/service.js";
import type {
    FoodCandidate,
    FoodPortion,
    NutrientValues,
} from "../food-providers/types.js";
import type { FoodProviderFailure } from "../food-providers/registry.js";
import { serializeFoodCandidate } from "../food-tools.js";
import {
    getSavedFood,
    listRecentMealItems,
    listSavedFoods,
    markSavedFoodUsed,
    searchRecentMealItems,
    searchSavedFoods,
    type RecentMealItemMemory,
    type SavedFoodRecord,
} from "../saved-foods/repository.js";
import { insertStructuredMeal } from "../structured-meals/repository.js";
import { nutrientsPerQuantity } from "./usuals.js";
import type {
    MealSourceType,
    StructuredMealItemInput,
} from "../structured-meals/types.js";

const NUTRIENT_KEYS = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "alcohol_g",
    "sodium_mg",
    "saturated_fat_g",
    "cholesterol_mg",
    "potassium_mg",
] as const satisfies readonly (keyof NutrientValues)[];

const SOURCE_TYPES = [
    "usda",
    "open_food_facts",
    "published_restaurant",
    "saved_food",
    "past_meal",
    "user_supplied",
    "model_estimate",
    "legacy_aggregate",
] as const satisfies readonly MealSourceType[];

export interface WebMealItemSelection {
    candidate_id?: unknown;
    saved_food_id?: unknown;
    portion_id?: unknown;
    name?: unknown;
    quantity?: unknown;
    portion_label?: unknown;
    gram_weight?: unknown;
    nutrients?: unknown;
    source_type?: unknown;
    provider?: unknown;
    provider_food_id?: unknown;
    source_url?: unknown;
    source_updated_at?: unknown;
    confidence?: unknown;
    assumptions?: unknown;
    source_snapshot?: unknown;
}

function boundedLimit(value: number | undefined): number {
    return Math.max(1, Math.min(25, value ?? 10));
}

function positive(value: unknown, label: string, fallback = 1): number {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be positive`);
    }
    return parsed;
}

function nonnegative(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${label} must be finite and nonnegative`);
    }
    return parsed;
}

function optionalPositive(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be positive`);
    }
    return parsed;
}

function sourceType(value: unknown): MealSourceType {
    if (
        typeof value === "string" &&
        (SOURCE_TYPES as readonly string[]).includes(value)
    ) {
        return value as MealSourceType;
    }
    return "user_supplied";
}

function text(
    value: unknown,
    label: string,
    maxLength: number,
): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.trim().length > maxLength) {
        throw new Error(`${label} is invalid`);
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function parseNutrients(value: unknown): NutrientValues {
    const input = record(value);
    const nutrients: NutrientValues = {};
    for (const key of NUTRIENT_KEYS) {
        const parsed = nonnegative(input[key], key);
        if (parsed !== undefined) nutrients[key] = parsed;
    }
    return nutrients;
}

export function scaleNutrients(
    nutrients: NutrientValues,
    factor: number,
): NutrientValues {
    if (!Number.isFinite(factor) || factor <= 0) {
        throw new Error("Nutrition scale must be positive");
    }
    const scaled: NutrientValues = {};
    for (const key of NUTRIENT_KEYS) {
        const value = nutrients[key];
        if (value !== undefined) {
            scaled[key] = Math.round(value * factor * 100) / 100;
        }
    }
    return scaled;
}

function serializeFailures(failures: FoodProviderFailure[]) {
    return failures.map((failure) => ({
        provider: failure.provider,
        code: failure.code,
        message: failure.message,
        retryAfterSeconds: failure.retryAfterSeconds ?? null,
    }));
}

export function serializeSavedFood(record: SavedFoodRecord) {
    return {
        id: record.id,
        label: record.label,
        defaultPortionId: record.defaultPortionId,
        useCount: record.useCount,
        lastUsedAt: record.lastUsedAt,
        food: serializeFoodCandidate(record.food),
    };
}

export function serializeRecentMealItem(record: RecentMealItemMemory) {
    const quantity =
        typeof record.quantity === "number" &&
        Number.isFinite(record.quantity) &&
        record.quantity > 0
            ? record.quantity
            : 1;
    return {
        mealId: record.mealId,
        itemId: record.itemId,
        name: record.name,
        quantity,
        portionLabel: record.portionLabel,
        nutrients: nutrientsPerQuantity(record.nutrients, record.quantity),
        sourceType: record.sourceType,
        provider: record.provider,
        providerFoodId: record.providerFoodId,
        confidence: record.confidence,
        loggedAt: record.loggedAt,
    };
}

export async function searchAppFoods(
    userId: string,
    query: string,
    limit?: number,
    matchDependencies: MatchDeciderDependencies = {},
    intentDependencies: SearchIntentDependencies = {},
) {
    const normalizedQuery = query.trim();
    const bounded = boundedLimit(limit);
    const [saved, recent, providerResult] = await Promise.all([
        normalizedQuery
            ? searchSavedFoods(userId, normalizedQuery, bounded)
            : listSavedFoods(userId, bounded),
        normalizedQuery
            ? searchRecentMealItems(userId, normalizedQuery, bounded)
            : listRecentMealItems(userId, bounded),
        normalizedQuery
            ? getFoodSearchService().search(normalizedQuery, bounded)
            : Promise.resolve({ candidates: [], failures: [] }),
    ]);
    // Search seats, provider candidates only (saved foods and recent
    // items are the user's own foods; a model never reorders those).
    // The Search Intent seat (src/decisions/search-intent.ts) pins
    // its pick — candidate + natural portion — to the top; Seat B2
    // (ambiguous-match decider, src/decisions/match.ts) runs only
    // when the intent seat applied no pin, on the untouched list,
    // with exactly its previous behaviour. MCP search_foods is
    // deliberately not wired (host-AI boundary; the host model
    // selects there).
    const ordered = normalizedQuery
        ? await applySearchSeats(normalizedQuery, providerResult.candidates, {
              intent: intentDependencies,
              match: matchDependencies,
          })
        : {
              candidates: providerResult.candidates,
              pinnedCandidateId: null,
              pinnedPortionId: null,
          };
    return {
        query: normalizedQuery,
        candidates: ordered.candidates.map((candidate) =>
            summarizeFoodCandidate(
                candidate,
                ordered.pinnedCandidateId &&
                    encodeFoodCandidateId(candidate) ===
                        ordered.pinnedCandidateId
                    ? { defaultPortionId: ordered.pinnedPortionId }
                    : undefined,
            ),
        ),
        providerFailures: serializeFailures(providerResult.failures),
        savedFoods: saved.map(serializeSavedFood),
        recentMealItems: recent.map(serializeRecentMealItem),
    };
}

export async function getAppFoodDetails(candidateId: string) {
    const candidate = await getFoodSearchService().details(candidateId);
    return candidate ? serializeFoodCandidate(candidate) : null;
}

export async function lookupAppFoodBarcode(barcode: string) {
    const result = await getFoodSearchService().barcode(barcode);
    return {
        candidates: result.candidates.map((candidate) =>
            summarizeFoodCandidate(candidate),
        ),
        providerFailures: serializeFailures(result.failures),
    };
}

function hasReportedCalories(nutrients: NutrientValues | undefined): boolean {
    return (
        nutrients?.calories !== undefined && Number.isFinite(nutrients.calories)
    );
}

function selectCandidatePortion(
    candidate: FoodCandidate,
    portionId: string | undefined,
): FoodPortion {
    const requested = portionId
        ? candidate.portions.find((item) => item.id === portionId)
        : undefined;
    const preferred =
        requested ??
        naturalPortion(candidate.portions) ??
        candidate.portions[0];
    if (preferred && hasReportedCalories(preferred.nutrients)) {
        return preferred;
    }
    const caloriePortions = candidate.portions.filter((item) =>
        hasReportedCalories(item.nutrients),
    );
    const fallback =
        naturalPortion(caloriePortions) ??
        sortPortionsNaturalFirst(caloriePortions)[0] ??
        (candidate.nutrientsPer100g &&
        hasReportedCalories(candidate.nutrientsPer100g)
            ? per100gPortion(candidate.nutrientsPer100g)
            : undefined);
    if (!fallback) {
        throw new Error("Food candidate has no usable portion with calories");
    }
    return fallback;
}

function candidateMealItem(
    candidate: FoodCandidate,
    candidateId: string,
    portionId: string | undefined,
    quantity: number,
    custom?: { portionLabel?: string; gramWeight?: number },
): StructuredMealItemInput {
    const portion = selectCandidatePortion(candidate, portionId);
    const customGramWeight = custom?.gramWeight;
    const hasCustomPortion =
        custom?.portionLabel !== undefined || customGramWeight !== undefined;
    // Custom portion (W2 logging math Finding 2): a caller-supplied
    // gram weight rescales the selected portion's nutrients by
    // customGramWeight / portion.gramWeight — or, when the portion
    // carries no gram weight of its own, the food's per-100g panel by
    // customGramWeight / 100. Without a gram reference the portion's
    // nutrients stand (ratio 1). The client preview computes the
    // identical single-step scale so preview === saved.
    let baseNutrients = portion.nutrients;
    let gramRatio = 1;
    if (customGramWeight !== undefined) {
        if (portion.gramWeight !== undefined && portion.gramWeight > 0) {
            gramRatio = customGramWeight / portion.gramWeight;
        } else if (
            candidate.nutrientsPer100g &&
            hasReportedCalories(candidate.nutrientsPer100g)
        ) {
            baseNutrients = candidate.nutrientsPer100g;
            gramRatio = customGramWeight / 100;
        }
    }
    const unitGramWeight = customGramWeight ?? portion.gramWeight;
    const portionLabel =
        custom?.portionLabel ??
        (customGramWeight !== undefined &&
        customGramWeight !== portion.gramWeight
            ? `${customGramWeight} g`
            : portion.label);
    const name = [candidate.brand, candidate.name]
        .filter(Boolean)
        .join(" — ")
        .slice(0, 500);
    return {
        name,
        quantity,
        portionLabel,
        gramWeight:
            unitGramWeight === undefined
                ? undefined
                : Math.round(unitGramWeight * quantity * 100) / 100,
        nutrients: scaleNutrients(baseNutrients, gramRatio * quantity),
        sourceType: candidate.provider,
        provider: candidate.provider,
        providerFoodId: candidate.providerFoodId,
        providerRevision: candidate.sourceUpdatedAt,
        sourceUrl: candidate.attribution.url,
        sourceUpdatedAt: candidate.sourceUpdatedAt,
        confidence: candidate.confidence,
        assumptions: [],
        sourceSnapshot: {
            resolution_layer: hasCustomPortion
                ? "food_search_custom_portion"
                : "food_search",
            candidate_id: candidateId,
            provider: candidate.provider,
            provider_food_id: candidate.providerFoodId,
            selected_portion_id: portion.id,
            selected_portion_label: portion.label,
            ...(hasCustomPortion && portion.gramWeight !== undefined
                ? { selected_portion_gram_weight: portion.gramWeight }
                : {}),
            ...(customGramWeight !== undefined
                ? { custom_gram_weight: customGramWeight }
                : {}),
            selected_quantity: quantity,
            nutrition_snapshot: portion.nutrients,
        },
    };
}

function savedFoodMealItem(
    saved: SavedFoodRecord,
    portionId: string | undefined,
    quantity: number,
    custom?: { portionLabel?: string; gramWeight?: number },
): StructuredMealItemInput {
    const item = candidateMealItem(
        saved.food,
        `saved_food:${saved.id}`,
        portionId,
        quantity,
        custom,
    );
    return {
        ...item,
        sourceType: "saved_food",
        sourceSnapshot: {
            ...item.sourceSnapshot,
            resolution_layer: "saved_food",
            saved_food_id: saved.id,
            saved_food_label: saved.label,
        },
    };
}

function suppliedMealItem(
    input: WebMealItemSelection,
): StructuredMealItemInput {
    const name = text(input.name, "Meal item name", 500);
    if (!name) throw new Error("Meal item name is required");
    const quantity = positive(input.quantity, "Meal item quantity");
    const nutrients = scaleNutrients(parseNutrients(input.nutrients), quantity);
    if (Object.keys(nutrients).length === 0) {
        throw new Error(`Nutrition is required for ${name}`);
    }
    if (!hasReportedCalories(nutrients)) {
        throw new Error(`Nutrition calories are required for ${name}`);
    }
    const assumptions = Array.isArray(input.assumptions)
        ? input.assumptions
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
              .slice(0, 20)
        : [];
    const sourceSnapshot = record(input.source_snapshot);
    return {
        name,
        quantity,
        portionLabel: text(input.portion_label, "Meal item portion", 500),
        gramWeight: nonnegative(input.gram_weight, "Meal item gram weight"),
        nutrients,
        sourceType: sourceType(input.source_type),
        provider: text(input.provider, "Meal item provider", 100),
        providerFoodId: text(
            input.provider_food_id,
            "Meal item provider food ID",
            255,
        ),
        sourceUrl: text(input.source_url, "Meal item source URL", 2_000),
        sourceUpdatedAt: text(
            input.source_updated_at,
            "Meal item source date",
            100,
        ),
        confidence: nonnegative(input.confidence, "Meal item confidence"),
        assumptions,
        sourceSnapshot: {
            ...sourceSnapshot,
            resolution_layer:
                sourceSnapshot.resolution_layer ?? "personal_or_manual",
        },
    };
}

export async function resolveWebMealItem(
    userId: string,
    input: WebMealItemSelection,
): Promise<StructuredMealItemInput> {
    // Custom portion fields (W2 logging math Finding 2): a supplied
    // portion_label / gram_weight only takes effect on the candidate
    // and saved-food paths, where the server stays authoritative for
    // the underlying food. Supplied items keep their own semantics.
    const customPortionLabel = text(
        input.portion_label,
        "Meal item portion",
        500,
    );
    const customGramWeight = optionalPositive(
        input.gram_weight,
        "Meal item gram weight",
    );
    const custom =
        customPortionLabel !== undefined || customGramWeight !== undefined
            ? {
                  portionLabel: customPortionLabel,
                  gramWeight: customGramWeight,
              }
            : undefined;
    const savedFoodId = text(input.saved_food_id, "Saved food ID", 100);
    if (savedFoodId) {
        const saved = await getSavedFood(userId, savedFoodId);
        if (!saved) throw new Error("Saved food is no longer available");
        return savedFoodMealItem(
            saved,
            text(input.portion_id, "Food portion ID", 200) ??
                saved.defaultPortionId ??
                undefined,
            positive(input.quantity, "Food quantity"),
            custom,
        );
    }
    const candidateId = text(input.candidate_id, "Food candidate ID", 300);
    if (candidateId) {
        const candidate = await getFoodSearchService().details(candidateId);
        if (!candidate) {
            throw new Error(
                "Food candidate is invalid or expired; search again before logging",
            );
        }
        return candidateMealItem(
            candidate,
            candidateId,
            text(input.portion_id, "Food portion ID", 200),
            positive(input.quantity, "Food quantity"),
            custom,
        );
    }
    return suppliedMealItem(input);
}

export async function createAppMeal(
    userId: string,
    input: {
        description: unknown;
        mealType: unknown;
        loggedAt?: unknown;
        notes?: unknown;
        idempotencyKey?: unknown;
        items: WebMealItemSelection[];
    },
    deps: {
        resolveItem?: typeof resolveWebMealItem;
        insertMeal?: typeof insertStructuredMeal;
        markUsed?: typeof markSavedFoodUsed;
    } = {},
) {
    const resolveItem = deps.resolveItem ?? resolveWebMealItem;
    const insertMeal = deps.insertMeal ?? insertStructuredMeal;
    const markUsed = deps.markUsed ?? markSavedFoodUsed;
    const description = text(input.description, "Meal description", 500);
    if (!description) throw new Error("Meal description is required");
    if (
        input.mealType !== "breakfast" &&
        input.mealType !== "lunch" &&
        input.mealType !== "dinner" &&
        input.mealType !== "snack"
    ) {
        throw new Error("Invalid meal type");
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
        throw new Error("Add at least one food to the meal");
    }
    if (input.items.length > 100) {
        throw new Error("A meal cannot contain more than 100 foods");
    }
    const loggedAt = text(input.loggedAt, "Meal logged date", 100);
    const notes = text(input.notes, "Meal notes", 4_000);
    const idempotencyKey =
        text(input.idempotencyKey, "Meal idempotency key", 255) ??
        crypto.randomUUID();
    const items = await Promise.all(
        input.items.map((item) => resolveItem(userId, item)),
    );
    const savedFoodIds = [
        ...new Set(
            input.items
                .map((item) => item.saved_food_id)
                .filter(
                    (value): value is string =>
                        typeof value === "string" && Boolean(value.trim()),
                ),
        ),
    ];
    const result = await insertMeal(userId, {
        description,
        mealType: input.mealType,
        loggedAt,
        notes,
        idempotencyKey,
        items,
    });
    if (!result.deduplicated && savedFoodIds.length > 0) {
        await Promise.allSettled(
            savedFoodIds.map((savedFoodId) => markUsed(userId, savedFoodId)),
        );
    }
    return result;
}
