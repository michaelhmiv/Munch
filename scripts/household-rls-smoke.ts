#!/usr/bin/env bun

const { consumeLoginChallenge, createLoginChallenge } =
    await import("../src/accounts/repository.js");
const {
    acceptHouseholdInvitation,
    createHousehold,
    createHouseholdInvitation,
    getActiveHouseholdContext,
    listHouseholdMembers,
    removeHouseholdMember,
} = await import("../src/households/repository.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for household smoke tests");
}

async function createUser(prefix: string) {
    const email = `${prefix}-${crypto.randomUUID()}@example.test`;
    const challenge = await createLoginChallenge(email);
    if (!(await consumeLoginChallenge(challenge.token))) {
        throw new Error("Unable to activate household smoke user");
    }
    return { userId: challenge.userId, email };
}

const owner = await createUser("household-owner");
const member = await createUser("household-member");
const outsider = await createUser("household-outsider");
const household = await createHousehold({
    userId: owner.userId,
    name: "Smoke Household",
    displayName: "Mom",
});
if (household.role !== "owner") throw new Error("Owner role was not created");

const invitation = await createHouseholdInvitation({
    userId: owner.userId,
    householdId: household.householdId,
    email: member.email,
    role: "member",
});
const accepted = await acceptHouseholdInvitation({
    userId: member.userId,
    token: invitation.rawToken,
    displayName: "Dad",
});
if (accepted.householdId !== household.householdId) {
    throw new Error("Invitation did not join the intended household");
}

let reused = false;
try {
    await acceptHouseholdInvitation({
        userId: member.userId,
        token: invitation.rawToken,
        displayName: "Dad",
    });
} catch {
    reused = true;
}
if (!reused) throw new Error("Household invitation was reusable");

const members = await listHouseholdMembers(owner.userId, household.householdId);
if (members.length !== 2 || members[0]?.displayName !== "Mom") {
    throw new Error("Household member listing was incorrect");
}
if (
    (await listHouseholdMembers(outsider.userId, household.householdId)).length !==
    0
) {
    throw new Error("Cross-household member enumeration was allowed");
}
if ((await getActiveHouseholdContext(member.userId))?.displayName !== "Dad") {
    throw new Error("Joined member could not resolve shared context");
}

const memberRow = members.find((entry) => entry.userId === member.userId);
if (!memberRow) throw new Error("Joined member row was missing");
if (
    !(await removeHouseholdMember({
        userId: owner.userId,
        householdId: household.householdId,
        membershipId: memberRow.membershipId,
    }))
) {
    throw new Error("Owner could not remove household member");
}
if (await getActiveHouseholdContext(member.userId)) {
    throw new Error("Removed member retained household access");
}

await closePlatformDatabase();
console.log("Munch household membership, invitation, and RLS smoke test passed.");
