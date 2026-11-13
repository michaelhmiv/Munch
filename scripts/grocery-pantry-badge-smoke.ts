#!/usr/bin/env bun

import { createSmokeIdentity } from "./support/smoke-user.js";

const { getPlanningWorkspace, getRecipeWorkspace } =
    await import("../src/app/repository.js");
const { saveFeatureModules } =
    await import("../src/feature-modules-repository.js");
const { attachPantryMatchesForScope } =
    await import("../src/inventory/grocery-pantry.js");
const { getPantry, reconcilePantry } =
    await import("../src/inventory/repository.js");
const {
    addGroceryItems,
    addRecipeToGroceryList,
    getGroceryList,
    getRecipe,
    saveRecipe,
} = await import("../src/planning/repository.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is required for grocery Pantry badge smoke tests",
    );
}

// "Already have it" (owner redesign, Nov 11): presence-only Pantry
// matches on grocery items, and the "did you run out?" resolution —
// one reconcile call removes the item from the Pantry while the
// grocery item stays on the list. Amounts never enter the feature:
// the seeded quantities below exist only because the Pantry schema
// carries them; every assertion is about presence and identity.

const owner = await createSmokeIdentity("grocery-pantry-badge");
const personal = { type: "personal" as const };

const seeded = await reconcilePantry({
    userId: owner.userId,
    scope: personal,
    sourceType: "manual",
    idempotencyKey: "grocery-pantry-badge-seed",
    operations: [
        { action: "acquire", name: "Milk", quantity: 1, unit: "gal" },
        { action: "acquire", name: "Soy sauce", quantityMode: "presence_only" },
    ],
});
const milkPantryId = seeded.operations.find(
    (operation) => operation.item.name === "Milk",
)?.item.id;
if (!milkPantryId) throw new Error("Pantry seed did not create Milk");

await addGroceryItems({
    userId: owner.userId,
    scope: personal,
    items: [
        { name: "Milk", quantity: 1, unit: "gal" },
        { name: "Soy sauce" },
        { name: "Eggs", quantity: 12, unit: "count" },
    ],
});

async function personalWorkspaceItems() {
    const workspace = await getPlanningWorkspace(
        owner.userId,
        "2026-11-09",
        "2026-11-15",
    );
    const list = workspace.groceries.find(
        (entry) => entry.scope === "personal",
    );
    if (!list) throw new Error("Planning workspace has no personal list");
    return list.items;
}

const items = await personalWorkspaceItems();
const byName = new Map(items.map((item) => [item.name, item]));
if (byName.get("Milk")?.pantry_match?.pantry_item_id !== milkPantryId) {
    throw new Error("Milk on the list did not match the Pantry item");
}
if (!byName.get("Soy sauce")?.pantry_match) {
    throw new Error("Presence-only Pantry item did not match the list");
}
if (byName.get("Eggs")?.pantry_match !== null) {
    throw new Error("Eggs matched the Pantry but are not in it");
}
for (const item of items) {
    if (!item.pantry_match) continue;
    const keys = Object.keys(item.pantry_match).sort();
    if (keys.join(",") !== "pantry_item_id,pantry_name") {
        throw new Error(
            `Pantry match for ${item.name} carries more than identity: ${keys}`,
        );
    }
}

// The add-path enrichment (same helper the POST route uses) agrees.
const enriched = await attachPantryMatchesForScope({
    userId: owner.userId,
    scope: personal,
    items: [{ name: "Milk" }, { name: "Eggs" }],
});
if (enriched[0]?.pantry_match?.pantry_item_id !== milkPantryId) {
    throw new Error("Add-path enrichment did not match Milk");
}
if (enriched[1]?.pantry_match !== null) {
    throw new Error("Add-path enrichment matched Eggs");
}

// The three-state flag (Nov 13) rides the same payloads: the list
// surface distinguishes have / none explicitly, keyed to the same
// identity the match carries.
if (byName.get("Milk")?.pantry_flag?.state !== "have") {
    throw new Error("Milk on the list did not flag have");
}
if (byName.get("Milk")?.pantry_flag?.pantry_item_id !== milkPantryId) {
    throw new Error("Milk's flag lost the Pantry identity");
}
if (byName.get("Soy sauce")?.pantry_flag?.state !== "have") {
    throw new Error("Presence-only Soy sauce did not flag have");
}
if (byName.get("Eggs")?.pantry_flag?.state !== "none") {
    throw new Error("Eggs flagged something other than none");
}
if (enriched[0]?.pantry_flag?.state !== "have") {
    throw new Error("Add-path enrichment did not flag Milk have");
}
if (enriched[1]?.pantry_flag?.state !== "none") {
    throw new Error("Add-path enrichment did not flag Eggs none");
}

