#!/usr/bin/env bun

import { createSmokeIdentity } from "./support/smoke-user.js";

const {
    acceptHouseholdInvitation,
    createHousehold,
    createHouseholdInvitation,
} = await import("../src/households/repository.js");
const {
    addGroceryItems,
    archiveRecipe,
    clearPurchasedGroceryItems,
    deleteGroceryItem,
    getGroceryList,
    getMealPlan,
    getRecipe,
    logRecipe,
    markGroceryItemPurchased,
    saveRecipe,
    saveRecipeAndPlan,
    searchRecipes,
    updateGroceryItem,
    updateRecipe,
} = await import("../src/planning/repository.js");
const { getStructuredMeal } =
    await import("../src/structured-meals/repository.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for recipe planning smoke tests");
}

const owner = await createSmokeIdentity("planning-owner");
const member = await createSmokeIdentity("planning-member");
const viewer = await createSmokeIdentity("planning-viewer");
const outsider = await createSmokeIdentity("planning-outsider");
const household = await createHousehold({
    userId: owner.userId,
    name: "Planning Household",
    displayName: "Mom",
});

const lunchRecipe = {
    name: "My Peanut Butter Sandwich Lunch",
    servings: 1,
    instructions: [],
    sourceType: "user_entered" as const,
    ingredients: [
        {
            name: "Simply Nature Graintastic Organic Bread",
            quantity: 2,
            unit: "slices",
            nutrients: { calories: 140, protein_g: 6, carbs_g: 26, fat_g: 2 },
            sourceType: "saved_food" as const,
            sourceSnapshot: { saved_food_id: "bread" },
        },
        {
            name: "Simply Nature Organic Creamy Peanut Butter",
            quantity: 4,
            unit: "tbsp",
            nutrients: { calories: 480, protein_g: 16, carbs_g: 14, fat_g: 32 },
            sourceType: "saved_food" as const,
            sourceSnapshot: { saved_food_id: "peanut-butter" },
        },
        {
            name: "Chia seeds",
            quantity: 2,
            unit: "tbsp",
            nutrients: {
                calories: 118,
                protein_g: 8.7,
                carbs_g: 27.9,
                fat_g: 9.7,
            },
            sourceType: "user_supplied" as const,
            sourceSnapshot: { entered_by_user: true },
        },
    ],
};

const lunchSaved = await saveRecipe({
    userId: owner.userId,
    scope: { type: "personal" },
    recipe: lunchRecipe,
    idempotencyKey: `lunch:${crypto.randomUUID()}`,
});
if (
    lunchSaved.nutritionStatus !== "complete" ||
    lunchSaved.perServing.calories !== 738 ||
    lunchSaved.perServing.protein_g !== 30.7 ||
    lunchSaved.perServing.carbs_g !== 67.9 ||
    lunchSaved.perServing.fat_g !== 43.7
) {
    throw new Error(
        "Peanut butter lunch nutrition did not match the saved facts",
    );
}

const halfLunch = await logRecipe({
    userId: owner.userId,
    recipeId: lunchSaved.recipeId,
    recipeRevisionId: lunchSaved.revisionId,
    servingsConsumed: 0.5,
    mealType: "lunch",
    idempotencyKey: `lunch-log:${crypto.randomUUID()}`,
});
if (
    halfLunch.meal.sourceRecipeId !== lunchSaved.recipeId ||
    halfLunch.meal.sourceRecipeRevisionId !== lunchSaved.revisionId ||
    halfLunch.meal.items[1]?.quantity !== 2 ||
    halfLunch.meal.calories !== 369
) {
    throw new Error(
        "Half peanut butter lunch did not preserve scaled recipe provenance",
    );
}

