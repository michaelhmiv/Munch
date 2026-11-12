#!/usr/bin/env bun

import { createSmokeIdentity } from "./support/smoke-user.js";

const { getPlanningWorkspace } = await import("../src/app/repository.js");
const { saveFeatureModules } =
    await import("../src/feature-modules-repository.js");
const { attachPantryMatchesForScope } =
    await import("../src/inventory/grocery-pantry.js");
const { getPantry, reconcilePantry } =
    await import("../src/inventory/repository.js");
const { addGroceryItems, getGroceryList } =
    await import("../src/planning/repository.js");
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

// Module off: the badge surface goes dark entirely.
await saveFeatureModules(owner.userId, { pantry: false });
const moduleOff = await personalWorkspaceItems();
if (moduleOff.some((item) => item.pantry_match !== null)) {
    throw new Error("Pantry matches survived the Pantry module being off");
}
await saveFeatureModules(owner.userId, { pantry: true });

await closePlatformDatabase();
console.log(
    "Munch grocery Pantry badge (presence match, ran-out, module gate) smoke test passed.",
);
