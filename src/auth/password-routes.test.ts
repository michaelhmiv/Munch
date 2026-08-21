import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createPasswordRouter } from "./password-routes.js";

const original = { ...process.env };

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
});

function app() {
    const value = new Hono();
    value.route("/", createPasswordRouter());
    return value;
}

function configure() {
    Object.assign(process.env, {
        MUNCH_APP_BASE_URL: "https://munch.example",
        BETTER_AUTH_SECRET: "12345678901234567890123456789012",
        DATABASE_URL: "postgresql://example",
    });
}

describe("password authentication pages", () => {
    test("keeps public password signup behind the explicit feature flag", async () => {
        configure();
        const response = await app().request(
            "https://munch.example/account/password",
        );
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(html).not.toContain('id="password-sign-up"');
        expect(html).toContain("controlled provisioning flow");
    });

    test("renders username signup and preserves OAuth continuation state when enabled", async () => {
        configure();
        process.env.MUNCH_PUBLIC_PASSWORD_SIGNUP = "true";
        const response = await app().request(
            "https://munch.example/account/password?return_to=/app&oauth_query=client_id%3Dclient-1%26scope%3Dnutrition.read",
        );
        const html = await response.text();
        expect(html).toContain('id="password-sign-up"');
        expect(html).toContain('name="username"');
        expect(html).toContain("client_id=client-1");
        expect(html).toContain("/api/auth/sign-in/username");
    });

    test("renders the reset request page without exposing secrets", async () => {
        configure();
        const response = await app().request(
            "https://munch.example/account/password/reset",
        );
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(html).toContain('id="password-reset-request"');
        expect(html).not.toContain("DATABASE_URL");
    });
});
