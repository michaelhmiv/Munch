import { createSign } from "node:crypto";
import {
    getGooglePlayBillingConfig,
    type GooglePlayBillingConfig,
} from "./google-play-config.js";

const ANDROID_PUBLISHER_SCOPE =
    "https://www.googleapis.com/auth/androidpublisher";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANDROID_PUBLISHER_BASE_URL =
    "https://androidpublisher.googleapis.com/androidpublisher/v3";

export interface GooglePlaySubscriptionLineItem {
    productId?: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    offerDetails?: {
        basePlanId?: string;
        offerId?: string;
        offerTags?: string[];
    };
}

export interface GooglePlaySubscriptionPurchaseV2 {
    startTime?: string;
    subscriptionState?: string;
    linkedPurchaseToken?: string;
    testPurchase?: Record<string, never>;
    acknowledgementState?: string;
    externalAccountIdentifiers?: {
        externalAccountId?: string;
        obfuscatedExternalAccountId?: string;
        obfuscatedExternalProfileId?: string;
    };
    lineItems?: GooglePlaySubscriptionLineItem[];
}

interface AccessTokenResponse {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
    error?: string;
    error_description?: string;
}

interface CachedAccessToken {
    email: string;
    token: string;
    expiresAtMs: number;
}

let cachedAccessToken: CachedAccessToken | null = null;

export class GooglePlayApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
    ) {
        super(code);
        this.name = "GooglePlayApiError";
    }
}

function base64Url(value: string | Buffer): string {
    return Buffer.from(value)
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

export function createGoogleServiceAccountAssertion(
    config: GooglePlayBillingConfig,
    now = new Date(),
): string {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(
        JSON.stringify({
            iss: config.serviceAccountEmail,
            scope: ANDROID_PUBLISHER_SCOPE,
            aud: OAUTH_TOKEN_URL,
            iat: issuedAt,
            exp: issuedAt + 3600,
        }),
    );
    const signingInput = `${header}.${claims}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(config.serviceAccountPrivateKey);
    return `${signingInput}.${base64Url(signature)}`;
}

async function googleAccessToken(
    config: GooglePlayBillingConfig,
    fetchImpl: typeof fetch,
    now = new Date(),
): Promise<string> {
    const nowMs = now.getTime();
    if (
        cachedAccessToken?.email === config.serviceAccountEmail &&
        cachedAccessToken.expiresAtMs - nowMs > 60_000
    ) {
        return cachedAccessToken.token;
    }

    const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: createGoogleServiceAccountAssertion(config, now),
    });
    const response = await fetchImpl(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });
    const payload = (await response.json().catch(() => ({}))) as AccessTokenResponse;
    if (!response.ok || !payload.access_token) {
        throw new GooglePlayApiError(
            response.status,
            payload.error || "google_play_oauth_failed",
        );
    }
    const expiresIn = Math.max(60, Number(payload.expires_in ?? 3600));
    cachedAccessToken = {
        email: config.serviceAccountEmail,
        token: payload.access_token,
        expiresAtMs: nowMs + expiresIn * 1000,
    };
    return payload.access_token;
}

async function authorizedGoogleRequest(
    url: string,
    init: RequestInit,
    fetchImpl: typeof fetch,
): Promise<Response> {
    const config = getGooglePlayBillingConfig();
    const token = await googleAccessToken(config, fetchImpl);
    return fetchImpl(url, {
        ...init,
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
        },
    });
}

export async function getGooglePlaySubscription(
    purchaseToken: string,
    fetchImpl: typeof fetch = fetch,
): Promise<GooglePlaySubscriptionPurchaseV2> {
    const config = getGooglePlayBillingConfig();
    const url =
        `${ANDROID_PUBLISHER_BASE_URL}/applications/` +
        `${encodeURIComponent(config.packageName)}/purchases/subscriptionsv2/tokens/` +
        encodeURIComponent(purchaseToken);
    const response = await authorizedGoogleRequest(url, { method: "GET" }, fetchImpl);
    const payload = (await response.json().catch(() => ({}))) as
        | GooglePlaySubscriptionPurchaseV2
        | { error?: { status?: string; message?: string } };
    if (!response.ok) {
        const error = "error" in payload ? payload.error : undefined;
        throw new GooglePlayApiError(
            response.status,
            error?.status || "google_play_subscription_lookup_failed",
        );
    }
    return payload as GooglePlaySubscriptionPurchaseV2;
}

export async function acknowledgeGooglePlaySubscription(
    purchaseToken: string,
    fetchImpl: typeof fetch = fetch,
): Promise<void> {
    const config = getGooglePlayBillingConfig();
    const url =
        `${ANDROID_PUBLISHER_BASE_URL}/applications/` +
        `${encodeURIComponent(config.packageName)}/purchases/subscriptions/` +
        `${encodeURIComponent(config.premiumProductId)}/tokens/` +
        `${encodeURIComponent(purchaseToken)}:acknowledge`;
    const response = await authorizedGoogleRequest(
        url,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        },
        fetchImpl,
    );
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
            error?: { status?: string };
        };
        throw new GooglePlayApiError(
            response.status,
            payload.error?.status || "google_play_acknowledgement_failed",
        );
    }
}

export function clearGooglePlayAccessTokenCacheForTests(): void {
    cachedAccessToken = null;
}
