#!/usr/bin/env bun

import { createSmokeIdentity } from "./support/smoke-user.js";

const {
    acceptHouseholdInvitation,
    createHousehold,
    createHouseholdInvitation,
} = await import("../src/households/repository.js");
const { getPantryPlanningContext, rankSavedRecipesForPantry } =
    await import("../src/inventory/meal-planning.js");
const { getStoredPlanningProfiles } =
    await import("../src/inventory/planning-profile.js");
const { reconcilePantry, setPantryPreference } =
    await import("../src/inventory/repository.js");
const { saveRecipe } = await import("../src/planning/repository.js");
const { closePlatformDatabase, withUserDatabase } =
    await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Pantry planning smoke tests");
}
if (process.env.MUNCH_PANTRY_PLANNING_ENABLED !== "true") {
    throw new Error(
        "Pantry planning smoke requires MUNCH_PANTRY_PLANNING_ENABLED=true",
    );
}

const owner = await createSmokeIdentity("pantry-planning-owner");
const viewer = await createSmokeIdentity("pantry-planning-viewer");
const outsider = await createSmokeIdentity("pantry-planning-outsider");
await setPantryPreference({ userId: owner.userId, enabled: true });
await setPantryPreference({ userId: viewer.userId, enabled: true });
await setPantryPreference({ userId: outsider.userId, enabled: true });

const household = await createHousehold({
    userId: owner.userId,
    name: "Planning Household",
    displayName: "Owner",
});
const invite = await createHouseholdInvitation({
    userId: owner.userId,
    householdId: household.householdId,
    email: viewer.email,
    role: "viewer",
});
await acceptHouseholdInvitation({
    userId: viewer.userId,
    token: invite.rawToken,
    displayName: "Viewer",
});

const scope = {
    type: "household" as const,
    householdId: household.householdId,
};
const pantrySeed = await reconcilePantry({
    userId: owner.userId,
    scope,
    sourceType: "manual",
    idempotencyKey: "pantry-planning-seed",
    operations: [
        {
            action: "acquire",
            name: "Ground beef",
            quantity: 1,
            unit: "lb",
            location: "fridge",
        },
        {
            action: "acquire",
            name: "Rice",
            quantity: 3,
            unit: "cup",
            location: "pantry",
        },
        {
            action: "acquire",
            name: "Soy sauce",
            quantityMode: "presence_only",
            location: "pantry",
        },
        {
            action: "acquire",
            name: "Garlic",
            quantityMode: "presence_only",
            location: "pantry",
        },
        {
            action: "acquire",
            name: "Ginger",
            quantityMode: "presence_only",
            location: "fridge",
        },
        {
            action: "acquire",
            name: "Smoked paprika",
            quantityMode: "presence_only",
            location: "pantry",
        },
        {
            action: "acquire",
            name: "Cottage cheese",
            quantity: 24,
            unit: "oz",
            location: "fridge",
        },
        {
            action: "acquire",
            name: "Spinach",
            quantityMode: "presence_only",
            location: "fridge",
        },
    ],
});
const byName = new Map(
    pantrySeed.operations.map((operation) => [
        operation.item.normalized_name,
        operation.item,
    ]),
);

const profileSeed: Array<{
    key: string;
    category: string;
    roles: string[];
    protein?: number;
    calories?: number;
}> = [
    {
        key: "ground beef",
        category: "protein",
        roles: ["main", "protein"],
        protein: 26,
        calories: 200,
    },
    {
        key: "rice",
        category: "grain_starch",
        roles: ["base", "starch"],
        protein: 2.7,
        calories: 130,
    },
    {
        key: "soy sauce",
        category: "sauce_condiment",
        roles: ["east-asian", "flavor-builder", "sauce"],
    },
    {
        key: "garlic",
        category: "aromatic",
        roles: ["aromatic", "flavor-builder"],
    },
    {
        key: "ginger",
        category: "aromatic",
        roles: ["aromatic", "east-asian", "flavor-builder"],
    },
    {
        key: "smoked paprika",
        category: "spice",
        roles: ["flavor-builder", "seasoning", "smoky"],
    },
    {
        key: "cottage cheese",
        category: "dairy",
        roles: ["creamy", "dairy", "protein", "topping"],
        protein: 12,
        calories: 100,
    },
    {
        key: "spinach",
        category: "produce",
        roles: ["produce", "side", "vegetable"],
        protein: 3,
        calories: 23,
    },
];

await withUserDatabase(owner.userId, async (tx) => {
    for (const profile of profileSeed) {
        const item = byName.get(profile.key);
        if (!item)
            throw new Error(`Missing seeded Pantry item: ${profile.key}`);
        const rolesLiteral = `{${profile.roles.join(",")}}`;
        await tx`
            insert into munch.inventory_item_profiles (
                inventory_item_id, profile_status, source_type,
                source_provider, source_food_id, match_confidence,
                category, culinary_roles, basis_quantity, basis_unit,
                basis_grams, calories, protein_g, carbs_g, fat_g,
                fiber_g, sugar_g, sodium_mg, profile_version, enriched_at
            ) values (
                ${item.id},
                ${profile.protein == null && profile.calories == null ? "partial" : "resolved"},
                'heuristic', null, null, 0.9,
                ${profile.category}, ${rolesLiteral}::text[],
                ${profile.protein == null && profile.calories == null ? null : 100},
                ${profile.protein == null && profile.calories == null ? null : "g"},
                ${profile.protein == null && profile.calories == null ? null : 100},
                ${profile.calories ?? null}, ${profile.protein ?? null},
                null, null, null, null, null, 1, now()
            )
        `;
    }
});

