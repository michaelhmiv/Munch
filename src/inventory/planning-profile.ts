import {
    encodeFoodCandidateId,
    getFoodSearchService,
} from "../food-providers/service.js";
import type { FoodCandidate, NutrientValues } from "../food-providers/types.js";
import { withUserDatabase } from "../platform/database.js";
import { normalizeInventoryName } from "./matching.js";

export const PANTRY_PLANNING_PROFILE_VERSION = 1;

export type PantryPlanningProfileStatus =
    "resolved" | "partial" | "unresolved" | "failed";
export type PantryPlanningProfileSource =
    | "provider"
    | "heuristic"
    | "user_supplied"
    | "model_estimate"
    | "unresolved";

export interface PantryPlanningProfile {
    inventory_item_id: string;
    profile_status: PantryPlanningProfileStatus;
    source_type: PantryPlanningProfileSource;
    source_provider: string | null;
    source_food_id: string | null;
    match_confidence: number | null;
    category: string;
    culinary_roles: string[];
    basis_quantity: number | null;
    basis_unit: string | null;
    basis_grams: number | null;
    nutrients: {
        calories: number | null;
        protein_g: number | null;
        carbs_g: number | null;
        fat_g: number | null;
        fiber_g: number | null;
        sugar_g: number | null;
        sodium_mg: number | null;
    };
    profile_version: number;
    enriched_at: string | null;
    updated_at: string;
}

export interface PantryPlanningClassification {
    category: string;
    culinaryRoles: string[];
}

type InventoryIdentity = {
    id: string;
    name: string;
    normalized_name: string;
    food_provider: string | null;
    provider_food_id: string | null;
    barcode: string | null;
};

function enabledFlag(value: string | undefined): boolean {
    return ["true", "1", "on", "yes"].includes(
        value?.trim().toLowerCase() ?? "",
    );
}

export function pantryPlanningEnabled(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return enabledFlag(env.MUNCH_PANTRY_PLANNING_ENABLED);
}

const ROLE_RULES: Array<{
    category: string;
    roles: string[];
    pattern: RegExp;
}> = [
    {
        category: "spice",
        roles: ["seasoning", "flavor-builder"],
        pattern:
            /\b(cumin|paprika|turmeric|coriander|cinnamon|nutmeg|clove|allspice|cayenne|chili powder|garlic powder|onion powder|seasoning|black pepper|white pepper|ground pepper|peppercorns?|salt)\b/,
    },
    {
        category: "herb",
        roles: ["herb", "flavor-builder", "garnish"],
        pattern:
            /\b(basil|oregano|thyme|rosemary|parsley|cilantro|dill|sage|mint|chive|scallion|green onion)\b/,
    },
    {
        category: "sauce_condiment",
        roles: ["sauce", "condiment", "flavor-builder"],
        pattern:
            /\b(soy sauce|tamari|worcestershire|hot sauce|salsa|ketchup|mustard|mayo|mayonnaise|gochujang|sriracha|teriyaki|barbecue|bbq|pesto|tahini|dressing)\b/,
    },
    {
        category: "acid",
        roles: ["acid", "flavor-builder", "finisher"],
        pattern: /\b(lime|lemon|vinegar|rice vinegar|apple cider vinegar)\b/,
    },
    {
        category: "cooking_fat",
        roles: ["cooking-fat", "fat", "flavor-builder"],
        pattern:
            /\b(olive oil|avocado oil|vegetable oil|canola oil|coconut oil|sesame oil|butter|ghee)\b/,
    },
    {
        category: "aromatic",
        roles: ["aromatic", "flavor-builder"],
        pattern: /\b(garlic|onion|shallot|ginger|leek|celery)\b/,
    },
    {
        category: "protein",
        roles: ["protein", "main"],
        pattern:
            /\b(chicken|turkey|beef|steak|ground beef|pork|ham|sausage|salmon|tuna|shrimp|fish|tofu|tempeh|seitan)\b/,
    },
    {
        category: "egg",
        roles: ["protein", "main", "binder"],
        pattern: /\b(egg|eggs|egg white|egg whites)\b/,
    },
    {
        category: "dairy",
        roles: ["dairy", "creamy", "topping"],
        pattern:
            /\b(cottage cheese|greek yogurt|yogurt|cheese|cheddar|mozzarella|parmesan|feta|milk|cream|sour cream)\b/,
    },
    {
        category: "legume",
        roles: ["protein", "fiber", "base", "side"],
        pattern:
            /\b(bean|beans|lentil|lentils|chickpea|chickpeas|edamame|peas)\b/,
    },
    {
        category: "grain_starch",
        roles: ["starch", "base", "side"],
        pattern:
            /\b(rice|quinoa|oat|oats|pasta|noodle|noodles|bread|tortilla|tortillas|potato|potatoes|sweet potato|sweet potatoes|couscous|barley)\b/,
    },
    {
        category: "produce",
        roles: ["vegetable", "produce", "side"],
        pattern:
            /\b(spinach|kale|broccoli|bell pepper|bell peppers|pepper|peppers|carrot|carrots|cucumber|zucchini|squash|tomato|tomatoes|lettuce|cabbage|mushroom|mushrooms|corn|asparagus|green bean|green beans)\b/,
    },
    {
        category: "fruit",
        roles: ["fruit", "produce", "topping"],
        pattern:
            /\b(apple|banana|berry|berries|blueberry|strawberry|orange|mango|pineapple|grape|peach|pear|avocado)\b/,
    },
    {
        category: "nuts_seeds",
        roles: ["fat", "protein", "topping", "texture"],
        pattern:
            /\b(almond|peanut|walnut|pecan|cashew|pistachio|chia|flax|sesame seed|sunflower seed)\b/,
    },
];

