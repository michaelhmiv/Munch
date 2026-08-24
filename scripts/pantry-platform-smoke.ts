#!/usr/bin/env bun

import { createSmokeIdentity } from "./support/smoke-user.js";

const {
    acceptHouseholdInvitation,
    createHousehold,
    createHouseholdInvitation,
} = await import("../src/households/repository.js");
const { getPantry, reconcilePantry, reconcilePurchase, setPantryPreference } =
    await import("../src/inventory/repository.js");
const { addGroceryItems, getGroceryList, markGroceryItemPurchased } =
    await import("../src/planning/repository.js");
const { closePlatformDatabase, withUserDatabase } =
    await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Pantry smoke tests");
}

const owner = await createSmokeIdentity("pantry-owner");
const member = await createSmokeIdentity("pantry-member");
const viewer = await createSmokeIdentity("pantry-viewer");
const outsider = await createSmokeIdentity("pantry-outsider");

const household = await createHousehold({
    userId: owner.userId,
    name: "Pantry Household",
    displayName: "Owner",
});
for (const [person, role, displayName] of [
    [member, "member", "Member"],
    [viewer, "viewer", "Viewer"],
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

await setPantryPreference({ userId: owner.userId, enabled: true });
await setPantryPreference({ userId: member.userId, enabled: true });
await setPantryPreference({ userId: viewer.userId, enabled: true });
await setPantryPreference({ userId: outsider.userId, enabled: true });

const personalScope = { type: "personal" as const };
const householdScope = {
    type: "household" as const,
    householdId: household.householdId,
};

// Exact/approximate/presence-only state plus idempotent event replay.
const initial = await reconcilePantry({
    userId: owner.userId,
    scope: personalScope,
    sourceType: "manual",
    idempotencyKey: "pantry-smoke-initial",
    operations: [
        {
            action: "acquire",
            name: "Granulated sugar",
            quantity: 1,
            unit: "lb",
            location: "pantry",
        },
        {
            action: "acquire",
            name: "Spinach",
            quantityMode: "presence_only",
            location: "fridge",
        },
    ],
});
if (initial.operations.length !== 2) {
    throw new Error(
        "Initial Pantry reconciliation did not apply two operations",
    );
}
const replay = await reconcilePantry({
    userId: owner.userId,
    scope: personalScope,
    sourceType: "manual",
    idempotencyKey: "pantry-smoke-initial",
    operations: [
        {
            action: "acquire",
            name: "Granulated sugar",
            quantity: 1,
            unit: "lb",
            location: "pantry",
        },
        {
            action: "acquire",
            name: "Spinach",
            quantityMode: "presence_only",
            location: "fridge",
        },
    ],
});
if (!replay.operations.every((operation) => operation.deduplicated)) {
    throw new Error("Pantry reconciliation replay was not idempotent");
}

let pantry = await getPantry({
    userId: owner.userId,
    scope: personalScope,
    includeDepleted: true,
});
const sugar = pantry.items.find(
    (item) => item.normalized_name === "granulated sugar",
);
const spinach = pantry.items.find((item) => item.normalized_name === "spinach");
if (sugar?.quantity !== 1 || sugar.quantity_mode !== "exact") {
    throw new Error("Exact Pantry quantity did not persist");
}
if (spinach?.quantity !== null || spinach.quantity_mode !== "presence_only") {
    throw new Error("Presence-only Pantry state did not persist");
}

await reconcilePantry({
    userId: owner.userId,
    scope: personalScope,
    sourceType: "meal_reconciliation",
    idempotencyKey: "pantry-smoke-consume",
    operations: [
        {
            action: "consume",
            inventoryItemId: sugar.id,
            quantity: 0.5,
            unit: "lb",
        },
        {
            action: "mark_low",
            inventoryItemId: spinach.id,
        },
    ],
});
pantry = await getPantry({
    userId: owner.userId,
    scope: personalScope,
    includeDepleted: true,
});
if (pantry.items.find((item) => item.id === sugar.id)?.quantity !== 0.5) {
    throw new Error("Pantry consumption did not decrement exact quantity");
}
if (
    pantry.items.find((item) => item.id === spinach.id)?.stock_state !== "low"
) {
    throw new Error("Pantry low-state reconciliation failed");
}

// Grocery checkoff must replenish Pantry automatically when Pantry is enabled.
const grocery = await addGroceryItems({
    userId: owner.userId,
    scope: personalScope,
    items: [
        {
            name: "Granulated sugar",
            quantity: 4,
            unit: "lb",
            idempotencyKey: "pantry-smoke-grocery-sugar",
        },
    ],
});
const groceryItem = grocery.items[0];
if (!groceryItem) throw new Error("Pantry grocery setup failed");
await markGroceryItemPurchased({
    userId: owner.userId,
    scope: personalScope,
    groceryItemId: String(groceryItem.id),
    purchased: true,
    expectedVersion: Number(groceryItem.version),
});
pantry = await getPantry({ userId: owner.userId, scope: personalScope });
const replenishedSugar = pantry.items.find(
    (item) => item.normalized_name === "granulated sugar",
);
if (replenishedSugar?.quantity !== 4.5) {
    throw new Error(
        `Grocery checkoff did not replenish Pantry exactly once (got ${replenishedSugar?.quantity})`,
    );
}

// If the user checks Grocery first and uploads the receipt second, the receipt
// corrects the original acquisition instead of creating a duplicate purchase.
const checkedThenReceipted = await reconcilePurchase({
    userId: owner.userId,
    scope: personalScope,
    idempotencyKey: "pantry-smoke-checked-then-receipt",
    sourceLabel: "Synthetic Market receipt after Grocery checkoff",
    lines: [
        {
            rawLabel: "SUGAR 5 LB",
            name: "Granulated sugar",
            quantity: 5,
            unit: "lb",
            confidence: 0.99,
            isFood: true,
            location: "pantry",
        },
    ],
});
if (
    checkedThenReceipted.summary.groceryMatched !== 1 ||
    checkedThenReceipted.summary.inventoryAdded !== 0
) {
    throw new Error(
        `Checked Grocery receipt did not reconcile in place: ${JSON.stringify(checkedThenReceipted.summary)}`,
    );
}
pantry = await getPantry({ userId: owner.userId, scope: personalScope });
const correctedSugar = pantry.items.find(
    (item) => item.normalized_name === "granulated sugar",
);
if (correctedSugar?.quantity !== 5.5) {
    throw new Error(
        `Receipt correction double-counted or missed the checked Grocery purchase (got ${correctedSugar?.quantity})`,
    );
}

// Receipt: one Grocery match, one new food, one non-food, one uncertain line.
const receiptGroceries = await addGroceryItems({
    userId: owner.userId,
    scope: personalScope,
    items: [
        {
            name: "Avocados",
            quantity: 2,
            unit: "count",
            idempotencyKey: "pantry-smoke-avocados",
        },
    ],
});
if (!receiptGroceries.items[0]) throw new Error("Receipt grocery setup failed");
const receipt = await reconcilePurchase({
    userId: owner.userId,
    scope: personalScope,
    idempotencyKey: "pantry-smoke-receipt",
    sourceLabel: "Synthetic Market receipt",
    lines: [
        {
            rawLabel: "AVOCADO 3",
            name: "Avocados",
            quantity: 3,
            unit: "count",
            confidence: 0.99,
            isFood: true,
            location: "fridge",
        },
        {
            rawLabel: "GREEK YOG",
            name: "Greek yogurt",
            quantity: 1,
            unit: "count",
            confidence: 0.96,
            isFood: true,
            location: "fridge",
        },
        {
            rawLabel: "PAPER TOWEL",
            name: "Paper towels",
            quantity: 1,
            unit: "count",
            confidence: 0.99,
            isFood: false,
        },
        {
            rawLabel: "CRN 12",
            name: "Corn product",
            confidence: 0.5,
            isFood: true,
        },
    ],
});
if (
    receipt.summary.groceryMatched !== 1 ||
    receipt.summary.inventoryAdded !== 1 ||
    receipt.summary.ignoredNonFood !== 1 ||
    receipt.summary.needsReview !== 1
) {
    throw new Error(
        `Receipt reconciliation summary was wrong: ${JSON.stringify(receipt.summary)}`,
    );
}
const receiptReplay = await reconcilePurchase({
    userId: owner.userId,
    scope: personalScope,
    idempotencyKey: "pantry-smoke-receipt",
    sourceLabel: "Synthetic Market receipt",
    lines: [{ name: "This replay input must not be applied" }],
});
if (!receiptReplay.deduplicated) {
    throw new Error("Receipt reconciliation replay was not idempotent");
}

const groceryAfterReceipt = await getGroceryList({
    userId: owner.userId,
    scope: personalScope,
    includePurchased: true,
});
const avocadoGrocery = groceryAfterReceipt.items.find(
    (item) => item.name === "Avocados",
);
if (!avocadoGrocery?.purchased_at) {
    throw new Error("Receipt did not mark matching Grocery item purchased");
}
if (avocadoGrocery.quantity !== 3) {
    throw new Error(
        `Receipt did not preserve the actual purchased Grocery quantity (got ${avocadoGrocery.quantity})`,
    );
}
pantry = await getPantry({ userId: owner.userId, scope: personalScope });
if (!pantry.items.some((item) => item.normalized_name === "greek yogurt")) {
    throw new Error("Unplanned receipt food was not added to Pantry");
}
if (pantry.items.some((item) => item.normalized_name === "paper towels")) {
    throw new Error("Non-food receipt line leaked into Pantry");
}
if (pantry.items.some((item) => item.normalized_name === "corn product")) {
    throw new Error("Low-confidence receipt line silently mutated Pantry");
}

// Household inventory is shared; viewers can read but cannot write; outsiders
// cannot read or create inventory in another household.
await reconcilePantry({
    userId: owner.userId,
    scope: householdScope,
    sourceType: "manual",
    idempotencyKey: "pantry-smoke-household",
    operations: [
        {
            action: "acquire",
            name: "Cottage cheese",
            quantity: 24,
            unit: "oz",
            location: "fridge",
        },
    ],
});
const memberPantry = await getPantry({
    userId: member.userId,
    scope: householdScope,
});
if (
    !memberPantry.items.some(
        (item) => item.normalized_name === "cottage cheese",
    )
) {
    throw new Error("Household member could not read shared Pantry");
}
const viewerPantry = await getPantry({
    userId: viewer.userId,
    scope: householdScope,
});
if (
    !viewerPantry.items.some(
        (item) => item.normalized_name === "cottage cheese",
    )
) {
    throw new Error("Household viewer could not read shared Pantry");
}

let viewerWriteDenied = false;
try {
    await reconcilePantry({
        userId: viewer.userId,
        scope: householdScope,
        sourceType: "manual",
        idempotencyKey: "pantry-smoke-viewer-write",
        operations: [{ action: "acquire", name: "Viewer food" }],
    });
} catch {
    viewerWriteDenied = true;
}
if (!viewerWriteDenied) {
    throw new Error("Household viewer was allowed to mutate Pantry");
}

const outsiderPantry = await getPantry({
    userId: outsider.userId,
    scope: householdScope,
});
if (
    outsiderPantry.items.length !== 0 ||
    outsiderPantry.inventorySpaceId !== null
) {
    throw new Error("Outsider read another household Pantry");
}
let outsiderWriteDenied = false;
try {
    await reconcilePantry({
        userId: outsider.userId,
        scope: householdScope,
        sourceType: "manual",
        idempotencyKey: "pantry-smoke-outsider-write",
        operations: [{ action: "acquire", name: "Outsider food" }],
    });
} catch {
    outsiderWriteDenied = true;
}
if (!outsiderWriteDenied) {
    throw new Error("Outsider was allowed to create another household Pantry");
}

// Privacy invariant: reconciliation stores structured lines, never image bytes.
await withUserDatabase(owner.userId, async (tx) => {
    const forbiddenColumns = await tx<Array<{ column_name: string }>>`
        select column_name from information_schema.columns
        where table_schema = 'munch'
          and table_name in ('purchase_reconciliations', 'purchase_reconciliation_lines')
          and column_name in ('image', 'image_bytes', 'raw_image', 'receipt_image', 'base64')
    `;
    if (forbiddenColumns.length) {
        throw new Error(
            "Receipt persistence unexpectedly contains raw image columns",
        );
    }
});

await closePlatformDatabase();
console.log(
    "Munch Pantry inventory, Grocery acquisition, receipt reconciliation, idempotency, and RLS smoke test passed.",
);
