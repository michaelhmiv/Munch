import { PRODUCT_CONFIG } from "../product-config.js";

export interface GooglePlayBillingConfig {
    serviceAccountEmail: string;
    serviceAccountPrivateKey: string;
    packageName: string;
    premiumProductId: string;
    premiumBasePlanId: string;
}

export interface GooglePlayRtdnConfig {
    pushServiceAccountEmail: string;
    pushAudience: string;
}

interface GoogleServiceAccountJson {
    client_email?: unknown;
    private_key?: unknown;
}

function privateKeyFromEnvironment(value: string): string {
    return value.replace(/\\n/g, "\n").trim();
}

function parsedServiceAccountJson(): {
    email: string;
    privateKey: string;
} | null {
    const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();
    if (!raw) return null;
    try {
        const payload = JSON.parse(raw) as GoogleServiceAccountJson;
        const email =
            typeof payload.client_email === "string"
                ? payload.client_email.trim()
                : "";
        const privateKey =
            typeof payload.private_key === "string"
                ? privateKeyFromEnvironment(payload.private_key)
                : "";
        if (!email || !privateKey) return null;
        return { email, privateKey };
    } catch {
        return null;
    }
}

function serviceAccountCredentials(): {
    email: string;
    privateKey: string;
} | null {
    const jsonCredentials = parsedServiceAccountJson();
    if (jsonCredentials) return jsonCredentials;

    const email = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL?.trim();
    const privateKey = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY;
    if (!email || !privateKey?.trim()) return null;
    return {
        email,
        privateKey: privateKeyFromEnvironment(privateKey),
    };
}

export function googlePlayBillingConfigured(): boolean {
    return Boolean(serviceAccountCredentials());
}

export function googlePlayRtdnConfigured(): boolean {
    return Boolean(
        googlePlayBillingConfigured() &&
        process.env.GOOGLE_PLAY_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL?.trim() &&
        process.env.GOOGLE_PLAY_PUBSUB_PUSH_AUDIENCE?.trim(),
    );
}

export function getGooglePlayBillingConfig(): GooglePlayBillingConfig {
    const credentials = serviceAccountCredentials();
    if (!credentials) {
        throw new Error("google_play_billing_not_configured");
    }
    if (
        !credentials.privateKey.includes("BEGIN PRIVATE KEY") &&
        !credentials.privateKey.includes("BEGIN RSA PRIVATE KEY")
    ) {
        throw new Error("google_play_private_key_invalid");
    }
    return {
        serviceAccountEmail: credentials.email,
        serviceAccountPrivateKey: credentials.privateKey,
        packageName: PRODUCT_CONFIG.googlePlayPackageName,
        premiumProductId: PRODUCT_CONFIG.googlePlayPremiumProductId,
        premiumBasePlanId: PRODUCT_CONFIG.googlePlayPremiumBasePlanId,
    };
}

export function getGooglePlayRtdnConfig(): GooglePlayRtdnConfig {
    const pushServiceAccountEmail =
        process.env.GOOGLE_PLAY_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL?.trim();
    const pushAudience = process.env.GOOGLE_PLAY_PUBSUB_PUSH_AUDIENCE?.trim();
    if (!pushServiceAccountEmail || !pushAudience) {
        throw new Error("google_play_rtdn_not_configured");
    }
    if (!pushServiceAccountEmail.includes("@")) {
        throw new Error("google_play_rtdn_service_account_invalid");
    }
    let audienceUrl: URL;
    try {
        audienceUrl = new URL(pushAudience);
    } catch {
        throw new Error("google_play_rtdn_audience_invalid");
    }
    if (audienceUrl.protocol !== "https:") {
        throw new Error("google_play_rtdn_audience_invalid");
    }
    return { pushServiceAccountEmail, pushAudience };
}
