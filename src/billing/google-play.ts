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
    findStoreAccountBindingUser,
    findStoreSubscriptionOwner,
    upsertStoreAccountBinding,
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

export interface VerifiedGooglePlaySubscription extends NormalizedGooglePlaySubscription {
    provider: "google_play";
    productId: string;
}

type GooglePlayPurchaseWithOutOfApp = GooglePlaySubscriptionPurchaseV2 & {
    outOfAppPurchaseContext?: {
        expiredExternalAccountIdentifiers?: {
            externalAccountId?: string;
            obfuscatedExternalAccountId?: string;
            obfuscatedExternalProfileId?: string;
        };
        expiredPurchaseToken?: string;
    };
    canceledStateContext?: {
        userInitiatedCancellation?: { cancelTime?: string };
    };
};

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
    return parsedDate(
        (purchase as GooglePlayPurchaseWithOutOfApp).canceledStateContext
            ?.userInitiatedCancellation?.cancelTime,
    );
}

function accountIdentifiers(
    purchase: GooglePlaySubscriptionPurchaseV2,
): string[] {
    const extended = purchase as GooglePlayPurchaseWithOutOfApp;
    return [
        purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId,
        extended.outOfAppPurchaseContext?.expiredExternalAccountIdentifiers
            ?.obfuscatedExternalAccountId,
    ].filter((value): value is string => Boolean(value?.trim()));
}

function linkedPurchaseTokens(
    purchase: GooglePlaySubscriptionPurchaseV2,
): string[] {
    const extended = purchase as GooglePlayPurchaseWithOutOfApp;
    return [
        purchase.linkedPurchaseToken,
        extended.outOfAppPurchaseContext?.expiredPurchaseToken,
    ].filter((value): value is string => Boolean(value?.trim()));
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
    const rawState =
        purchase.subscriptionState ?? "SUBSCRIPTION_STATE_UNSPECIFIED";
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

async function purchaseBelongsToUser(input: {
    userId: string;
    purchaseToken: string;
    purchase: GooglePlaySubscriptionPurchaseV2;
    packageName: string;
}): Promise<boolean> {
    const expectedAccountId = googlePlayObfuscatedAccountId(input.userId);
    if (accountIdentifiers(input.purchase).includes(expectedAccountId)) {
        return true;
    }
    const owner = await findStoreSubscriptionOwner({
        provider: "google_play",
        appId: input.packageName,
        purchaseToken: input.purchaseToken,
    });
    if (owner === input.userId) return true;
    for (const token of linkedPurchaseTokens(input.purchase)) {
        const linkedOwner = await findStoreSubscriptionOwner({
            provider: "google_play",
            appId: input.packageName,
            purchaseToken: token,
        });
        if (linkedOwner === input.userId) return true;
    }
    return false;
}

export async function resolveGooglePlayPurchaseUser(input: {
    purchaseToken: string;
    purchase: GooglePlaySubscriptionPurchaseV2;
    packageName: string;
}): Promise<string | null> {
    const candidates = new Set<string>();
    const currentOwner = await findStoreSubscriptionOwner({
        provider: "google_play",
        appId: input.packageName,
        purchaseToken: input.purchaseToken,
    });
    if (currentOwner) candidates.add(currentOwner);

    for (const accountId of accountIdentifiers(input.purchase)) {
        const userId = await findStoreAccountBindingUser({
            provider: "google_play",
            appId: input.packageName,
            externalAccountId: accountId,
        });
        if (userId) candidates.add(userId);
    }
    for (const token of linkedPurchaseTokens(input.purchase)) {
        const userId = await findStoreSubscriptionOwner({
            provider: "google_play",
            appId: input.packageName,
            purchaseToken: token,
        });
        if (userId) candidates.add(userId);
    }

    if (candidates.size > 1) {
        throw new GooglePlayVerificationError(
            "google_play_purchase_identity_conflict",
        );
    }
    return candidates.values().next().value ?? null;
}

export async function persistGooglePlayPremiumForUser(input: {
    userId: string;
    purchaseToken: string;
    purchase: GooglePlaySubscriptionPurchaseV2;
    now?: Date;
    fetchImpl?: typeof fetch;
}): Promise<VerifiedGooglePlaySubscription> {
    const config = getGooglePlayBillingConfig();
    const purchaseToken = input.purchaseToken.trim();
    if (purchaseToken.length < 8 || purchaseToken.length > 4096) {
        throw new GooglePlayVerificationError(
            "google_play_purchase_token_invalid",
        );
    }
    if (
        !(await purchaseBelongsToUser({
            userId: input.userId,
            purchaseToken,
            purchase: input.purchase,
            packageName: config.packageName,
        }))
    ) {
        throw new GooglePlayVerificationError("google_play_account_mismatch");
    }

    const fetchImpl = input.fetchImpl ?? fetch;
    const now = input.now ?? new Date();
    let normalized = normalizeGooglePlaySubscription(
        input.purchase,
        config.premiumProductId,
        config.premiumBasePlanId,
        now,
    );
    if (shouldAcknowledge(normalized, now)) {
        await acknowledgeGooglePlaySubscription(purchaseToken, fetchImpl);
        normalized = { ...normalized, acknowledged: true };
    }

    const expectedAccountId = googlePlayObfuscatedAccountId(input.userId);
    const bindingStored = await upsertStoreAccountBinding({
        userId: input.userId,
        provider: "google_play",
        appId: config.packageName,
        externalAccountId: expectedAccountId,
    });
    if (!bindingStored) {
        throw new GooglePlayVerificationError(
            "google_play_account_binding_conflict",
        );
    }

    const storedForUser = await upsertStoreSubscription({
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
    if (!storedForUser) {
        throw new GooglePlayVerificationError(
            "google_play_purchase_already_claimed",
        );
    }

    return {
        provider: "google_play",
        productId: config.premiumProductId,
        ...normalized,
    };
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
        throw new GooglePlayVerificationError(
            "google_play_purchase_token_invalid",
        );
    }

    const existingOwner = await findStoreSubscriptionOwner({
        provider: "google_play",
        appId: config.packageName,
        purchaseToken,
    });
    if (existingOwner && existingOwner !== input.userId) {
        throw new GooglePlayVerificationError(
            "google_play_purchase_already_claimed",
        );
    }

    const fetchImpl = input.fetchImpl ?? fetch;
    const purchase = await getGooglePlaySubscription(purchaseToken, fetchImpl);
    return persistGooglePlayPremiumForUser({
        userId: input.userId,
        purchaseToken,
        purchase,
        now: input.now,
        fetchImpl,
    });
}
