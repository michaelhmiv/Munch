import { describe, expect, test } from "bun:test";
import {
    installedAppRoute,
    installedLoginHref,
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

    test("maps only Munch app deep links", () => {
        expect(installedRouteFromUrl("munch://app")).toBe("/app");
        expect(installedRouteFromUrl("munch://app/recipes")).toBe(
            "/app/recipes",
        );
        expect(installedRouteFromUrl("munch://app/plan?date=tomorrow")).toBe(
            "/app/plan",
        );
        expect(installedRouteFromUrl("munch://application")).toBeNull();
        expect(installedRouteFromUrl("https://munch.business/app")).toBeNull();
        expect(installedRouteFromUrl("garbage")).toBeNull();
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