// Recipe add-moment flags + the pantry-presence gate (Nov 13). The
// story: the Pantry holds Milk and Soy sauce; the list already holds
// Milk, Soy sauce, and Eggs. The recipe asks for all three plus
// Flour. Expected flags: Milk have, Soy sauce listed (on the list
// AND in the pantry — listed outranks have at add moments), Eggs
// listed, Flour none. The add must skip Milk (in the pantry) and the
// quantity-less Soy sauce (listed, nothing to fold — a second row
// would be a duplicate), fold the listed Eggs through the merge
// path as always, and add only the Flour as a new row.
function smokeIngredient(
    name: string,
    quantity: number,
    unit: string,
): Record<string, unknown> {
    return {
        name,
        quantity,
        unit,
        sourceType: "user_supplied",
        nutrients: {
            calories: 10,
            protein_g: 1,
            carbs_g: 1,
            fat_g: 0,
            fiber_g: 0,
        },
    };
}
const flagRecipe = await saveRecipe({
    userId: owner.userId,
    scope: personal,
    idempotencyKey: "grocery-pantry-flag-recipe",
    recipe: {
        name: "Flag Story Bake",
        servings: 1,
        sourceType: "user_entered",
        instructions: ["Bake."],
        ingredients: [
            smokeIngredient("Milk", 0.5, "cup"),
            {
                name: "Soy sauce",
                sourceType: "user_supplied",
                nutrients: {
                    calories: 10,
                    protein_g: 1,
                    carbs_g: 1,
                    fat_g: 0,
                    fiber_g: 0,
                },
            },
            smokeIngredient("Eggs", 6, "count"),
            smokeIngredient("Flour", 2, "cup"),
        ],
    },
});
const workspace = await getRecipeWorkspace(owner.userId, flagRecipe.recipeId);
const flagByName = new Map(
    (workspace.recipe?.ingredients ?? []).map((ingredient) => [
        ingredient.name,
        ingredient.pantry_flag?.state,
    ]),
);
if (flagByName.get("Milk") !== "have") {
    throw new Error("Recipe Milk did not flag have");
}
if (flagByName.get("Soy sauce") !== "listed") {
    throw new Error("Recipe Soy sauce did not flag listed over have");
}
if (flagByName.get("Eggs") !== "listed") {
    throw new Error("Recipe Eggs did not flag listed");
}
if (flagByName.get("Flour") !== "none") {
    throw new Error("Recipe Flour did not flag none");
}
const storedRecipe = await getRecipe(owner.userId, flagRecipe.recipeId);
if (!storedRecipe) throw new Error("Flag recipe did not reload");
const recipeAdd = await addRecipeToGroceryList({
    userId: owner.userId,
    scope: personal,
    recipe: {
        id: storedRecipe.id,
        revisionId: storedRecipe.revision_id,
        name: storedRecipe.name,
        servings: storedRecipe.servings,
        ingredients: storedRecipe.ingredients,
    },
    idempotencyKey: "grocery-pantry-flag-add",
});
if (recipeAdd.added !== 1 || recipeAdd.merged !== 1) {
    throw new Error(
        `Recipe add landed ${recipeAdd.added} added / ${recipeAdd.merged} merged, expected 1 / 1`,
    );
}
if (recipeAdd.skipped_in_pantry !== 1 || recipeAdd.skipped_on_list !== 1) {
    throw new Error(
        `Recipe add skipped ${recipeAdd.skipped_in_pantry} pantry / ${recipeAdd.skipped_on_list} list, expected 1 / 1`,
    );
}
const listAfterAdd = await getGroceryList({
    userId: owner.userId,
    scope: personal,
    includePurchased: false,
});
const flourRows = listAfterAdd.items.filter((item) => item.name === "Flour");
if (flourRows.length !== 1 || flourRows[0]?.quantity !== 2) {
    throw new Error("Flour did not land on the list exactly once");
}
const milkRow = listAfterAdd.items.find((item) => item.name === "Milk");
if (milkRow?.quantity !== 1) {
    throw new Error("Skipped Milk was merged into the list row anyway");
}
const eggsRow = listAfterAdd.items.find((item) => item.name === "Eggs");
if (eggsRow?.quantity !== 18) {
    throw new Error("Listed Eggs did not fold through the merge (12 + 6)");
}
const soyRows = listAfterAdd.items.filter((item) => item.name === "Soy sauce");
if (soyRows.length !== 1) {
    throw new Error("Quantity-less listed Soy sauce gained a second row");
}

// "Ran out": the exact reconcile call the client's button sends.
// Assert BOTH stores — Pantry loses Milk, the list keeps it.
await reconcilePantry({
    userId: owner.userId,
    scope: personal,
    sourceType: "correction",
    idempotencyKey: "grocery-pantry-badge-ran-out",
    operations: [{ action: "consume_all", inventoryItemId: milkPantryId }],
});
const pantryAfter = await getPantry({ userId: owner.userId, scope: personal });
if (pantryAfter.items.some((item) => item.name === "Milk")) {
    throw new Error("Ran out did not remove Milk from the Pantry");
}
const listAfter = await getGroceryList({
    userId: owner.userId,
    scope: personal,
    includePurchased: true,
});
if (!listAfter.items.some((item) => item.name === "Milk")) {
    throw new Error("Ran out removed Milk from the grocery list");
}
const refreshed = await personalWorkspaceItems();
if (refreshed.find((item) => item.name === "Milk")?.pantry_match !== null) {
    throw new Error("Milk still badges after running out");
}
if (
    refreshed.find((item) => item.name === "Milk")?.pantry_flag?.state !==
    "none"
) {
    throw new Error("Milk did not flag none after running out");
}

// Module off: the badge surface goes dark entirely.
await saveFeatureModules(owner.userId, { pantry: false });
const moduleOff = await personalWorkspaceItems();
if (moduleOff.some((item) => item.pantry_match !== null)) {
    throw new Error("Pantry matches survived the Pantry module being off");
}
if (moduleOff.some((item) => item.pantry_flag !== null)) {
    throw new Error("Pantry flags survived the Pantry module being off");
}
await saveFeatureModules(owner.userId, { pantry: true });

await closePlatformDatabase();
console.log(
    "Munch grocery Pantry badge (presence match, ran-out, module gate) smoke test passed.",
);
