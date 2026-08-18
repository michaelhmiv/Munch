#!/usr/bin/env bun

import { SQL } from "bun";
import { deleteAllUserData } from "../src/nutrition-platform/account.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = new SQL({ url: databaseUrl, max: 1 });
const userId = crypto.randomUUID();
const mealId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const clientId = `delete-smoke-${crypto.randomUUID()}`;
const consentId = crypto.randomUUID();

try {
    await sql`
        insert into munch.users (id, email, name, email_verified, status)
        values (${userId}, ${`delete-${userId}@example.test`}, 'Delete smoke', true, 'active')
    `;
    await sql`
        insert into munch.account_preferences (user_id, timezone)
        values (${userId}, 'America/New_York')
    `;
    await sql`
        insert into munch.meals (id, user_id, description, calories)
        values (${mealId}, ${userId}, 'Disposable deletion smoke meal', 100)
    `;
    await sql`
        insert into munch.auth_sessions (id, user_id, token, expires_at)
        values (${sessionId}, ${userId}, ${`delete-session-${sessionId}`}, now() + interval '1 hour')
    `;
    await sql`
        insert into munch."oauthClient" ("clientId", name, "redirectUris", "grantTypes", "responseTypes", "tokenEndpointAuthMethod")
        values (
            ${clientId}, 'Deletion smoke client', ${JSON.stringify(["https://chatgpt.com/connector_platform_oauth_redirect"])},
            ${JSON.stringify(["authorization_code"])}, ${JSON.stringify(["code"])}, 'none'
        )
    `;
    await sql`
        insert into munch."oauthConsent" (id, "userId", "clientId", scopes)
        values (${consentId}, ${userId}, ${clientId}, ${JSON.stringify(["nutrition.read"])})
    `;

    await deleteAllUserData(userId);

    const remaining = await sql<
        Array<{
            users: number;
            meals: number;
            preferences: number;
            sessions: number;
            consents: number;
        }>
    >`
        select
            (select count(*)::integer from munch.users where id = ${userId}) as users,
            (select count(*)::integer from munch.meals where user_id = ${userId}) as meals,
            (select count(*)::integer from munch.account_preferences where user_id = ${userId}) as preferences,
            (select count(*)::integer from munch.auth_sessions where user_id = ${userId}) as sessions,
            (select count(*)::integer from munch."oauthConsent" where "userId" = ${userId}) as consents
    `;
    const row = remaining[0];
    if (!row || Object.values(row).some((value) => Number(value) !== 0)) {
        throw new Error(
            `Account deletion left user-owned rows: ${JSON.stringify(row)}`,
        );
    }

    const client = await sql<Array<{ count: number }>>`
        select count(*)::integer as count from munch."oauthClient" where "clientId" = ${clientId}
    `;
    if (Number(client[0]?.count) !== 1) {
        throw new Error(
            "Deleting one user must not delete a globally registered OAuth client",
        );
    }

    console.log("Better Auth account deletion smoke checks passed.");
} finally {
    await sql`delete from munch.users where id = ${userId}`;
    await sql`delete from munch."oauthClient" where "clientId" = ${clientId}`;
    await sql.close();
}
