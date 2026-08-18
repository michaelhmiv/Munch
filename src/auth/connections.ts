import { withAuthDatabase } from "../platform/database.js";

export interface OAuthConnectionSummary {
    connectionId: string;
    /** @deprecated UI transport alias; remove after the settings bundle is regenerated. */
    tokenFamilyId: string;
    clientId: string;
    clientName: string | null;
    scopes: string[];
    connectedAt: string;
    lastAuthorizedAt: string;
    expiresAt: string;
    activeAccessTokens: number;
    activeRefreshTokens: number;
}

function parseScopes(value: string | null): string[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter(
                  (scope): scope is string => typeof scope === "string",
              )
            : [];
    } catch {
        return [];
    }
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
    );
}

export async function listOAuthConnections(
    userId: string,
): Promise<OAuthConnectionSummary[]> {
    return withAuthDatabase(async (tx) => {
        const rows = await tx<
            Array<{
                connection_id: string;
                client_id: string;
                client_name: string | null;
                scopes: string | null;
                connected_at: Date | string;
                last_authorized_at: Date | string;
                expires_at: Date | string;
                active_access_tokens: number;
                active_refresh_tokens: number;
            }>
        >`
            select
                consent.id as connection_id,
                consent."clientId" as client_id,
                client.name as client_name,
                consent.scopes,
                consent."createdAt" as connected_at,
                greatest(
                    consent."updatedAt",
                    coalesce((
                        select max(refresh."createdAt")
                        from munch."oauthRefreshToken" refresh
                        where refresh."userId" = ${userId}
                          and refresh."clientId" = consent."clientId"
                          and refresh."referenceId" is not distinct from consent."referenceId"
                    ), consent."updatedAt"),
                    coalesce((
                        select max(access."createdAt")
                        from munch."oauthAccessToken" access
                        where access."userId" = ${userId}
                          and access."clientId" = consent."clientId"
                          and access."referenceId" is not distinct from consent."referenceId"
                    ), consent."updatedAt")
                ) as last_authorized_at,
                greatest(
                    coalesce((
                        select max(refresh."expiresAt")
                        from munch."oauthRefreshToken" refresh
                        where refresh."userId" = ${userId}
                          and refresh."clientId" = consent."clientId"
                          and refresh."referenceId" is not distinct from consent."referenceId"
                          and refresh.revoked is null
                    ), consent."updatedAt"),
                    coalesce((
                        select max(access."expiresAt")
                        from munch."oauthAccessToken" access
                        where access."userId" = ${userId}
                          and access."clientId" = consent."clientId"
                          and access."referenceId" is not distinct from consent."referenceId"
                    ), consent."updatedAt")
                ) as expires_at,
                (
                    select count(*)::integer
                    from munch."oauthAccessToken" access
                    where access."userId" = ${userId}
                      and access."clientId" = consent."clientId"
                      and access."referenceId" is not distinct from consent."referenceId"
                      and access."expiresAt" > now()
                ) as active_access_tokens,
                (
                    select count(*)::integer
                    from munch."oauthRefreshToken" refresh
                    where refresh."userId" = ${userId}
                      and refresh."clientId" = consent."clientId"
                      and refresh."referenceId" is not distinct from consent."referenceId"
                      and refresh.revoked is null
                      and refresh."expiresAt" > now()
                ) as active_refresh_tokens
            from munch."oauthConsent" consent
            join munch."oauthClient" client on client."clientId" = consent."clientId"
            where consent."userId" = ${userId}
            order by last_authorized_at desc, consent.id
        `;

        return rows.map((row) => ({
            connectionId: row.connection_id,
            tokenFamilyId: row.connection_id,
            clientId: row.client_id,
            clientName: row.client_name,
            scopes: parseScopes(row.scopes),
            connectedAt: new Date(row.connected_at).toISOString(),
            lastAuthorizedAt: new Date(row.last_authorized_at).toISOString(),
            expiresAt: new Date(row.expires_at).toISOString(),
            activeAccessTokens: Number(row.active_access_tokens),
            activeRefreshTokens: Number(row.active_refresh_tokens),
        }));
    });
}

export async function revokeOAuthConnection(
    userId: string,
    connectionId: string,
): Promise<boolean> {
    if (!isUuid(connectionId)) return false;

    return withAuthDatabase(async (tx) => {
        const consents = await tx<
            Array<{
                id: string;
                client_id: string;
                reference_id: string | null;
            }>
        >`
            select id, "clientId" as client_id, "referenceId" as reference_id
            from munch."oauthConsent"
            where id = ${connectionId} and "userId" = ${userId}
            for update
        `;
        const consent = consents[0];
        if (!consent) return false;

        await tx`
            update munch."oauthRefreshToken"
            set revoked = coalesce(revoked, now())
            where "userId" = ${userId}
              and "clientId" = ${consent.client_id}
              and "referenceId" is not distinct from ${consent.reference_id}
        `;
        await tx`
            delete from munch."oauthAccessToken"
            where "userId" = ${userId}
              and "clientId" = ${consent.client_id}
              and "referenceId" is not distinct from ${consent.reference_id}
        `;
        await tx`
            delete from munch."oauthConsent"
            where id = ${connectionId} and "userId" = ${userId}
        `;
        return true;
    });
}