function ingredient(name: string, protein = 0, calories = 0, optional = false) {
    return {
        name,
        optional,
        sourceType: "user_supplied" as const,
        nutrients: {
            calories,
            protein_g: protein,
            carbs_g: 0,
            fat_g: 0,
            fiber_g: 0,
        },
    };
}

await saveRecipe({
    userId: owner.userId,
    scope,
    idempotencyKey: "planning-recipe-ginger-soy",
    recipe: {
        name: "Ginger Soy Beef Bowl",
        servings: 1,
        sourceType: "user_entered",
        preparationMinutes: 10,
        cookingMinutes: 20,
        instructions: [
            "Brown beef.",
            "Build the soy, garlic, and ginger sauce.",
            "Serve over rice.",
        ],
        ingredients: [
            ingredient("Ground beef", 40, 350),
            ingredient("Rice", 5, 200),
            ingredient("Soy sauce"),
            ingredient("Garlic"),
            ingredient("Ginger"),
        ],
    },
});
await saveRecipe({
    userId: owner.userId,
    scope,
    idempotencyKey: "planning-recipe-plain",
    recipe: {
        name: "Plain Beef and Rice",
        servings: 1,
        sourceType: "user_entered",
        preparationMinutes: 5,
        cookingMinutes: 15,
        instructions: ["Cook beef and rice."],
        ingredients: [
            ingredient("Ground beef", 45, 380),
            ingredient("Rice", 5, 200),
        ],
    },
});
await saveRecipe({
    userId: owner.userId,
    scope,
    idempotencyKey: "planning-recipe-missing-core",
    recipe: {
        name: "Chicken Garlic Rice",
        servings: 1,
        sourceType: "user_entered",
        preparationMinutes: 10,
        cookingMinutes: 20,
        instructions: ["Cook chicken with garlic and rice."],
        ingredients: [
            ingredient("Chicken breast", 55, 330),
            ingredient("Rice", 5, 200),
            ingredient("Garlic"),
        ],
    },
});

const started = performance.now();
const context = await getPantryPlanningContext({
    userId: owner.userId,
    scope,
    limit: 200,
});
const contextMs = performance.now() - started;
if (context.items.length !== pantrySeed.operations.length) {
    throw new Error("Planning context omitted available Pantry items");
}
const paprika = context.items.find(
    (item) => item.normalized_name === "smoked paprika",
);
if (
    paprika?.planning_profile.category !== "spice" ||
    !paprika.planning_profile.culinary_roles.includes("smoky")
) {
    throw new Error("Planning context lost spice/flavor metadata");
}
const cottage = context.items.find(
    (item) => item.normalized_name === "cottage cheese",
);
if (cottage?.planning_profile.nutrients.protein_g !== 12) {
    throw new Error("Planning context lost compact nutrition metadata");
}

const ranked = await rankSavedRecipesForPantry({
    userId: owner.userId,
    scope,
    goal: "high_protein",
    limit: 10,
});
const coherentIndex = ranked.findIndex(
    (recipe) => recipe.name === "Ginger Soy Beef Bowl",
);
const plainIndex = ranked.findIndex(
    (recipe) => recipe.name === "Plain Beef and Rice",
);
const missingIndex = ranked.findIndex(
    (recipe) => recipe.name === "Chicken Garlic Rice",
);
if (coherentIndex < 0 || plainIndex < 0 || missingIndex < 0) {
    throw new Error("Pantry recipe ranking omitted seeded recipes");
}
if (coherentIndex >= plainIndex) {
    throw new Error(
        "Culinary coherence did not outrank a slightly higher-protein plain combination",
    );
}
if (ranked[coherentIndex]?.flavor_support.coverage !== 1) {
    throw new Error(
        "Pantry recipe ranking did not recognize complete flavor support",
    );
}
if (ranked[missingIndex]?.availability.readiness !== "missing_core") {
    throw new Error(
        "Pantry recipe ranking did not identify a missing core protein",
    );
}
if ((ranked[missingIndex]?.score ?? 0) >= (ranked[coherentIndex]?.score ?? 0)) {
    throw new Error(
        "Missing-core recipe was not penalized below ready coherent meal",
    );
}

const profileIds = pantrySeed.operations.map((operation) => operation.item.id);
const viewerProfiles = await getStoredPlanningProfiles(
    viewer.userId,
    profileIds,
);
if (viewerProfiles.size !== profileIds.length) {
    throw new Error(
        "Household viewer could not read shared Pantry planning profiles",
    );
}
const outsiderProfiles = await getStoredPlanningProfiles(
    outsider.userId,
    profileIds,
);
if (outsiderProfiles.size !== 0) {
    throw new Error("Outsider could read household Pantry planning profiles");
}
let viewerWriteDenied = false;
try {
    await withUserDatabase(viewer.userId, async (tx) => {
        const beef = byName.get("ground beef");
        if (!beef) throw new Error("Missing beef item");
        await tx`
            insert into munch.inventory_item_profiles (
                inventory_item_id, profile_status, source_type,
                category, culinary_roles, profile_version
            ) values (${beef.id}, 'partial', 'heuristic', 'protein', ${"{protein}"}::text[], 1)
            on conflict (inventory_item_id) do update
            set category = excluded.category, updated_at = now()
        `;
    });
} catch {
    viewerWriteDenied = true;
}
if (!viewerWriteDenied) {
    throw new Error(
        "Household viewer unexpectedly wrote a shared Pantry profile",
    );
}

console.log(
    `Munch Pantry planning profile/RLS/ranking smoke passed; ${context.items.length} items loaded in ${Math.round(contextMs)}ms.`,
);
await closePlatformDatabase();
