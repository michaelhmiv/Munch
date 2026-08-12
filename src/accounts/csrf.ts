import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getBaseUrl } from "../url.js";

function normalizedSingleOrigin(value: string): string | null {
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

function normalizedOrigin(value: string): string | null {
    const candidates = value
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean);
    if (candidates.length === 0) return null;

    const origins = candidates.map(normalizedSingleOrigin);
    const first = origins[0];
    if (!first || origins.some((origin) => origin !== first)) return null;
    return first;
}

function originLogValue(value: string | undefined): string {
    if (!value) return "missing";
    if (value === "null") return "null";
    return normalizedOrigin(value) ?? "malformed";
}

export function requestOriginMatches(
    requestOrigin: string | undefined,
    ...allowedOrigins: string[]
): boolean {
    if (!requestOrigin) return false;

    const normalizedRequestOrigin = normalizedOrigin(requestOrigin);
    if (!normalizedRequestOrigin) return false;

    return allowedOrigins.some(
        (allowedOrigin) =>
            normalizedOrigin(allowedOrigin) === normalizedRequestOrigin,
    );
}

export function requestHasSameOriginEvidence(input: {
    requestOrigin: string | undefined;
    configuredBaseUrl: string;
    requestBaseUrl: string;
    secFetchSite: string | undefined;
}): boolean {
    if (
        requestOriginMatches(
            input.requestOrigin,
            input.configuredBaseUrl,
            input.requestBaseUrl,
        )
    ) {
        return true;
    }

    const requestOriginIsUnavailable =
        !input.requestOrigin || normalizedOrigin(input.requestOrigin) === null;
    return (
        requestOriginIsUnavailable &&
        input.secFetchSite?.toLowerCase() === "same-origin" &&
        requestOriginMatches(input.requestBaseUrl, input.configuredBaseUrl)
    );
}

export async function requireSameOrigin(c: Context, next: Next) {
    const configuredBaseUrl = process.env.MUNCH_APP_BASE_URL?.trim();
    if (!configuredBaseUrl) {
        return c.json({ error: "application_not_configured" }, 503);
    }

    const requestOrigin = c.req.header("origin");
    const secFetchSite = c.req.header("sec-fetch-site");
    const requestBaseUrl = getBaseUrl(c);
    if (
        !requestHasSameOriginEvidence({
            requestOrigin,
            configuredBaseUrl,
            requestBaseUrl,
            secFetchSite,
        })
    ) {
        console.warn("Rejected request with invalid origin", {
            requestOrigin: originLogValue(requestOrigin),
            configuredOrigin: normalizedOrigin(configuredBaseUrl) ?? "invalid",
            requestBaseUrl,
            secFetchSite: secFetchSite ?? "missing",
        });
        return c.json({ error: "invalid_request_origin" }, 403);
    }

    await next();
}

export interface OAuthConsentCsrfInput {
    userId: string;
    clientId: string;
    scope: string;
    oauthQuery: string;
}

const OAUTH_CONSENT_CSRF_TTL_SECONDS = 15 * 60;

function csrfSigningSecret(): string {
    const secret = process.env.BETTER_AUTH_SECRET?.trim();
    if (!secret) throw new Error("BETTER_AUTH_SECRET is required");
    return secret;
}

function encodeCsrfPart(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url");
}

function decodeCsrfPart(value: string): string | null {
    try {
        return Buffer.from(value, "base64url").toString("utf8");
    } catch {
        return null;
    }
}

function signCsrfPayload(payload: string): string {
    return createHmac("sha256", csrfSigningSecret())
        .update(payload, "utf8")
        .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left, "utf8");
    const rightBytes = Buffer.from(right, "utf8");
    return (
        leftBytes.length === rightBytes.length &&
        timingSafeEqual(leftBytes, rightBytes)
    );
}

export function createOAuthConsentCsrfToken(
    input: OAuthConsentCsrfInput,
    now = Date.now(),
): string {
    const expiresAt = Math.floor(now / 1000) + OAUTH_CONSENT_CSRF_TTL_SECONDS;
    const payload = [
        "v1",
        String(expiresAt),
        encodeCsrfPart(input.userId),
        encodeCsrfPart(input.clientId),
        encodeCsrfPart(input.scope),
        encodeCsrfPart(input.oauthQuery),
    ].join(".");
    return `${payload}.${signCsrfPayload(payload)}`;
}

export function verifyOAuthConsentCsrfToken(
    token: string,
    input: OAuthConsentCsrfInput,
    now = Date.now(),
): boolean {
    const parts = token.split(".");
    if (parts.length !== 7 || parts[0] !== "v1") return false;

    const [version, expiry, userId, clientId, scope, oauthQuery, signature] =
        parts;
    const payload = parts.slice(0, -1).join(".");
    if (!safeEqual(signature, signCsrfPayload(payload))) return false;

    const expiresAt = Number(expiry);
    if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(now / 1000)) {
        return false;
    }

    return (
        decodeCsrfPart(userId) === input.userId &&
        decodeCsrfPart(clientId) === input.clientId &&
        decodeCsrfPart(scope) === input.scope &&
        decodeCsrfPart(oauthQuery) === input.oauthQuery
    );
}
