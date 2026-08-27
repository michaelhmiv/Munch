import { afterEach, describe, expect, test } from "bun:test";
import {
    betterAuthTrustedOrigins,
    configuredCorsOrigins,
    isAllowedApplicationCorsOrigin,
    MUNCH_ANDROID_WEB_ORIGIN,
    MUNCH_DEEP_LINK_ORIGIN,
    MUNCH_IOS_WEB_ORIGIN,
} from "./origins.js";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
});

describe("installed application origins", () => {
    test("production allows only canonical mobile and configured HTTP origins", () => {
        const configured = configuredCorsOrigins(
            "https://preview.munch.business,not-a-url,ftp://bad.example",
        );
        expect(configured).toEqual(["https://preview.munch.business"]);
        expect(
            isAllowedApplicationCorsOrigin(MUNCH_ANDROID_WEB_ORIGIN, {
                production: true,
                configuredOrigins: configured,
            }),
        ).toBe(true);
        expect(
            isAllowedApplicationCorsOrigin(MUNCH_IOS_WEB_ORIGIN, {
                production: true,
                configuredOrigins: configured,
            }),
        ).toBe(true);
        expect(
            isAllowedApplicationCorsOrigin("https://preview.munch.business", {
                production: true,
                configuredOrigins: configured,
            }),
        ).toBe(true);
        expect(
            isAllowedApplicationCorsOrigin("http://localhost:5173", {
                production: true,
                configuredOrigins: configured,
            }),
        ).toBe(false);
        expect(
            isAllowedApplicationCorsOrigin("https://attacker.example", {
                production: true,
                configuredOrigins: configured,
            }),
        ).toBe(false);
    });

    test("development permits loopback web tooling without widening production", () => {
        expect(
            isAllowedApplicationCorsOrigin("http://localhost:5173", {
                production: false,
                configuredOrigins: [],
            }),
        ).toBe(true);
        expect(
            isAllowedApplicationCorsOrigin("https://127.0.0.1:4173", {
                production: false,
                configuredOrigins: [],
            }),
        ).toBe(true);
    });

    test("Better Auth trusts the API origin, native WebViews, and deep link scheme", () => {
        process.env.NODE_ENV = "production";
        const origins = betterAuthTrustedOrigins("https://munch.business/path");
        expect(origins).toContain("https://munch.business");
        expect(origins).toContain(MUNCH_ANDROID_WEB_ORIGIN);
        expect(origins).toContain(MUNCH_IOS_WEB_ORIGIN);
        expect(origins).toContain(MUNCH_DEEP_LINK_ORIGIN);
        expect(origins.some((origin) => origin.includes("localhost:*"))).toBe(
            false,
        );
    });
});
