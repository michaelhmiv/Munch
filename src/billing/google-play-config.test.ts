import { afterEach, describe, expect, test } from "bun:test";
import {
    getGooglePlayBillingConfig,
    googlePlayBillingConfigured,
    googlePlayRtdnConfigured,
} from "./google-play-config.js";

const ENV_KEYS = [
    "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
    "GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY",
    "GOOGLE_PLAY_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_PLAY_PUBSUB_PUSH_AUDIENCE",
] as const;

const originalEnvironment = new Map(
    ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

function clearGooglePlayEnvironment() {
    for (const key of ENV_KEYS) delete process.env[key];
}

function restoreGooglePlayEnvironment() {
    for (const key of ENV_KEYS) {
        const value = originalEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

afterEach(() => {
    restoreGooglePlayEnvironment();
});

describe("Google Play billing configuration", () => {
    test("accepts a complete service-account JSON variable", () => {
        clearGooglePlayEnvironment();
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({
            client_email: "munch-play@example.iam.gserviceaccount.com",
            private_key:
                "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n",
        });

        expect(googlePlayBillingConfigured()).toBe(true);
        const config = getGooglePlayBillingConfig();
        expect(config.serviceAccountEmail).toBe(
            "munch-play@example.iam.gserviceaccount.com",
        );
        expect(config.serviceAccountPrivateKey).toContain("BEGIN PRIVATE KEY");
        expect(config.packageName).toBe("business.munch.app");
    });

    test("retains backwards-compatible split credential variables", () => {
        clearGooglePlayEnvironment();
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL =
            "legacy@example.iam.gserviceaccount.com";
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY =
            "-----BEGIN PRIVATE KEY-----\\nlegacy\\n-----END PRIVATE KEY-----";

        expect(googlePlayBillingConfigured()).toBe(true);
        const config = getGooglePlayBillingConfig();
        expect(config.serviceAccountEmail).toBe(
            "legacy@example.iam.gserviceaccount.com",
        );
        expect(config.serviceAccountPrivateKey).toContain("\nlegacy\n");
    });

    test("falls back to split credentials when JSON is malformed", () => {
        clearGooglePlayEnvironment();
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = "{not-json";
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL =
            "fallback@example.iam.gserviceaccount.com";
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY =
            "-----BEGIN PRIVATE KEY-----\\nfallback\\n-----END PRIVATE KEY-----";

        expect(googlePlayBillingConfigured()).toBe(true);
        expect(getGooglePlayBillingConfig().serviceAccountEmail).toBe(
            "fallback@example.iam.gserviceaccount.com",
        );
    });

    test("fails closed when no complete service-account credentials exist", () => {
        clearGooglePlayEnvironment();
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({
            client_email: "missing-key@example.iam.gserviceaccount.com",
        });

        expect(googlePlayBillingConfigured()).toBe(false);
        expect(() => getGooglePlayBillingConfig()).toThrow(
            "google_play_billing_not_configured",
        );
    });

    test("RTDN readiness still requires authenticated push configuration", () => {
        clearGooglePlayEnvironment();
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({
            client_email: "munch-play@example.iam.gserviceaccount.com",
            private_key:
                "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n",
        });
        expect(googlePlayRtdnConfigured()).toBe(false);

        process.env.GOOGLE_PLAY_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL =
            "munch-rtdn@example.iam.gserviceaccount.com";
        process.env.GOOGLE_PLAY_PUBSUB_PUSH_AUDIENCE =
            "https://munch.business/webhooks/google-play";
        expect(googlePlayRtdnConfigured()).toBe(true);
    });
});
