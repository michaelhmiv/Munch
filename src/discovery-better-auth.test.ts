import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
    BETTER_AUTH_ISSUER_PATH,
    registerDiscoveryRoutes,
} from "./discovery.js";

const HOST = "munch.example";

function fetchDiscovery(app: Hono, path: string) {
    return app.request(`http://localhost${path}`, {
        headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": HOST,
        },
    });
}

test("serves OAuth and OpenID-compatible metadata at paths derived from the Better Auth issuer", async () => {
    const app = new Hono();
    registerDiscoveryRoutes(app);

    for (const path of [
        `/.well-known/oauth-authorization-server${BETTER_AUTH_ISSUER_PATH}`,
        `${BETTER_AUTH_ISSUER_PATH}/.well-known/oauth-authorization-server`,
        `/.well-known/openid-configuration${BETTER_AUTH_ISSUER_PATH}`,
        `${BETTER_AUTH_ISSUER_PATH}/.well-known/openid-configuration`,
    ]) {
        const response = await fetchDiscovery(app, path);
        expect(response.status, `${path} must not 404`).toBe(200);
        expect(response.headers.get("content-type")).toContain(
            "application/json",
        );
    }
});


test("serves the configured OpenAI domain challenge as raw text", async () => {
    const previous = process.env.OPENAI_APPS_CHALLENGE;
    process.env.OPENAI_APPS_CHALLENGE = "challenge-test-token";

    try {
        const app = new Hono();
        registerDiscoveryRoutes(app);
        const response = await fetchDiscovery(
            app,
            "/.well-known/openai-apps-challenge",
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(await response.text()).toBe("challenge-test-token");
    } finally {
        if (previous === undefined) {
            delete process.env.OPENAI_APPS_CHALLENGE;
        } else {
            process.env.OPENAI_APPS_CHALLENGE = previous;
        }
    }
});
