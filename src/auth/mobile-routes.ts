import { Hono, type Context } from "hono";
import {
    createMobileSignInHandoff,
    exchangeMobileSignInHandoff,
    getMunchBetterAuth,
} from "./auth.js";
import { getBetterAuthRuntimeConfig } from "./config.js";

function privateResponse(c: Context) {
    c.header("Cache-Control", "no-store, private");
    c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
}

function isMobileState(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function isCodeChallenge(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function createMobileAuthRouter(): Hono {
    const router = new Hono();

    router.get("/.well-known/assetlinks.json", (c) => {
        const fingerprints = (
            process.env.MUNCH_ANDROID_APP_LINK_SHA256_FINGERPRINTS || ""
        )
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        if (
            fingerprints.length === 0 ||
            fingerprints.some(
                (value) =>
                    !/^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(value),
            )
        ) {
            return c.notFound();
        }

        return c.json(
            [
                {
                    relation: ["delegate_permission/common.handle_all_urls"],
                    target: {
                        namespace: "android_app",
                        package_name: "business.munch.app",
                        sha256_cert_fingerprints: fingerprints,
                    },
                },
            ],
            200,
            { "Cache-Control": "public, max-age=300" },
        );
    });

    router.get("/mobile/auth/callback", (c) => {
        privateResponse(c);
        return c.html(`<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <meta name="referrer" content="no-referrer">
        <meta name="robots" content="noindex,nofollow">
        <title>Open Munch</title>
    </head>
    <body>
        <main>
            <h1>Open Munch to finish signing in</h1>
            <p>
                Return to the Munch Android app and request a new sign-in link
                on this device.
            </p>
        </main>
    </body>
</html>`);
    });

    router.get("/mobile/auth/google-config", (c) => {
        const config = getBetterAuthRuntimeConfig();
        const configured = Boolean(
            config.googleWebClientId &&
            config.googleAndroidClientId &&
            config.googleClientSecret,
        );
        privateResponse(c);
        return c.json({
            configured,
            webClientId: configured ? config.googleWebClientId : null,
        });
    });

    router.get("/mobile/auth/handoff/complete", async (c) => {
        const state = c.req.query("state");
        const codeChallenge = c.req.query("code_challenge");
        if (!isMobileState(state) || !isCodeChallenge(codeChallenge)) {
            privateResponse(c);
            return c.redirect("/connect/error", 303);
        }

        try {
            const session = await getMunchBetterAuth().api.getSession({
                headers: c.req.raw.headers,
            });
            const sessionToken = session?.session?.token;
            if (!session?.user || typeof sessionToken !== "string") {
                privateResponse(c);
                return c.redirect("/connect/error", 303);
            }

            const code = await createMobileSignInHandoff({
                sessionToken,
                codeChallenge,
            });
            const callback = new URL(
                "/mobile/auth/callback",
                getBetterAuthRuntimeConfig().baseUrl,
            );
            callback.searchParams.set("code", code);
            callback.searchParams.set("state", state);
            privateResponse(c);
            return c.redirect(callback.toString(), 303);
        } catch (error) {
            console.error("Mobile sign-in handoff creation failed", {
                errorName: error instanceof Error ? error.name : "unknown",
            });
            privateResponse(c);
            return c.redirect("/connect/error", 303);
        }
    });

    router.post("/mobile/auth/handoff/exchange", async (c) => {
        const body = await c.req.json().catch(() => null);
        const code = body && typeof body.code === "string" ? body.code : "";
        const codeVerifier =
            body && typeof body.codeVerifier === "string"
                ? body.codeVerifier
                : "";
        if (code.length > 128 || codeVerifier.length > 128) {
            privateResponse(c);
            return c.json({ error: "mobile_sign_in_failed" }, 400);
        }

        try {
            const token = await exchangeMobileSignInHandoff({
                code,
                codeVerifier,
            });
            privateResponse(c);
            if (!token) return c.json({ error: "mobile_sign_in_failed" }, 401);
            return c.json({ token });
        } catch (error) {
            console.error("Mobile sign-in handoff exchange failed", {
                errorName: error instanceof Error ? error.name : "unknown",
            });
            privateResponse(c);
            return c.json({ error: "mobile_sign_in_unavailable" }, 503);
        }
    });

    return router;
}
