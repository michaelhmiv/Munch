import { expect, test } from "bun:test";
import {
    authorizationServerMetadata,
    protectedResourceMetadata,
} from "./discovery.js";

const ORIGIN = "https://munch.example";

test("discovery advertises the canonical Better Auth issuer", () => {
    expect(authorizationServerMetadata(ORIGIN)).toMatchObject({
        issuer: `${ORIGIN}/api/auth`,
        authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
        token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
        registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
        revocation_endpoint: `${ORIGIN}/api/auth/oauth2/revoke`,
        introspection_endpoint: `${ORIGIN}/api/auth/oauth2/introspect`,
        jwks_uri: `${ORIGIN}/api/auth/jwks`,
        code_challenge_methods_supported: ["S256"],
    });
});

test("protected-resource metadata identifies Munch scopes", () => {
    expect(protectedResourceMetadata(ORIGIN, `${ORIGIN}/mcp`)).toMatchObject({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [`${ORIGIN}/api/auth`],
        scopes_supported: [
            "nutrition.read",
            "nutrition.write",
            "offline_access",
        ],
    });
});