export function classifyPantryFood(name: string): PantryPlanningClassification {
    const normalized = normalizeInventoryName(name);
    for (const rule of ROLE_RULES) {
        if (rule.pattern.test(normalized)) {
            const roles = new Set(rule.roles);
            if (
                rule.category === "dairy" &&
                /\b(cottage cheese|greek yogurt|skyr)\b/.test(normalized)
            ) {
                roles.add("protein");
            }
            if (normalized.includes("smoked paprika")) roles.add("smoky");
            if (/\b(cumin|chili powder|salsa)\b/.test(normalized)) {
                roles.add("mexican-tex-mex");
            }
            if (
                /\b(soy sauce|sesame oil|gochujang|ginger)\b/.test(normalized)
            ) {
                roles.add("east-asian");
            }
            return {
                category: rule.category,
                culinaryRoles: [...roles].sort(),
            };
        }
    }
    return { category: "other", culinaryRoles: ["ingredient"] };
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : null;
}

function compactNutrients(values?: NutrientValues) {
    return {
        calories: finiteOrNull(values?.calories),
        protein_g: finiteOrNull(values?.protein_g),
        carbs_g: finiteOrNull(values?.carbs_g),
        fat_g: finiteOrNull(values?.fat_g),
        fiber_g: finiteOrNull(values?.fiber_g),
        sugar_g: finiteOrNull(values?.sugar_g),
        sodium_mg: finiteOrNull(values?.sodium_mg),
    };
}

function hasCoreNutrition(
    values: ReturnType<typeof compactNutrients>,
): boolean {
    return (
        values.calories !== null ||
        values.protein_g !== null ||
        values.carbs_g !== null ||
        values.fat_g !== null
    );
}

function candidateBasis(candidate: FoodCandidate) {
    const per100g = compactNutrients(candidate.nutrientsPer100g);
    if (hasCoreNutrition(per100g)) {
        return {
            basisQuantity: 100,
            basisUnit: "g",
            basisGrams: 100,
            nutrients: per100g,
        };
    }
    const portion = candidate.portions.find((value) =>
        hasCoreNutrition(compactNutrients(value.nutrients)),
    );
    if (portion) {
        return {
            basisQuantity: portion.amount > 0 ? portion.amount : 1,
            basisUnit: portion.unit || portion.label || "serving",
            basisGrams:
                portion.gramWeight && portion.gramWeight > 0
                    ? portion.gramWeight
                    : null,
            nutrients: compactNutrients(portion.nutrients),
        };
    }
    return {
        basisQuantity: null,
        basisUnit: null,
        basisGrams: null,
        nutrients: compactNutrients(undefined),
    };
}

