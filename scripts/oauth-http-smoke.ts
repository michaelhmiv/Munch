#!/usr/bin/env bun

import { Hono } from "hono";
import {
    consumeLoginChallenge,
    createLoginChallenge,
} from "../src/accounts/repository.js";
import { codeChallengeForVerifier } from "../src/oauth-platform/pkce.js";
import {
    authorizeSession,
    issueAuthorizationCode,
    resolveAccessToken,
} from "../src/oauth-platform/repository.js";
import { createPlatformOAuthRouter } from "../src/oauth-platform/routes.js";
import { closePlatformDatabase } from "../src/platform/database.js";

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the OAuth HTTP smoke test");
}

function stage(message: string): void {
    console.log(`[oauth-http-smoke] ${message}`);
}

const heartbeat = setInterval(() => stage("still running"), 30_000);
let succeeded = false;

try {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    stage("creating account login challenge");
    const challenge = await createLoginChallenge(
        `oauth-http-${suffix}@example.test`,
    );
    const webSession = await consumeLoginChallenge(challenge.token);
    if (!webSession)
        throw new Error("Unable to activate OAuth HTTP smoke user");

    const app = new Hono();
    app.route("/", createPlatformOAuthRouter());

    const redirectUri = "https://client.example/callback";
    stage("registering OAuth client");
    const registrationResponse = await app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_name: "HTTP smoke client",
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: "none",
        }),
    });
    if (registrationResponse.status !== 201) {
        throw new Error(
            `Client registration failed: ${registrationResponse.status}`,
        );
    }
    const registration = (await registrationResponse.json()) as {
        client_id: string;
    };

    const verifier = "H".repeat(64);
    const authorizeUrl = new URL("https://munch.test/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", registration.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", `state-${suffix}`);
    authorizeUrl.searchParams.set(
        "code_challenge",
        codeChallengeForVerifier(verifier),
    );
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    stage("creating authorization session");
    const authorizeResponse = await app.request(
        `${authorizeUrl.pathname}${authorizeUrl.search}`,
    );
    if (authorizeResponse.status !== 303) {
        throw new Error(
            `Authorization request failed: ${authorizeResponse.status}`,
        );
    }
    const continueLocation = authorizeResponse.headers.get("location");
    if (!continueLocation) {
        throw new Error("Authorization response had no location");
    }
    const authorizationSessionId = new URL(
        continueLocation,
        "https://munch.test",
    ).searchParams.get("session_id");
    if (!authorizationSessionId) {
        throw new Error("Authorization continuation had no session ID");
    }

    stage("approving authorization session");
    if (!(await authorizeSession(authorizationSessionId, challenge.userId))) {
        throw new Error("Unable to attach HTTP authorization session");
    }
    const code = await issueAuthorizationCode(
        authorizationSessionId,
        challenge.userId,
    );

    stage("exchanging authorization code");
    const tokenResponse = await app.request("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: registration.client_id,
            code: code.code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
        }).toString(),
    });
    if (tokenResponse.status !== 200) {
        throw new Error(
            `Authorization-code exchange failed: ${tokenResponse.status}`,
        );
    }
    const tokens = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
    };
    if ((await resolveAccessToken(tokens.access_token)).status !== "valid") {
        throw new Error("HTTP-issued access token was invalid");
    }

    stage("rotating active refresh token");
    const refreshResponse = await app.request("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: registration.client_id,
            refresh_token: tokens.refresh_token,
        }).toString(),
    });
    if (refreshResponse.status !== 200) {
        throw new Error(
            `OAuth refresh failed without billing state: ${refreshResponse.status}`,
        );
    }
    const rotated = (await refreshResponse.json()) as {
        refresh_token: string;
    };

    if (!rotated.refresh_token) {
        throw new Error("OAuth refresh did not return a rotated refresh token");
    }

    stage("passed");
    succeeded = true;
} catch (error) {
    console.error(error);
} finally {
    clearInterval(heartbeat);
    await Promise.race([closePlatformDatabase(), Bun.sleep(1000)]);
    process.exit(succeeded ? 0 : 1);
}
