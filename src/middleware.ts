import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { Context, Next } from "hono";
import { getMunchBetterAuth } from "./auth/auth.js";
import { getBetterAuthRuntimeConfig } from "./auth/config.js";
import { munchMcpResourceUrl } from "./auth/oauth-scopes.js";
import { oauthIssuerUrl, resourceMetadataUrl } from "./discovery.js";
import { maskIp } from "./net.js";
import {
    checkAuthRateLimit,
    checkRateLimit,
    clearAuthFailures,
    getBanState,
    noteAuthFailure,
} from "./rate-limit.js";

declare module "hono" {
    interface ContextVariableMap {
        userId: string;
        accessToken: string;
        suppressAccessLog: boolean;
    }
}

type BetterAuthResourceActions = ReturnType<
    ReturnType<typeof oauthProviderResourceClient>["getActions"]
>;

let betterAuthResourceActions: BetterAuthResourceActions | undefined;

function getBetterAuthResourceActions(): BetterAuthResourceActions {
    betterAuthResourceActions ??=
        oauthProviderResourceClient(getMunchBetterAuth()).getActions();
    return betterAuthResourceActions;
}

async function verifyBetterAuthMcpToken(token: string): Promise<string> {
    const config = getBetterAuthRuntimeConfig();
    const payload = await getBetterAuthResourceActions().verifyAccessToken(
        token,
        {
            verifyOptions: {
                audience: munchMcpResourceUrl(config.baseUrl),
                issuer: oauthIssuerUrl(config.baseUrl),
            },
            scopes: ["nutrition.read"],
            jwksUrl: `${config.baseUrl}/api/auth/jwks`,
        },
    );

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("Better Auth access token has no subject");
    }
    return payload.sub;
}

function getClientIp(c: Context): string {
    const forwardedFor = c.req.header("x-forwarded-for");
    if (forwardedFor) {
        const first = forwardedFor.split(",")[0]?.trim();
        if (first) return first;
    }
    return c.req.header("x-real-ip")?.trim() || "unknown";
}

function getBaseUrl(c: Context): string {
    const proto = c.req.header("x-forwarded-proto") || "http";
    const host = c.req.header("x-forwarded-host") || c.req.header("host");
    if (host) return `${proto}://${host}`;
    return new URL(c.req.url).origin;
}

function rejectUnauthenticated(
    c: Context,
    error: "unauthorized" | "invalid_token",
    description: string,
) {
    const ip = getClientIp(c);
    const ban = noteAuthFailure(ip);
    if (ban.banned) {
        console.log(
            `[ban] ${maskIp(c.req.header("x-forwarded-for"))} repeated auth failures on ${c.req.path} — shedding for ${ban.retryAfterSeconds}s`,
        );
    }

    c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${resourceMetadataUrl(getBaseUrl(c))}"`,
    );
    return c.json({ error, error_description: description }, 401);
}

export const authenticateBearer = async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return rejectUnauthenticated(
            c,
            "unauthorized",
            "Bearer token required",
        );
    }

    const token = authHeader.substring(7);
    let userId: string;
    try {
        userId = await verifyBetterAuthMcpToken(token);
    } catch (error) {
        console.warn("Better Auth MCP bearer verification failed", {
            errorName: error instanceof Error ? error.name : "unknown",
        });
        return rejectUnauthenticated(
            c,
            "invalid_token",
            "Token is invalid, expired, missing required scope, or not issued for this MCP resource",
        );
    }

    clearAuthFailures(getClientIp(c));
    c.set("accessToken", token);
    c.set("userId", userId);
    await next();
};

export const banRepeatAuthFailures = async (c: Context, next: Next) => {
    const ban = getBanState(getClientIp(c));
    if (ban.banned) {
        c.set("suppressAccessLog", true);
        c.header("Retry-After", String(ban.retryAfterSeconds ?? 60));
        return c.json(
            {
                error: "rate_limited",
                error_description: `Too many failed authentication attempts. Retry after ${ban.retryAfterSeconds}s.`,
            },
            429,
        );
    }
    await next();
};

export const rateLimitAuth = async (c: Context, next: Next) => {
    const result = checkAuthRateLimit(getClientIp(c));
    c.header("X-RateLimit-Limit", String(result.limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
        c.header("Retry-After", String(result.retryAfterSeconds ?? 60));
        return c.json(
            {
                error: "rate_limited",
                error_description: `Rate limit exceeded (${result.limit} requests per minute). Retry after ${result.retryAfterSeconds}s.`,
            },
            429,
        );
    }
    await next();
};

export const rateLimit = async (c: Context, next: Next) => {
    const userId = c.get("userId") as string | undefined;
    if (!userId) {
        await next();
        return;
    }
    const result = checkRateLimit(userId);
    c.header("X-RateLimit-Limit", String(result.limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
        c.header("Retry-After", String(result.retryAfterSeconds ?? 60));
        return c.json(
            {
                error: "rate_limited",
                error_description: `Rate limit exceeded (${result.limit} requests per minute). Retry after ${result.retryAfterSeconds}s.`,
            },
            429,
        );
    }
    await next();
};