export function planningProfileFromCandidate(
    inventoryItemId: string,
    pantryName: string,
    candidate: FoodCandidate,
): Omit<PantryPlanningProfile, "updated_at" | "enriched_at"> {
    const classification = classifyPantryFood(
        `${pantryName} ${candidate.brand ?? ""} ${candidate.name}`,
    );
    const basis = candidateBasis(candidate);
    return {
        inventory_item_id: inventoryItemId,
        profile_status: hasCoreNutrition(basis.nutrients)
            ? "resolved"
            : "partial",
        source_type: "provider",
        source_provider: candidate.provider,
        source_food_id: candidate.providerFoodId,
        match_confidence: Math.max(0, Math.min(1, candidate.confidence)),
        category: classification.category,
        culinary_roles: classification.culinaryRoles,
        basis_quantity: basis.basisQuantity,
        basis_unit: basis.basisUnit,
        basis_grams: basis.basisGrams,
        nutrients: basis.nutrients,
        profile_version: PANTRY_PLANNING_PROFILE_VERSION,
    };
}

export function heuristicPlanningProfile(
    inventoryItemId: string,
    name: string,
): Omit<PantryPlanningProfile, "updated_at" | "enriched_at"> {
    const classification = classifyPantryFood(name);
    return {
        inventory_item_id: inventoryItemId,
        profile_status:
            classification.category === "other" ? "unresolved" : "partial",
        source_type:
            classification.category === "other" ? "unresolved" : "heuristic",
        source_provider: null,
        source_food_id: null,
        match_confidence: classification.category === "other" ? null : 0.65,
        category: classification.category,
        culinary_roles: classification.culinaryRoles,
        basis_quantity: null,
        basis_unit: null,
        basis_grams: null,
        nutrients: compactNutrients(undefined),
        profile_version: PANTRY_PLANNING_PROFILE_VERSION,
    };
}

function serializeProfile(row: Record<string, unknown>): PantryPlanningProfile {
    const value = (key: string) =>
        row[key] == null ? null : finiteOrNull(Number(row[key]));
    return {
        inventory_item_id: String(row.inventory_item_id),
        profile_status: String(
            row.profile_status,
        ) as PantryPlanningProfileStatus,
        source_type: String(row.source_type) as PantryPlanningProfileSource,
        source_provider:
            row.source_provider == null ? null : String(row.source_provider),
        source_food_id:
            row.source_food_id == null ? null : String(row.source_food_id),
        match_confidence: value("match_confidence"),
        category: String(row.category),
        culinary_roles: Array.isArray(row.culinary_roles)
            ? row.culinary_roles.map(String)
            : [],
        basis_quantity: value("basis_quantity"),
        basis_unit: row.basis_unit == null ? null : String(row.basis_unit),
        basis_grams: value("basis_grams"),
        nutrients: {
            calories: value("calories"),
            protein_g: value("protein_g"),
            carbs_g: value("carbs_g"),
            fat_g: value("fat_g"),
            fiber_g: value("fiber_g"),
            sugar_g: value("sugar_g"),
            sodium_mg: value("sodium_mg"),
        },
        profile_version: Number(row.profile_version),
        enriched_at:
            row.enriched_at == null
                ? null
                : new Date(String(row.enriched_at)).toISOString(),
        updated_at: new Date(String(row.updated_at)).toISOString(),
    };
}

