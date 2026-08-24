#!/usr/bin/env bun

import { createSmokeIdentity } from "./support/smoke-user.js";

const { deleteAllUserData } = await import("../src/nutrition-platform/account.js");
const {
    acceptHouseholdInvitation,
    createHousehold,
    createHouseholdInvitation,
} = await import("../src/households/repository.js");
const {
    getPantry,
    reconcilePantry,
    setPantryPreference,
} = await import("../src/inventory/repository.js");
const { closePlatformDatabase, withUserDatabase } =
    await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Pantry deletion smoke tests");
}

const owner = await createSmokeIdentity("pantry-delete-owner");
const member = await createSmokeIdentity("pantry-delete-member");
const household = await createHousehold({
    userId: owner.userId,
    name: "Pantry Deletion Household",
    displayName: "Owner",
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
    displayName: "Member",
});
await setPantryPreference({ userId: owner.userId, enabled: true });
await setPantryPreference({ userId: member.userId, enabled: true });

const scope = {
    type: "household" as const,
    householdId: household.householdId,
};
await reconcilePantry({
    userId: member.userId,
    scope,
    sourceType: "manual",
    idempotencyKey: "member-created-pantry-event",
    operations: [
        {
            action: "acquire",
            name: "Greek yogurt",
            quantity: 1,
            unit: "count",
            location: "fridge",
        },
    ],
});

await deleteAllUserData(member.userId);

const pantry = await getPantry({ userId: owner.userId, scope });
if (!pantry.items.some((item) => item.normalized_name === "greek yogurt")) {
    throw new Error(
        "Deleting a household member removed shared Pantry inventory they created",
    );
}

await withUserDatabase(owner.userId, async (tx) => {
    const rows = await tx<Array<{ actor_user_id: string | null }>>`
        select event.actor_user_id
        from munch.inventory_events event
        join munch.inventory_items item on item.id = event.inventory_item_id
        where item.normalized_name = 'greek yogurt'
        limit 1
    `;
    if (!rows[0] || rows[0].actor_user_id !== null) {
        throw new Error(
            "Deleted household member remained attached to Pantry event attribution",
        );
    }
});

await closePlatformDatabase();
console.log(
    "Munch shared Pantry survives household-member account deletion with anonymized actor attribution.",
);
