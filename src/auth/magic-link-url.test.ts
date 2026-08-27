import { describe, expect, test } from "bun:test";
import {
    buildInstalledMagicLinkConfirmation,
    buildInstalledMagicLinkDeepLink,
    buildScannerSafeMagicLink,
    mobileMagicLinkRequest,
    safeInstalledMagicLinkReturnPath,
    safeMagicLinkReturnPath,
} from "./magic-link-url.js";

describe("scanner-safe magic links", () => {
    test("preserves a local OAuth continuation without consuming the token", () => {
        const result = new URL(
            buildScannerSafeMagicLink({
                generatedUrl:
                    "https://munch.example/api/auth/magic-link/verify?token=secret-token&callbackURL=%2Foauth%2Fcontinue%3Fsession_id%3Dabc",
                baseUrl: "https://munch.example",
            }),
        );

        expect(result.pathname).toBe("/connect/confirm");
        expect(result.searchParams.get("token")).toBe("secret-token");
        expect(result.searchParams.get("return_to")).toBe(
            "/oauth/continue?session_id=abc",
        );
    });

    test("rejects external and protocol-relative return targets", () => {
        expect(safeMagicLinkReturnPath("https://evil.example/steal")).toBe(
            "/account/portal",
        );
        expect(safeMagicLinkReturnPath("//evil.example/steal")).toBe(
            "/account/portal",
        );
    });

    test("requires the Better Auth token", () => {
        expect(() =>
            buildScannerSafeMagicLink({
                generatedUrl:
                    "https://munch.example/api/auth/magic-link/verify",
                baseUrl: "https://munch.example",
            }),
        ).toThrow("missing token");
    });
});

describe("installed app magic links", () => {
    test("accepts only installed app return routes", () => {
        expect(safeInstalledMagicLinkReturnPath("/app/recipes")).toBe(
            "/app/recipes",
        );
        expect(safeInstalledMagicLinkReturnPath("/account/portal")).toBe(
            "/app",
        );
        expect(
            safeInstalledMagicLinkReturnPath("https://evil.example/app"),
        ).toBe("/app");
    });

    test("recognizes explicit mobile magic-link metadata", () => {
        expect(
            mobileMagicLinkRequest({
                munch_mobile: true,
                return_to: "/app/plan",
            }),
        ).toEqual({ requested: true, returnTo: "/app/plan" });
        expect(mobileMagicLinkRequest({ return_to: "/app/plan" })).toEqual({
            requested: false,
            returnTo: "/app/plan",
        });
    });

    test("builds scanner-safe HTTPS confirmation before the custom-scheme handoff", () => {
        const confirmation = new URL(
            buildInstalledMagicLinkConfirmation({
                token: "abcdefghijklmnopqrstuvwxyz123456",
                baseUrl: "https://munch.example",
                returnTo: "/app/recipes",
            }),
        );
        expect(confirmation.origin).toBe("https://munch.example");
        expect(confirmation.pathname).toBe("/mobile/confirm");
        expect(confirmation.searchParams.get("token")).toBe(
            "abcdefghijklmnopqrstuvwxyz123456",
        );
        expect(confirmation.searchParams.get("return_to")).toBe(
            "/app/recipes",
        );

        const deepLink = new URL(
            buildInstalledMagicLinkDeepLink({
                token: "abcdefghijklmnopqrstuvwxyz123456",
                returnTo: "/app/recipes",
            }),
        );
        expect(deepLink.protocol).toBe("munch:");
        expect(deepLink.hostname).toBe("app");
        expect(deepLink.pathname).toBe("/auth");
        expect(deepLink.searchParams.get("return_to")).toBe("/app/recipes");
    });
});