async function readIdentity(
    userId: string,
    inventoryItemId: string,
): Promise<{
    item: InventoryIdentity;
    profile: PantryPlanningProfile | null;
} | null> {
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<Array<Record<string, unknown>>>`
            select i.id, i.name, i.normalized_name, i.food_provider,
                   i.provider_food_id, i.barcode,
                   p.inventory_item_id as profile_inventory_item_id,
                   p.profile_status, p.source_type, p.source_provider,
                   p.source_food_id, p.match_confidence, p.category,
                   p.culinary_roles, p.basis_quantity, p.basis_unit,
                   p.basis_grams, p.calories, p.protein_g, p.carbs_g,
                   p.fat_g, p.fiber_g, p.sugar_g, p.sodium_mg,
                   p.profile_version, p.enriched_at, p.updated_at as profile_updated_at
            from munch.inventory_items i
            left join munch.inventory_item_profiles p on p.inventory_item_id = i.id
            where i.id = ${inventoryItemId} and i.deleted_at is null
            limit 1
        `;
        const row = rows[0];
        if (!row) return null;
        const item: InventoryIdentity = {
            id: String(row.id),
            name: String(row.name),
            normalized_name: String(row.normalized_name),
            food_provider:
                row.food_provider == null ? null : String(row.food_provider),
            provider_food_id:
                row.provider_food_id == null
                    ? null
                    : String(row.provider_food_id),
            barcode: row.barcode == null ? null : String(row.barcode),
        };
        if (!row.profile_inventory_item_id) return { item, profile: null };
        return {
            item,
            profile: serializeProfile({
                inventory_item_id: row.profile_inventory_item_id,
                profile_status: row.profile_status,
                source_type: row.source_type,
                source_provider: row.source_provider,
                source_food_id: row.source_food_id,
                match_confidence: row.match_confidence,
                category: row.category,
                culinary_roles: row.culinary_roles,
                basis_quantity: row.basis_quantity,
                basis_unit: row.basis_unit,
                basis_grams: row.basis_grams,
                calories: row.calories,
                protein_g: row.protein_g,
                carbs_g: row.carbs_g,
                fat_g: row.fat_g,
                fiber_g: row.fiber_g,
                sugar_g: row.sugar_g,
                sodium_mg: row.sodium_mg,
                profile_version: row.profile_version,
                enriched_at: row.enriched_at,
                updated_at: row.profile_updated_at,
            }),
        };
    });
}

async function resolveCandidate(
    item: InventoryIdentity,
): Promise<FoodCandidate | null> {
    const service = getFoodSearchService();
    if (
        item.provider_food_id &&
        (item.food_provider === "usda" ||
            item.food_provider === "open_food_facts")
    ) {
        const exact = await service.details(
            encodeFoodCandidateId({
                provider: item.food_provider,
                providerFoodId: item.provider_food_id,
            }),
        );
        if (exact) return exact;
    }
    if (item.barcode) {
        const byBarcode = await service.barcode(item.barcode);
        if (byBarcode.candidates[0]) return byBarcode.candidates[0];
    }
    const search = await service.search(item.name, 5);
    const candidate = search.candidates[0];
    if (!candidate || candidate.confidence < 0.78) return null;
    return candidate;
}

async function persistProfile(
    userId: string,
    profile: Omit<PantryPlanningProfile, "updated_at" | "enriched_at">,
): Promise<PantryPlanningProfile> {
    return withUserDatabase(userId, async (tx) => {
        const n = profile.nutrients;
        const rows = await tx<Array<Record<string, unknown>>>`
            insert into munch.inventory_item_profiles (
                inventory_item_id, profile_status, source_type,
                source_provider, source_food_id, match_confidence,
                category, culinary_roles, basis_quantity, basis_unit,
                basis_grams, calories, protein_g, carbs_g, fat_g,
                fiber_g, sugar_g, sodium_mg, profile_version,
                enriched_at, updated_at
            ) values (
                ${profile.inventory_item_id}, ${profile.profile_status},
                ${profile.source_type}, ${profile.source_provider},
                ${profile.source_food_id}, ${profile.match_confidence},
                ${profile.category}, ${profile.culinary_roles}::text[],
                ${profile.basis_quantity}, ${profile.basis_unit},
                ${profile.basis_grams}, ${n.calories}, ${n.protein_g},
                ${n.carbs_g}, ${n.fat_g}, ${n.fiber_g}, ${n.sugar_g},
                ${n.sodium_mg}, ${PANTRY_PLANNING_PROFILE_VERSION}, now(), now()
            )
            on conflict (inventory_item_id) do update set
                profile_status = excluded.profile_status,
                source_type = excluded.source_type,
                source_provider = excluded.source_provider,
                source_food_id = excluded.source_food_id,
                match_confidence = excluded.match_confidence,
                category = excluded.category,
                culinary_roles = excluded.culinary_roles,
                basis_quantity = excluded.basis_quantity,
                basis_unit = excluded.basis_unit,
                basis_grams = excluded.basis_grams,
                calories = excluded.calories,
                protein_g = excluded.protein_g,
                carbs_g = excluded.carbs_g,
                fat_g = excluded.fat_g,
                fiber_g = excluded.fiber_g,
                sugar_g = excluded.sugar_g,
                sodium_mg = excluded.sodium_mg,
                profile_version = excluded.profile_version,
                enriched_at = now(), updated_at = now()
            returning *
        `;
        if (!rows[0])
            throw new Error("Pantry planning profile returned no row");
        return serializeProfile(rows[0]);
    });
}

