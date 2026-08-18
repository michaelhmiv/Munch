import { afterEach, describe, expect, test } from "bun:test";
import { createOperationsRouter } from "./operations/routes.js";
import {
    openAiAppsChallenge,
    WIDGET_RESOURCE_METADATA,
    widgetToolMeta,
} from "./openai-submission.js";

const originalChallenge = process.env.OPENAI_APPS_CHALLENGE;

afterEach(() => {
    if (originalChallenge === undefined) {
        delete process.env.OPENAI_APPS_CHALLENGE;
    } else {
        process.env.OPENAI_APPS_CHALLENGE = originalChallenge;
    }
});

describe("OpenAI submission support", () => {
    test("normalizes the domain challenge", () => {
        expect(openAiAppsChallenge("  exact-token  ")).toBe("exact-token");
        expect(openAiAppsChallenge("   ")).toBeNull();
        expect(openAiAppsChallenge(undefined)).toBeNull();
    });

    test("serves the exact challenge without caching", async () => {
        process.env.OPENAI_APPS_CHALLENGE = "openai-review-token";
        const response = await createOperationsRouter().request(
            "https://munch.example/.well-known/openai-apps-challenge",
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("openai-review-token");
        expect(response.headers.get("content-type")).toStartWith("text/plain");
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    test("does not expose a placeholder challenge", async () => {
        delete process.env.OPENAI_APPS_CHALLENGE;
        const response = await createOperationsRouter().request(
            "https://munch.example/.well-known/openai-apps-challenge",
        );
        expect(response.status).toBe(404);
    });

    test("uses an exact self-contained widget allowlist", () => {
        expect(WIDGET_RESOURCE_METADATA.ui.domain).toBe(
            "https://munch.business",
        );
        expect(WIDGET_RESOURCE_METADATA.ui.csp.connectDomains).toEqual([]);
        expect(WIDGET_RESOURCE_METADATA.ui.csp.resourceDomains).toEqual([]);
        expect(WIDGET_RESOURCE_METADATA.ui.prefersBorder).toBe(false);
        expect(WIDGET_RESOURCE_METADATA["openai/widgetPrefersBorder"]).toBe(
            false,
        );
        expect(widgetToolMeta("ui://widget/example.html")).toEqual({
            _meta: { ui: { resourceUri: "ui://widget/example.html" } },
        });
    });
});
