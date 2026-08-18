#!/usr/bin/env bun

import { SQL } from "bun";
import {
    listOAuthConnections,
    revokeOAuthConnection,
} from "../src/auth/connections.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = new SQL({ url: databaseUrl, max: 1 });

const userId = crypto.randomUUID();
const clientId = `smoke-${crypto.randomUUID()}`;
const connectionId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const refreshId = crypto.randomUUID();
const accessId = crypto.randomUUID();

try {
    await sql`
        insert into munch.users (id, email, name, email_verified, status)
        values (${userId}, ${`connections-${userId}@example.test`}, 'Connection smoke', true, 'active')
    `;
    await sql`
        insert into munch.auth_sessions (id, user_id, token, expires_at)
        values (${sessionId}, ${userId}, ${`session-${sessionId}`}, now() + interval '1 hour')
    `;
    await sql`
        insert into munch."oauthClient" (
            "clientId", name, "redirectUris", "grantTypes", "responseTypes",
            "tokenEndpointAuthMethod", scopes, resources
        ) values (
            ${clientId}, 'ChatGPT smoke client', ${JSON.stringify(["https://chatgpt.com/connector_platform_oauth_redirect"])},
            ${JSON.stringify(["authorization_code", "refresh_token"])}, ${JSON.stringify(["code"])},
            'none', ${JSON.stringify(["nutrition.read", "nutrition.write"])},
            ${JSON.stringify(["https://munch.example/mcp"])}
        )
    `;
    await sql`
        insert into munch."oauthConsent" (id, "userId", "clientId", scopes)
        values (${connectionId}, ${userId}, ${clientId}, ${JSON.stringify(["nutrition.read", "nutrition.write"])})
    `;
    await sql`
        insert into munch."oauthRefreshToken" (
            id, token, "clientId", "sessionId", "userId", scopes, "expiresAt"
        ) values (
            ${refreshId}, ${`refresh-${refreshId}`}, ${clientId}, ${sessionId}, ${userId},
            ${JSON.stringify(["nutrition.read", "nutrition.write"])}, now() + interval '30 days'
        )
    `;
    await sql`
        insert into munch."oauthAccessToken" (
            id, token, "clientId", "sessionId", "refreshId", "userId", scopes, "expiresAt"
        ) values (
            ${accessId}, ${`access-${accessId}`}, ${clientId}, ${sessionId}, ${refreshId}, ${userId},
            ${JSON.stringify(["nutrition.read", "nutrition.write"])}, now() + interval '15 minutes'
        )
    `;

    const before = await listOAuthConnections(userId);
    if (before.length !== 1 || before[0]?.connectionId !== connectionId) {
        throw new Error(
            `Expected one Better Auth connection, got ${JSON.stringify(before)}`,
        );
    }
    if (
        before[0]?.activeRefreshTokens !== 1 ||
        before[0]?.activeAccessTokens !== 1
    ) {
        throw new Error("Connection token counts are incorrect");
    }

    if (!(await revokeOAuthConnection(userId, connectionId))) {
        throw new Error(
            "Expected Better Auth connection revocation to succeed",
        );
    }
    if (await revokeOAuthConnection(userId, connectionId)) {
        throw new Error(
            "Connection revocation must be absent after first revoke",
        );
    }

    const after = await listOAuthConnections(userId);
    if (after.length !== 0) throw new Error("Revoked consent is still listed");

    const refresh = await sql<Array<{ revoked: Date | null }>>`
        select revoked from munch."oauthRefreshToken" where id = ${refreshId}
    `;
    if (!refresh[0]?.revoked) throw new Error("Refresh token was not revoked");
    const access = await sql<Array<{ count: number }>>`
        select count(*)::integer as count from munch."oauthAccessToken" where id = ${accessId}
    `;
    if (Number(access[0]?.count) !== 0)
        throw new Error("Access token metadata was not removed");

    console.log("Better Auth connection smoke checks passed.");
} finally {
    await sql`delete from munch.users where id = ${userId}`;
    await sql`delete from munch."oauthClient" where "clientId" = ${clientId}`;
    await sql.close();
}