const updatedLunch = await updateRecipe({
    userId: owner.userId,
    scope: { type: "personal" },
    recipeId: lunchSaved.recipeId,
    recipe: {
        ...lunchRecipe,
        ingredients: lunchRecipe.ingredients.map((ingredient) =>
            ingredient.name.includes("Peanut Butter")
                ? {
                      ...ingredient,
                      quantity: 3,
                      nutrients: {
                          calories: 360,
                          protein_g: 12,
                          carbs_g: 10.5,
                          fat_g: 24,
                      },
                  }
                : ingredient,
        ),
    },
    expectedVersion: 1,
    idempotencyKey: `lunch-update:${crypto.randomUUID()}`,
});
if (updatedLunch.revisionNumber !== 2 || updatedLunch.version !== 2) {
    throw new Error("Recipe update did not create revision 2");
}
const historicalLunch = await getRecipe(
    owner.userId,
    lunchSaved.recipeId,
    lunchSaved.revisionId,
);
if (historicalLunch?.ingredients[1]?.quantity !== 4) {
    throw new Error("Recipe revision 1 was mutated by the update");
}
const archivedLunch = await archiveRecipe({
    userId: owner.userId,
    scope: { type: "personal" },
    recipeId: lunchSaved.recipeId,
    expectedVersion: updatedLunch.version,
});
if (
    archivedLunch.alreadyArchived ||
    (await getRecipe(owner.userId, lunchSaved.recipeId))
) {
    throw new Error("Archived recipe remained in the active recipe surface");
}
if (!(await getStructuredMeal(owner.userId, halfLunch.meal.id))) {
    throw new Error(
        "Historical recipe meal log was lost when the recipe was archived",
    );
}

for (const [person, role, displayName] of [
    [member, "member", "Dad"],
    [viewer, "viewer", "Guest"],
] as const) {
    const invitation = await createHouseholdInvitation({
        userId: owner.userId,
        householdId: household.householdId,
        email: person.email,
        role,
    });
    await acceptHouseholdInvitation({
        userId: person.userId,
        token: invitation.rawToken,
        displayName,
    });
}

const scope = {
    type: "household" as const,
    householdId: household.householdId,
};
const idempotencyKey = `recipe-plan:${crypto.randomUUID()}`;
const recipe = {
    name: "Spaghetti with Meat Sauce",
    servings: 4,
    description: "Household spaghetti",
    instructions: ["Brown the beef.", "Simmer the sauce.", "Cook the pasta."],
    preparationMinutes: 15,
    cookingMinutes: 30,
    sourceType: "chatgpt_generated" as const,
    ingredients: [
        {
            name: "Spaghetti",
            quantity: 16,
            unit: "oz",
            nutrients: {
                calories: 1600,
                protein_g: 56,
                carbs_g: 336,
                fat_g: 8,
            },
            sourceType: "user_supplied" as const,
        },
        {
            name: "Ground beef",
            quantity: 1,
            unit: "lb",
            nutrients: {
                calories: 1000,
                protein_g: 84,
                carbs_g: 0,
                fat_g: 72,
            },
            sourceType: "user_supplied" as const,
        },
        {
            name: "Yellow onion",
            quantity: 1,
            unit: "whole",
            nutrients: {
                calories: 44,
                protein_g: 1.2,
                carbs_g: 10.3,
                fat_g: 0.1,
            },
            sourceType: "usda" as const,
            provider: "usda",
            providerFoodId: "170000",
        },
    ],
};

const created = await saveRecipeAndPlan({
    userId: owner.userId,
    scope,
    recipe,
    plannedDate: "2026-08-10",
    mealSlot: "dinner",
    plannedServings: 4,
    groceryItems: [{ name: "Yellow onion", quantity: 1, unit: "whole" }],
    idempotencyKey,
});
if (created.recipe.nutritionStatus !== "complete") {
    throw new Error("Complete recipe nutrition was not calculated");
}
if (
    created.grocery.items.length !== 1 ||
    created.grocery.items[0]?.name !== "Yellow onion"
) {
    throw new Error(
        "Compound workflow persisted groceries beyond the explicitly missing onion",
    );
}

const replay = await saveRecipeAndPlan({
    userId: owner.userId,
    scope,
    recipe,
    plannedDate: "2026-08-10",
    mealSlot: "dinner",
    plannedServings: 4,
    groceryItems: [{ name: "Yellow onion", quantity: 1, unit: "whole" }],
    idempotencyKey,
});
if (!replay.recipe.deduplicated) {
    throw new Error("Compound workflow was not idempotent");
}

const memberPlan = await getMealPlan({
    userId: member.userId,
    startDate: "2026-08-10",
    endDate: "2026-08-10",
    scope: "household",
});
if (
    memberPlan.length !== 1 ||
    memberPlan[0]?.recipe_name !== "Spaghetti with Meat Sauce" ||
    memberPlan[0]?.created_by !== "Mom"
) {
    throw new Error(
        "Household member could not read Monday dinner with attribution",
    );
}

