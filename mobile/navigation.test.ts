import { describe, expect, test } from "bun:test";
import {
    installedAppRoute,
    installedLoginHref,
    installedMagicLinkFromUrl,
    installedRouteFromUrl,
} from "./navigation.js";

describe("installed mobile navigation", () => {
    test("accepts only real /app routes", () => {
        expect(installedAppRoute("/app")).toBe("/app");
        expect(installedAppRoute("/app/recipes")).toBe("/app/recipes");
        expect(installedAppRoute(" /app/plan?ignored=1#hash ")).toBe(
            "/app/plan",
        );
        expect(installedAppRoute("/application")).toBeNull();
        expect(installedAppRoute("/app-store")).toBeNull();
        expect(installedAppRoute("https://evil.example/app")).toBeNull();
    });

    test("maps only Munch app navigation deep links", () => {
        expect(installedRouteFromUrl("munch://app")).toBe("/app");
        expect(installedRouteFromUrl("munch://app/recipes")).toBe(
            "/app/recipes",
        );
        expect(installedRouteFromUrl("munch://app/plan?date=tomorrow")).toBe(
            "/app/plan",
        );
        expect(
            installedRouteFromUrl(
                "munch://app/auth?token=abcdefghijklmnopqrstuvwxyz&return_to=%2Fapp%2Fplan",
            ),
        ).toBeNull();
        expect(installedRouteFromUrl("munch://application")).toBeNull();
        expect(installedRouteFromUrl("https://munch.business/app")).toBeNull();
        expect(installedRouteFromUrl("garbage")).toBeNull();
    });

    test("parses one-time installed magic-link handoffs", () => {
        expect(
            installedMagicLinkFromUrl(
                "munch://app/auth?token=abcdefghijklmnopqrstuvwxyz123456&return_to=%2Fapp%2Frecipes",
            ),
        ).toEqual({
            token: "abcdefghijklmnopqrstuvwxyz123456",
            returnTo: "/app/recipes",
        });
        expect(
            installedMagicLinkFromUrl(
                "munch://app/auth?token=abcdefghijklmnopqrstuvwxyz123456&return_to=https%3A%2F%2Fevil.example%2Fapp",
            ),
        ).toEqual({
            token: "abcdefghijklmnopqrstuvwxyz123456",
            returnTo: "/app",
        });
        expect(installedMagicLinkFromUrl("munch://app/auth?token=short")).toBeNull();
        expect(
            installedMagicLinkFromUrl(
                "munch://evil/auth?token=abcdefghijklmnopqrstuvwxyz123456",
            ),
        ).toBeNull();
    });

    test("builds a safe installed login return URL", () => {
        expect(installedLoginHref("/app/recipes")).toBe(
            "/mobile-login.html?return_to=%2Fapp%2Frecipes",
        );
        expect(installedLoginHref("https://evil.example/app")).toBe(
            "/mobile-login.html?return_to=%2Fapp",
        );
    });
});
