import { describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { androidAiTaskCreditsUnavailable } from "./android-ai-credits.js";

function requestContext(surface: "android" | "web"): Context {
    return {
        get: (key: string) =>
            key === "munchAuthTransport"
                ? surface === "android"
                    ? "bearer"
                    : "cookie"
                : undefined,
        json: (body: unknown, status: number) =>
            new Response(JSON.stringify(body), {
                status,
                headers: { "Content-Type": "application/json" },
            }),
    } as unknown as Context;
}

describe("Android AI task credit gate", () => {
    test("blocks Android AI calls while the credit product is unavailable", async () => {
        const response = androidAiTaskCreditsUnavailable(
            requestContext("android"),
        );
        expect(response?.status).toBe(503);
        expect(await response?.json()).toEqual({
            error: "android_ai_credits_unavailable",
            message:
                "Munch AI task credits are not available in Android yet. Continue with saved recipes or manual entry.",
        });
    });

    test("keeps existing website AI access unchanged", () => {
        expect(
            androidAiTaskCreditsUnavailable(requestContext("web")),
        ).toBeNull();
    });
});