export async function enrichInventoryItemProfile(input: {
    userId: string;
    inventoryItemId: string;
    force?: boolean;
}): Promise<PantryPlanningProfile | null> {
    const identity = await readIdentity(input.userId, input.inventoryItemId);
    if (!identity) return null;
    if (
        !input.force &&
        identity.profile &&
        identity.profile.profile_version >= PANTRY_PLANNING_PROFILE_VERSION &&
        identity.profile.profile_status !== "failed"
    ) {
        return identity.profile;
    }

    let candidate: FoodCandidate | null = null;
    try {
        candidate = await resolveCandidate(identity.item);
    } catch (error) {
        console.warn(
            `[pantry_planning] enrichment provider failure item=${identity.item.id} error=${error instanceof Error ? error.name : "unknown"}`,
        );
    }
    const profile = candidate
        ? planningProfileFromCandidate(
              identity.item.id,
              identity.item.name,
              candidate,
          )
        : heuristicPlanningProfile(identity.item.id, identity.item.name);
    try {
        return await persistProfile(input.userId, profile);
    } catch (error) {
        // Household viewers can read Pantry but intentionally cannot write the shared
        // profile cache. Return the in-memory heuristic/provider profile instead of
        // making a read-only planning request fail.
        console.warn(
            `[pantry_planning] enrichment persistence skipped item=${identity.item.id} error=${error instanceof Error ? error.name : "unknown"}`,
        );
        return {
            ...profile,
            enriched_at: null,
            updated_at: new Date().toISOString(),
        };
    }
}

export async function enrichPantryItemsBestEffort(input: {
    userId: string;
    inventoryItemIds: string[];
    limit?: number;
}): Promise<Map<string, PantryPlanningProfile>> {
    const ids = [...new Set(input.inventoryItemIds)].slice(
        0,
        Math.max(1, Math.min(50, input.limit ?? 24)),
    );
    const results = new Map<string, PantryPlanningProfile>();
    const concurrency = Math.min(4, ids.length);
    let cursor = 0;
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            while (cursor < ids.length) {
                const index = cursor++;
                const id = ids[index]!;
                try {
                    const profile = await enrichInventoryItemProfile({
                        userId: input.userId,
                        inventoryItemId: id,
                    });
                    if (profile) results.set(id, profile);
                } catch (error) {
                    console.warn(
                        `[pantry_planning] enrichment skipped item=${id} error=${error instanceof Error ? error.name : "unknown"}`,
                    );
                }
            }
        }),
    );
    return results;
}

export async function getStoredPlanningProfiles(
    userId: string,
    inventoryItemIds: string[],
): Promise<Map<string, PantryPlanningProfile>> {
    const ids = [...new Set(inventoryItemIds)].slice(0, 200);
    if (!ids.length) return new Map();
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<Array<Record<string, unknown>>>`
            select * from munch.inventory_item_profiles
            where inventory_item_id = any(${ids}::uuid[])
        `;
        return new Map(
            rows.map((row) => {
                const profile = serializeProfile(row);
                return [profile.inventory_item_id, profile] as const;
            }),
        );
    });
}
