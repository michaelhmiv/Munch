#!/usr/bin/env bun

import { createSmokeIdentity } from "./support/smoke-user.js";

const { exportAccountData } = await import("../src/account-export.js");
const {
    acceptHouseholdInvitation,
    createHousehold,
    createHouseholdInvitation,
} = await import("../src/households/repository.js");
const { reconcilePantry, setPantryPreference } =
    await import("../src/inventory/repository.js");
const { saveRecipeAndPlan } = await import("../src/planning/repository.js");
const { closePlatformDatabase, withUserDatabase } =
    await import("../src/platform/database.js");
const { consumeExportFile } =
    await import("../src/service-platform/repository.js");

if (!process.env.DATABASE_URL || !process.env.MUNCH_APP_BASE_URL) {
    throw new Error(
        "DATABASE_URL and MUNCH_APP_BASE_URL are required for account export smoke tests",
    );
}

const owner = await createSmokeIdentity("export-owner");
const member = await createSmokeIdentity("export-member");
const household = await createHousehold({
    userId: owner.userId,
    name: "Export Household",
    displayName: "Mom",
});
const invitation = await createHouseholdInvitation({
    userId: owner.userId,
    householdId: household.householdId,
    email: member.email,
    role: "member",
});
await acceptHouseholdInvitation({
    userId: member.userId,
    token: invitation.rawToken,
    displayName: "Dad",
});

await saveRecipeAndPlan({
    userId: owner.userId,
    scope: { type: "household", householdId: household.householdId },
    recipe: {
        name: "Spaghetti",
        servings: 4,
        sourceType: "chatgpt_generated",
        instructions: ["Cook the spaghetti."],
        ingredients: [
            {
                name: "Spaghetti",
                quantity: 16,
                unit: "oz",
                sourceType: "user_supplied",
                nutrients: { calories: 1600, protein_g: 56 },
            },
            {
                name: "Yellow onion",
                quantity: 1,
                unit: "whole",
                sourceType: "usda",
                provider: "usda",
                providerFoodId: "170000",
                nutrients: { calories: 44, protein_g: 1.2 },
            },
        ],
    },
    plannedDate: "2026-08-10",
    mealSlot: "dinner",
    plannedServings: 4,
    groceryItems: [{ name: "Yellow onion", quantity: 1, unit: "whole" }],
    idempotencyKey: `export:${crypto.randomUUID()}`,
});

await setPantryPreference({ userId: owner.userId, enabled: true });
await setPantryPreference({ userId: member.userId, enabled: true });
const pantryResult = await reconcilePantry({
    userId: owner.userId,
    scope: { type: "household", householdId: household.householdId },
    sourceType: "manual",
    idempotencyKey: "export-pantry",
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
const cottage = pantryResult.operations[0]?.item;
if (!cottage) throw new Error("Account export Pantry setup returned no item");
await withUserDatabase(owner.userId, async (tx) => {
    await tx`
        insert into munch.inventory_item_profiles (
            inventory_item_id, profile_status, source_type,
            category, culinary_roles, basis_quantity, basis_unit,
            basis_grams, calories, protein_g, profile_version, enriched_at
        ) values (
            ${cottage.id}, 'resolved', 'heuristic', 'dairy',
            ${"{creamy,dairy,protein}"}::text[],
            100, 'g', 100, 100, 12, 1, now()
        )
    `;
});

const exported = await exportAccountData(member.userId);
const token = new URL(exported.url).searchParams.get("token");
if (!token) throw new Error("Account export returned no download token");
const file = await consumeExportFile(token);
if (!file || file.contentType !== "application/json; charset=utf-8") {
    throw new Error("Account export file was unavailable or not JSON");
}
const document = JSON.parse(file.content) as Record<string, unknown>;
const serialized = JSON.stringify(document);
if (serialized.includes(owner.email)) {
    throw new Error("Account export leaked another household member's email");
}
if (serialized.includes(owner.userId)) {
    throw new Error("Account export leaked another household member's user ID");
}
if (!serialized.includes('"display_name":"Mom"')) {
    throw new Error(
        "Account export did not preserve household display attribution",
    );
}
if (!serialized.includes('"name":"Spaghetti"')) {
    throw new Error("Account export omitted accessible household recipes");
}
if (!serialized.includes('"name":"Yellow onion"')) {
    throw new Error("Account export omitted accessible household groceries");
}
if (!serialized.includes('"name":"Cottage cheese"')) {
    throw new Error(
        "Account export omitted accessible shared Pantry inventory",
    );
}
if (!serialized.includes('"inventory_events"')) {
    throw new Error("Account export omitted Pantry event history");
}
const inventoryProfiles = document.inventory_item_profiles;
if (!Array.isArray(inventoryProfiles) || inventoryProfiles.length < 1) {
    throw new Error("Account export omitted Pantry planning profiles");
}
const cottageProfile = inventoryProfiles.find(
    (profile: any) => profile?.category === "dairy",
) as Record<string, unknown> | undefined;
if (!cottageProfile || Number(cottageProfile.protein_g) !== 12) {
    throw new Error("Account export Pantry planning profile was incomplete");
}
if (serialized.includes('"actor_user_id"')) {
    throw new Error("Account export leaked Pantry actor user IDs");
}
if (document.schema_version !== 3) {
    throw new Error(
        "Account export schema version was not advanced for Pantry Intelligence",
    );
}
if (exported.recordCount < 7) {
    throw new Error(
        "Account export did not include the expected shared records",
    );
}

await closePlatformDatabase();
console.log(
    "Munch complete account export and Pantry privacy smoke test passed.",
);
