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

function privateKeyFromEnvironment(value: string): string {
    return value.replace(/\\n/g, "\n").trim();
}

export function googlePlayBillingConfigured(): boolean {
    return Boolean(
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL?.trim() &&
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY?.trim(),
    );
}

export function googlePlayRtdnConfigured(): boolean {
    return Boolean(
        googlePlayBillingConfigured() &&
        process.env.GOOGLE_PLAY_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL?.trim() &&
        process.env.GOOGLE_PLAY_PUBSUB_PUSH_AUDIENCE?.trim(),
    );
}

export function getGooglePlayBillingConfig(): GooglePlayBillingConfig {
    const serviceAccountEmail =
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL?.trim();
    const privateKey = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY;
    if (!serviceAccountEmail || !privateKey?.trim()) {
        throw new Error("google_play_billing_not_configured");
    }
    const serviceAccountPrivateKey = privateKeyFromEnvironment(privateKey);
    if (
        !serviceAccountPrivateKey.includes("BEGIN PRIVATE KEY") &&
        !serviceAccountPrivateKey.includes("BEGIN RSA PRIVATE KEY")
    ) {
        throw new Error("google_play_private_key_invalid");
    }
    return {
        serviceAccountEmail,
        serviceAccountPrivateKey,
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
