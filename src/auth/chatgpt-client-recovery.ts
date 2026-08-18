import { withAuthDatabase } from "../platform/database.js";
import {
    MUNCH_DEFAULT_OAUTH_SCOPES,
    MUNCH_OAUTH_SCOPES,
} from "./oauth-scopes.js";

const CHATGPT_CALLBACK_PATH = /^\/connector\/oauth\/[A-Za-z0-9._~-]+$/;
const CLIENT_ID = /^[A-Za-z0-9._~-]{8,256}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9._~-]{43,128}$/;
const ALLOWED_SCOPES = new Set<string>(MUNCH_OAUTH_SCOPES);

export interface ChatGptOAuthRecoveryCandidate {
    clientId: string;
    redirectUri: string;
}

export function parseChatGptOAuthRecoveryCandidate(
    requestUrl: string,
): ChatGptOAuthRecoveryCandidate | null {
    let request: URL;
    try {
        request = new URL(requestUrl);
    } catch {
        return null;
    }

    if (request.pathname !== "/api/auth/oauth2/authorize") return null;
    if (request.searchParams.get("response_type") !== "code") return null;
    if (request.searchParams.get("code_challenge_method") !== "S256") {
        return null;
    }

    const clientId = request.searchParams.get("client_id")?.trim() ?? "";
    const codeChallenge =
        request.searchParams.get("code_challenge")?.trim() ?? "";
    const redirectRaw = request.searchParams.get("redirect_uri")?.trim() ?? "";
    if (!CLIENT_ID.test(clientId) || !PKCE_CHALLENGE.test(codeChallenge)) {
        return null;
    }

    let redirect: URL;
    try {
        redirect = new URL(redirectRaw);
    } catch {
        return null;
    }
    if (
        redirect.protocol !== "https:" ||
        redirect.hostname !== "chatgpt.com" ||
        redirect.port !== "" ||
        redirect.username !== "" ||
        redirect.password !== "" ||
        redirect.search !== "" ||
        redirect.hash !== "" ||
        !CHATGPT_CALLBACK_PATH.test(redirect.pathname)
    ) {
        return null;
    }

    const requestedScopes = (request.searchParams.get("scope") ?? "")
        .split(/\s+/)
        .filter(Boolean);
    if (requestedScopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
        return null;
    }

    return {
        clientId,
        redirectUri: redirect.toString(),
    };
}

/**
 * Temporary incident recovery for OAuth client registrations that were erased by
 * the 2026-08-18 auth rebaseline. Dynamic client registrations are durable OAuth
 * server state and should never have been reset with sessions/tokens.
 *
 * The repair is intentionally constrained to a public PKCE authorization request
 * whose redirect is an exact ChatGPT-owned connector callback. It never creates
 * a client secret and never accepts an arbitrary callback origin.
 */
export async function recoverMissingChatGptOAuthClient(
    request: Request,
): Promise<boolean> {
    const candidate = parseChatGptOAuthRecoveryCandidate(request.url);
    if (!candidate) return false;

    const scopes = JSON.stringify([...MUNCH_DEFAULT_OAUTH_SCOPES]);
    const redirectUris = JSON.stringify([candidate.redirectUri]);
    const grantTypes = JSON.stringify(["authorization_code", "refresh_token"]);
    const responseTypes = JSON.stringify(["code"]);

    return withAuthDatabase(async (database) => {
        const rows = await database<Array<{ clientId: string }>>`
            insert into munch."oauthClient" (
                "clientId",
                disabled,
                "skipConsent",
                "enableEndSession",
                scopes,
                name,
                uri,
                "redirectUris",
                "tokenEndpointAuthMethod",
                "grantTypes",
                "responseTypes",
                public,
                "requirePKCE",
                "createdAt",
                "updatedAt"
            ) values (
                ${candidate.clientId},
                false,
                false,
                false,
                ${scopes},
                'ChatGPT',
                'https://chatgpt.com',
                ${redirectUris},
                'none',
                ${grantTypes},
                ${responseTypes},
                true,
                true,
                now(),
                now()
            )
            on conflict ("clientId") do nothing
            returning "clientId" as "clientId"
        `;
        return rows.length === 1;
    });
}
