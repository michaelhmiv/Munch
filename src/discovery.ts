import type { Context, Hono } from "hono";
import { MUNCH_OAUTH_SCOPES } from "./auth/oauth-scopes.js";
import { getBaseUrl } from "./url.js";

export const MCP_PATH = "/mcp";
export const BETTER_AUTH_ISSUER_PATH = "/api/auth";

export function mcpResourceUrl(baseUrl: string): string {
    return `${baseUrl}${MCP_PATH}`;
}

export function oauthIssuerUrl(baseUrl: string): string {
    return `${baseUrl}${BETTER_AUTH_ISSUER_PATH}`;
}

export function resourceMetadataUrl(baseUrl: string): string {
    return `${baseUrl}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

export function protectedResourceMetadata(baseUrl: string, resource: string) {
    return {
        resource,
        authorization_servers: [oauthIssuerUrl(baseUrl)],
        bearer_methods_supported: ["header"],
        scopes_supported: [...MUNCH_OAUTH_SCOPES],
        resource_name: "Munch nutrition MCP",
    };
}

export function authorizationServerMetadata(baseUrl: string) {
    const issuer = oauthIssuerUrl(baseUrl);
    return {
        issuer,
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        token_endpoint: `${issuer}/oauth2/token`,
        registration_endpoint: `${issuer}/oauth2/register`,
        revocation_endpoint: `${issuer}/oauth2/revoke`,
        introspection_endpoint: `${issuer}/oauth2/introspect`,
        jwks_uri: `${baseUrl}/api/auth/jwks`,
        grant_types_supported: ["authorization_code", "refresh_token"],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
            "none",
            "client_secret_basic",
            "client_secret_post",
        ],
        scopes_supported: [...MUNCH_OAUTH_SCOPES],
    };
}

export function registerDiscoveryRoutes(app: Hono): void {
    const protectedResource =
        (resource: (baseUrl: string) => string) => (c: Context) => {
            const baseUrl = getBaseUrl(c);
            return c.json(
                protectedResourceMetadata(baseUrl, resource(baseUrl)),
                200,
                {
                    "Cache-Control":
                        "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
                },
            );
        };
    const authorizationServer = (c: Context) =>
        c.json(authorizationServerMetadata(getBaseUrl(c)), 200, {
            "Cache-Control":
                "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
        });

    app.get("/.well-known/openai-apps-challenge", (c) => {
        const challenge = process.env.OPENAI_APPS_CHALLENGE?.trim();
        if (!challenge) return c.notFound();
        return c.text(challenge, 200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
        });
    });

    app.get(
        "/.well-known/oauth-protected-resource",
        protectedResource((baseUrl) => baseUrl),
    );
    app.get(
        `/.well-known/oauth-protected-resource${MCP_PATH}`,
        protectedResource(mcpResourceUrl),
    );
    app.get(
        `${MCP_PATH}/.well-known/oauth-protected-resource`,
        protectedResource(mcpResourceUrl),
    );

    app.get("/.well-known/oauth-authorization-server", authorizationServer);
    app.get(
        `/.well-known/oauth-authorization-server${MCP_PATH}`,
        authorizationServer,
    );
    app.get(
        `${MCP_PATH}/.well-known/oauth-authorization-server`,
        authorizationServer,
    );
    app.get(
        `/.well-known/oauth-authorization-server${BETTER_AUTH_ISSUER_PATH}`,
        authorizationServer,
    );
    app.get(
        `${BETTER_AUTH_ISSUER_PATH}/.well-known/oauth-authorization-server`,
        authorizationServer,
    );

    app.get("/.well-known/openid-configuration", authorizationServer);
    app.get(
        `/.well-known/openid-configuration${MCP_PATH}`,
        authorizationServer,
    );
    app.get(
        `${MCP_PATH}/.well-known/openid-configuration`,
        authorizationServer,
    );
    app.get(
        `/.well-known/openid-configuration${BETTER_AUTH_ISSUER_PATH}`,
        authorizationServer,
    );
    app.get(
        `${BETTER_AUTH_ISSUER_PATH}/.well-known/openid-configuration`,
        authorizationServer,
    );
}
