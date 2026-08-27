import { beforeEach, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import {
    clearGooglePubSubJwksCacheForTests,
    verifyGooglePubSubPushAuthorization,
} from "./google-pubsub-auth.js";

const now = new Date("2026-08-27T13:00:00.000Z");
const config = {
    pushServiceAccountEmail:
        "play-rtdn@example-project.iam.gserviceaccount.com",
    pushAudience: "https://munch.business/webhooks/google-play",
};

function base64Url(value: string | Buffer): string {
    return Buffer.from(value).toString("base64url");
}

function signedToken(overrides: Record<string, unknown> = {}) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
    });
    const kid = "test-key-1";
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const claims = base64Url(
        JSON.stringify({
            iss: "https://accounts.google.com",
            aud: config.pushAudience,
            sub: "1234567890",
            email: config.pushServiceAccountEmail,
            email_verified: true,
            iat: Math.floor(now.getTime() / 1000) - 60,
            exp: Math.floor(now.getTime() / 1000) + 3600,
            ...overrides,
        }),
    );
    const signingInput = `${header}.${claims}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(privateKey);
    const jwk = publicKey.export({ format: "jwk" });
    return {
        token: `${signingInput}.${base64Url(signature)}`,
        jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] },
    };
}

function jwksFetch(jwks: unknown): typeof fetch {
    return (async () =>
        new Response(JSON.stringify(jwks), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=3600",
            },
        })) as typeof fetch;
}

beforeEach(() => clearGooglePubSubJwksCacheForTests());

describe("Google Pub/Sub authenticated push", () => {
    test("accepts a correctly signed token for the configured audience and service account", async () => {
        const fixture = signedToken();
        const claims = await verifyGooglePubSubPushAuthorization({
            authorization: `Bearer ${fixture.token}`,
            config,
            fetchImpl: jwksFetch(fixture.jwks),
            now,
        });
        expect(claims.email).toBe(config.pushServiceAccountEmail);
        expect(claims.aud).toBe(config.pushAudience);
    });

    test("rejects a valid Google signature with the wrong audience", async () => {
        const fixture = signedToken({ aud: "https://example.com/wrong" });
        await expect(
            verifyGooglePubSubPushAuthorization({
                authorization: `Bearer ${fixture.token}`,
                config,
                fetchImpl: jwksFetch(fixture.jwks),
                now,
            }),
        ).rejects.toThrow("google_pubsub_jwt_audience_invalid");
    });

    test("rejects a valid signature from the wrong push service account", async () => {
        const fixture = signedToken({
            email: "other@example-project.iam.gserviceaccount.com",
        });
        await expect(
            verifyGooglePubSubPushAuthorization({
                authorization: `Bearer ${fixture.token}`,
                config,
                fetchImpl: jwksFetch(fixture.jwks),
                now,
            }),
        ).rejects.toThrow("google_pubsub_jwt_service_account_invalid");
    });

    test("rejects an expired token", async () => {
        const fixture = signedToken({
            exp: Math.floor(now.getTime() / 1000) - 600,
        });
        await expect(
            verifyGooglePubSubPushAuthorization({
                authorization: `Bearer ${fixture.token}`,
                config,
                fetchImpl: jwksFetch(fixture.jwks),
                now,
            }),
        ).rejects.toThrow("google_pubsub_jwt_expired");
    });
});
