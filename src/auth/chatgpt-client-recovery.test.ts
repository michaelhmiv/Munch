import { describe, expect, test } from "bun:test";
import { parseChatGptOAuthRecoveryCandidate } from "./chatgpt-client-recovery.js";

const clientId = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const codeChallenge = "abcdefghijklmnopqrstuvwxyzABCDEFGH0123456789-._~";

function authorizeUrl(
    overrides: Record<string, string> = {},
): string {
    const url = new URL("https://munch.example/api/auth/oauth2/authorize");
    const params: Record<string, string> = {
        client_id: clientId,
        redirect_uri: "https://chatgpt.com/connector/oauth/munch-callback-123",
        response_type: "code",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: "nutrition.read nutrition.write offline_access",
        ...overrides,
    };
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    return url.toString();
}

describe("ChatGPT OAuth client recovery candidate", () => {
    test("accepts the documented ChatGPT connector callback with PKCE", () => {
        expect(parseChatGptOAuthRecoveryCandidate(authorizeUrl())).toEqual({
            clientId,
            redirectUri:
                "https://chatgpt.com/connector/oauth/munch-callback-123",
        });
    });

    test("rejects callbacks outside chatgpt.com", () => {
        expect(
            parseChatGptOAuthRecoveryCandidate(
                authorizeUrl({
                    redirect_uri:
                        "https://attacker.example/connector/oauth/munch-callback-123",
                }),
            ),
        ).toBeNull();
    });

    test("rejects non-connector ChatGPT callback paths", () => {
        expect(
            parseChatGptOAuthRecoveryCandidate(
                authorizeUrl({ redirect_uri: "https://chatgpt.com/callback" }),
            ),
        ).toBeNull();
    });

    test("requires authorization-code PKCE with S256", () => {
        expect(
            parseChatGptOAuthRecoveryCandidate(
                authorizeUrl({ code_challenge_method: "plain" }),
            ),
        ).toBeNull();
        expect(
            parseChatGptOAuthRecoveryCandidate(
                authorizeUrl({ response_type: "token" }),
            ),
        ).toBeNull();
    });

    test("rejects scopes outside the Munch OAuth contract", () => {
        expect(
            parseChatGptOAuthRecoveryCandidate(
                authorizeUrl({ scope: "nutrition.read admin" }),
            ),
        ).toBeNull();
    });
});
