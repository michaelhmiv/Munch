import { createHash } from "node:crypto";
import type { SubscriptionStatus } from "./entitlements.js";
import {
    acknowledgeGooglePlaySubscription,
    getGooglePlaySubscription,
    type GooglePlaySubscriptionLineItem,
    type GooglePlaySubscriptionPurchaseV2,
} from "./google-play-client.js";
import { getGooglePlayBillingConfig } from "./google-play-config.js";
import {
    findStoreSubscriptionOwner,
    upsertStoreSubscription,
} from "./store-repository.js";

export interface NormalizedGooglePlaySubscription {
    status: SubscriptionStatus;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    graceExpiresAt: Date | null;
    canceledAt: Date | null;
    providerState: string;
    acknowledged: boolean;
    latestOrderId: string | null;
    linkedPurchaseToken: string | null;
    testPurchase: boolean;
}

export interface VerifiedGooglePlaySubscription
    extends NormalizedGooglePlaySubscription {
    provider: "google_play";
    productId: string;
}

export class GooglePlayVerificationError extends Error {
    constructor(public readonly code: string) {
        super(code);
        this.name = "GooglePlayVerificationError";
    }
}

export function googlePlayObfuscatedAccountId(userId: string): string {
    return createHash("sha256")
        .update(`munch-google-play:${userId}`, "utf8")
        .digest("hex");
}

