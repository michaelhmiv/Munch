import {
    createPublicKey,
    verify as verifySignature,
    type JsonWebKey,
} from "node:crypto";
import type { GooglePlayRtdnConfig } from "./google-play-config.js";

const GOOGLE_OIDC_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ALLOWED_ISSUERS = new Set([
    "accounts.google.com",
    "https://accounts.google.com",
]);
const CLOCK_SKEW_SECONDS = 300;

interface GoogleOidcHeader {
    alg?: string;
    kid?: string;
    typ?: string;
}

export interface GooglePubSubPushClaims {
    iss: string;
    aud: string | string[];
    sub: string;
    email: string;
    email_verified: boolean | string;
    iat: number;
    exp: number;
}

interface JwksResponse {
    keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>;
}

interface CachedJwks {
    keys: NonNullable<JwksResponse["keys"]>;
    expiresAtMs: number;
}

let cachedJwks: CachedJwks | null = null;

function decodeBase64Url(value: string): Buffer {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error("google_pubsub_jwt_encoding_invalid");
    }
    return Buffer.from(value, "base64url");
}

function parseJsonPart<T>(value: string): T {
    try {
        return JSON.parse(decodeBase64Url(value).toString("utf8")) as T;
    } catch {
        throw new Error("google_pubsub_jwt_json_invalid");
    }
}

function cacheMaxAgeMs(headers: Headers): number {
    const cacheControl = headers.get("cache-control") ?? "";
    const match = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
    const seconds = match ? Number(match[1]) : 3600;
    return Math.max(60, Math.min(21600, seconds)) * 1000;
}

async function googleJwks(
    fetchImpl: typeof fetch,
    nowMs: number,
    forceRefresh = false,
): Promise<NonNullable<JwksResponse["keys"]>> {
    if (!forceRefresh && cachedJwks && cachedJwks.expiresAtMs > nowMs) {
        return cachedJwks.keys;
    }
    const response = await fetchImpl(GOOGLE_OIDC_JWKS_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
    });
    const payload = (await response.json().catch(() => ({}))) as JwksResponse;
    if (!response.ok || !Array.isArray(payload.keys) || payload.keys.length === 0) {
        throw new Error("google_pubsub_jwks_unavailable");
    }
    cachedJwks = {
        keys: payload.keys,
        expiresAtMs: nowMs + cacheMaxAgeMs(response.headers),
    };
    return payload.keys;
}

function audienceMatches(aud: string | string[] | undefined, expected: string) {
    if (typeof aud === "string") return aud === expected;
    return Array.isArray(aud) && aud.includes(expected);
}

function emailVerified(value: boolean | string | undefined): boolean {
    return value === true || value === "true";
}

function validateClaims(
    claims: Partial<GooglePubSubPushClaims>,
    config: GooglePlayRtdnConfig,
    nowSeconds: number,
): GooglePubSubPushClaims {
    if (!claims.iss || !ALLOWED_ISSUERS.has(claims.iss)) {
        throw new Error("google_pubsub_jwt_issuer_invalid");
    }
    if (!audienceMatches(claims.aud, config.pushAudience)) {
        throw new Error("google_pubsub_jwt_audience_invalid");
    }
    if (
        claims.email !== config.pushServiceAccountEmail ||
        !emailVerified(claims.email_verified)
    ) {
        throw new Error("google_pubsub_jwt_service_account_invalid");
    }
    if (
        typeof claims.exp !== "number" ||
        claims.exp < nowSeconds - CLOCK_SKEW_SECONDS
    ) {
        throw new Error("google_pubsub_jwt_expired");
    }
    if (
        typeof claims.iat !== "number" ||
        claims.iat > nowSeconds + CLOCK_SKEW_SECONDS
    ) {
        throw new Error("google_pubsub_jwt_issued_at_invalid");
    }
    if (typeof claims.sub !== "string" || !claims.sub) {
        throw new Error("google_pubsub_jwt_subject_invalid");
    }
    return claims as GooglePubSubPushClaims;
}

export async function verifyGooglePubSubPushAuthorization(input: {
    authorization: string | undefined;
    config: GooglePlayRtdnConfig;
    fetchImpl?: typeof fetch;
    now?: Date;
}): Promise<GooglePubSubPushClaims> {
    const match = input.authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) throw new Error("google_pubsub_authorization_required");
    const token = match[1];
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("google_pubsub_jwt_invalid");
    const [headerPart, claimsPart, signaturePart] = parts;
    const header = parseJsonPart<GoogleOidcHeader>(headerPart);
    const claims = parseJsonPart<Partial<GooglePubSubPushClaims>>(claimsPart);
    if (header.alg !== "RS256" || !header.kid) {
        throw new Error("google_pubsub_jwt_header_invalid");
    }

    const fetchImpl = input.fetchImpl ?? fetch;
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    let keys = await googleJwks(fetchImpl, nowMs);
    let jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
        keys = await googleJwks(fetchImpl, nowMs, true);
        jwk = keys.find((key) => key.kid === header.kid);
    }
    if (!jwk || (jwk.alg && jwk.alg !== "RS256")) {
        throw new Error("google_pubsub_jwt_key_invalid");
    }

    const signingInput = Buffer.from(`${headerPart}.${claimsPart}`, "utf8");
    const signature = decodeBase64Url(signaturePart);
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    if (!verifySignature("RSA-SHA256", signingInput, publicKey, signature)) {
        throw new Error("google_pubsub_jwt_signature_invalid");
    }

    return validateClaims(claims, input.config, Math.floor(nowMs / 1000));
}

export function clearGooglePubSubJwksCacheForTests(): void {
    cachedJwks = null;
}