const memberGroceries = await getGroceryList({
    userId: member.userId,
    scope,
    includePurchased: true,
});
if (
    memberGroceries.items.length !== 1 ||
    memberGroceries.items[0]?.name !== "Yellow onion"
) {
    throw new Error("Household member could not read the shared grocery list");
}

const groceryItem = memberGroceries.items[0]!;
const updatedGrocery = await updateGroceryItem({
    userId: member.userId,
    scope,
    groceryItemId: groceryItem.grocery_item_id,
    name: "Red onion",
    quantity: 2,
    unit: "whole",
    note: "Diced",
    expectedVersion: groceryItem.version,
});
if (
    updatedGrocery.name !== "Red onion" ||
    updatedGrocery.quantity !== 2 ||
    updatedGrocery.note !== "Diced" ||
    !updatedGrocery.source_recipe_id ||
    !updatedGrocery.source_recipe_revision_id ||
    !updatedGrocery.source_planned_meal_id
) {
    throw new Error("Grocery editing did not preserve item provenance");
}
const purchasedGrocery = await markGroceryItemPurchased({
    userId: member.userId,
    scope,
    groceryItemId: groceryItem.grocery_item_id,
    purchased: true,
    expectedVersion: updatedGrocery.version,
});
if (!purchasedGrocery.purchased_at) {
    throw new Error("Household member could not mark a grocery purchased");
}

let viewerGroceryWriteDenied = false;
try {
    await updateGroceryItem({
        userId: viewer.userId,
        scope,
        groceryItemId: groceryItem.grocery_item_id,
        name: "Viewer edit",
        quantity: null,
        expectedVersion: purchasedGrocery.version,
    });
} catch {
    viewerGroceryWriteDenied = true;
}
if (!viewerGroceryWriteDenied) {
    throw new Error("Viewer was allowed to edit household groceries");
}

const cleared = await clearPurchasedGroceryItems({
    userId: member.userId,
    scope,
});
if (cleared.clearedCount !== 1) {
    throw new Error("Clear purchased did not remove the purchased grocery");
}

const personalGrocery = await addGroceryItems({
    userId: owner.userId,
    scope: { type: "personal" },
    items: [
        {
            name: "Personal lemons",
            quantity: 2,
            unit: "whole",
            note: "For tea",
            idempotencyKey: `personal-grocery:${crypto.randomUUID()}`,
        },
    ],
});
if (personalGrocery.items[0]?.name !== "Personal lemons") {
    throw new Error("Personal grocery addition did not persist");
}
await deleteGroceryItem({
    userId: owner.userId,
    scope: { type: "personal" },
    groceryItemId: String(personalGrocery.items[0].id),
    expectedVersion: Number(personalGrocery.items[0].version),
});

const found = await searchRecipes({
    userId: member.userId,
    query: "spaghetti",
    scope: "household",
});
if (found.length !== 1 || found[0]?.times_scheduled !== 1) {
    throw new Error("Recipe search did not return factual scheduling usage");
}
if (!(await getRecipe(viewer.userId, created.recipe.recipeId))) {
    throw new Error("Viewer could not read the shared recipe");
}

let viewerWriteDenied = false;
try {
    await saveRecipeAndPlan({
        userId: viewer.userId,
        scope,
        recipe: { ...recipe, name: "Viewer Recipe" },
        plannedDate: "2026-08-11",
        mealSlot: "dinner",
        plannedServings: 4,
        groceryItems: [],
        idempotencyKey: `viewer:${crypto.randomUUID()}`,
    });
} catch {
    viewerWriteDenied = true;
}
if (!viewerWriteDenied)
    throw new Error("Viewer was allowed to write household data");

if (await getRecipe(outsider.userId, created.recipe.recipeId)) {
    throw new Error("Unrelated user read a household recipe");
}
if (
    (
        await getMealPlan({
            userId: outsider.userId,
            startDate: "2026-08-10",
            endDate: "2026-08-10",
            scope: "all",
        })
    ).length !== 0
) {
    throw new Error("Unrelated user read a household meal plan");
}

await closePlatformDatabase();
console.log(
    "Munch recipe, meal calendar, grocery, idempotency, and household RLS smoke test passed.",
);