function parsedDate(value: string | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function latestExpiry(items: GooglePlaySubscriptionLineItem[]): Date | null {
    let latest: Date | null = null;
    for (const item of items) {
        const expiry = parsedDate(item.expiryTime);
        if (expiry && (!latest || expiry.getTime() > latest.getTime())) {
            latest = expiry;
        }
    }
    return latest;
}

function latestOrderId(items: GooglePlaySubscriptionLineItem[]): string | null {
    const ordered = items
        .map((item) => ({
            orderId: item.latestSuccessfulOrderId?.trim() || null,
            expiry: parsedDate(item.expiryTime)?.getTime() ?? 0,
        }))
        .filter((item): item is { orderId: string; expiry: number } =>
            Boolean(item.orderId),
        )
        .sort((left, right) => right.expiry - left.expiry);
    return ordered[0]?.orderId ?? null;
}

function cancellationTime(
    purchase: GooglePlaySubscriptionPurchaseV2,
): Date | null {
    const context = purchase as GooglePlaySubscriptionPurchaseV2 & {
        canceledStateContext?: {
            userInitiatedCancellation?: { cancelTime?: string };
        };
    };
    return parsedDate(
        context.canceledStateContext?.userInitiatedCancellation?.cancelTime,
    );
}

export function normalizeGooglePlaySubscription(
    purchase: GooglePlaySubscriptionPurchaseV2,
    expectedProductId: string,
    expectedBasePlanId: string,
    now = new Date(),
): NormalizedGooglePlaySubscription {
    const productItems = (purchase.lineItems ?? []).filter(
        (item) => item.productId === expectedProductId,
    );
    if (productItems.length === 0) {
        throw new GooglePlayVerificationError("google_play_product_mismatch");
    }
    if (
        productItems.some(
            (item) =>
                item.offerDetails?.basePlanId &&
                item.offerDetails.basePlanId !== expectedBasePlanId,
        )
    ) {
        throw new GooglePlayVerificationError("google_play_base_plan_mismatch");
    }

    const currentPeriodEnd = latestExpiry(productItems);
    const rawState = purchase.subscriptionState ?? "SUBSCRIPTION_STATE_UNSPECIFIED";
    let status: SubscriptionStatus;
    let graceExpiresAt: Date | null = null;

    switch (rawState) {
        case "SUBSCRIPTION_STATE_ACTIVE":
            status = "active";
            break;
        case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
            status = "past_due";
            graceExpiresAt = currentPeriodEnd;
            break;
        case "SUBSCRIPTION_STATE_CANCELED":
            status =
                currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime()
                    ? "active"
                    : "canceled";
            break;
        case "SUBSCRIPTION_STATE_ON_HOLD":
            status = "unpaid";
            break;
        case "SUBSCRIPTION_STATE_PAUSED":
            status = "paused";
            break;
        case "SUBSCRIPTION_STATE_EXPIRED":
            status = "canceled";
            break;
        case "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":
            status = "incomplete_expired";
            break;
        case "SUBSCRIPTION_STATE_PENDING":
        case "SUBSCRIPTION_STATE_UNSPECIFIED":
        default:
            status = "incomplete";
            break;
    }

    return {
        status,
        currentPeriodStart: parsedDate(purchase.startTime),
        currentPeriodEnd,
        graceExpiresAt,
        canceledAt: cancellationTime(purchase),
        providerState: rawState,
        acknowledged:
            purchase.acknowledgementState ===
            "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
        latestOrderId: latestOrderId(productItems),
        linkedPurchaseToken: purchase.linkedPurchaseToken?.trim() || null,
        testPurchase: Boolean(purchase.testPurchase),
    };
}

function shouldAcknowledge(
    normalized: NormalizedGooglePlaySubscription,
    now: Date,
): boolean {
    if (normalized.acknowledged) return false;
    if (normalized.status === "active") {
        return Boolean(
            !normalized.currentPeriodEnd ||
            normalized.currentPeriodEnd.getTime() > now.getTime(),
        );
    }
    return normalized.status === "past_due";
}

export async function verifyGooglePlayPremium(input: {
    userId: string;
    purchaseToken: string;
    now?: Date;
    fetchImpl?: typeof fetch;
}): Promise<VerifiedGooglePlaySubscription> {
    const config = getGooglePlayBillingConfig();
    const purchaseToken = input.purchaseToken.trim();
    if (purchaseToken.length < 8 || purchaseToken.length > 4096) {
        throw new GooglePlayVerificationError("google_play_purchase_token_invalid");
    }

    const existingOwner = await findStoreSubscriptionOwner({
        provider: "google_play",
        appId: config.packageName,
        purchaseToken,
    });
    if (existingOwner && existingOwner !== input.userId) {
        throw new GooglePlayVerificationError("google_play_purchase_already_claimed");
    }

    const fetchImpl = input.fetchImpl ?? fetch;
    const now = input.now ?? new Date();
    const purchase = await getGooglePlaySubscription(purchaseToken, fetchImpl);
    const accountId =
        purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    const expectedAccountId = googlePlayObfuscatedAccountId(input.userId);
    if (!accountId || accountId !== expectedAccountId) {
        throw new GooglePlayVerificationError("google_play_account_mismatch");
    }

    let normalized = normalizeGooglePlaySubscription(
        purchase,
        config.premiumProductId,
        config.premiumBasePlanId,
        now,
    );
    if (shouldAcknowledge(normalized, now)) {
        await acknowledgeGooglePlaySubscription(purchaseToken, fetchImpl);
        normalized = { ...normalized, acknowledged: true };
    }

    await upsertStoreSubscription({
        userId: input.userId,
        provider: "google_play",
        appId: config.packageName,
        productId: config.premiumProductId,
        purchaseToken,
        obfuscatedAccountId: expectedAccountId,
        status: normalized.status,
        currentPeriodStart: normalized.currentPeriodStart,
        currentPeriodEnd: normalized.currentPeriodEnd,
        graceExpiresAt: normalized.graceExpiresAt,
        canceledAt: normalized.canceledAt,
        providerState: normalized.providerState,
        acknowledged: normalized.acknowledged,
        latestOrderId: normalized.latestOrderId,
        linkedPurchaseToken: normalized.linkedPurchaseToken,
        testPurchase: normalized.testPurchase,
        verifiedAt: now,
    });

    return {
        provider: "google_play",
        productId: config.premiumProductId,
        ...normalized,
    };
}
