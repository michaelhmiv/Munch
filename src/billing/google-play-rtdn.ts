import { getGooglePlaySubscription } from "./google-play-client.js";
import { getGooglePlayBillingConfig } from "./google-play-config.js";
import {
    GooglePlayVerificationError,
    persistGooglePlayPremiumForUser,
    resolveGooglePlayPurchaseUser,
} from "./google-play.js";
import {
    markStoreBillingEventProcessed,
    recordStoreBillingEvent,
} from "./store-repository.js";

interface PubSubPushEnvelope {
    message?: {
        data?: string;
        messageId?: string;
        publishTime?: string;
        attributes?: Record<string, string>;
    };
    subscription?: string;
}

interface GooglePlayRtdnPayload {
    version?: string;
    packageName?: string;
    eventTimeMillis?: string;
    subscriptionNotification?: {
        version?: string;
        notificationType?: number;
        purchaseToken?: string;
    };
    voidedPurchaseNotification?: {
        purchaseToken?: string;
        orderId?: string;
        productType?: number;
        refundType?: number;
    };
    testNotification?: { version?: string };
    oneTimeProductNotification?: unknown;
    pendingRefundReviewNotification?: unknown;
}

export interface ParsedGooglePlayRtdn {
    messageId: string;
    eventType: string;
    payload: GooglePlayRtdnPayload;
    purchaseToken: string | null;
    actionableSubscription: boolean;
}

export class GooglePlayRtdnError extends Error {
    constructor(public readonly code: string) {
        super(code);
        this.name = "GooglePlayRtdnError";
    }
}

function decodePubSubData(value: string): string {
    if (!/^[A-Za-z0-9+/=_-]+$/.test(value) || value.length > 1_000_000) {
        throw new GooglePlayRtdnError("google_play_rtdn_data_invalid");
    }
    try {
        return Buffer.from(value, "base64").toString("utf8");
    } catch {
        throw new GooglePlayRtdnError("google_play_rtdn_data_invalid");
    }
}

export function parseGooglePlayRtdn(rawPayload: string): ParsedGooglePlayRtdn {
    let envelope: PubSubPushEnvelope;
    try {
        envelope = JSON.parse(rawPayload) as PubSubPushEnvelope;
    } catch {
        throw new GooglePlayRtdnError("google_play_rtdn_envelope_invalid");
    }
    const messageId = envelope.message?.messageId?.trim() ?? "";
    const encodedData = envelope.message?.data?.trim() ?? "";
    if (!messageId || messageId.length > 512 || !encodedData) {
        throw new GooglePlayRtdnError("google_play_rtdn_envelope_invalid");
    }

    let payload: GooglePlayRtdnPayload;
    try {
        payload = JSON.parse(
            decodePubSubData(encodedData),
        ) as GooglePlayRtdnPayload;
    } catch (error) {
        if (error instanceof GooglePlayRtdnError) throw error;
        throw new GooglePlayRtdnError("google_play_rtdn_payload_invalid");
    }

    if (payload.testNotification) {
        return {
            messageId,
            eventType: "test",
            payload,
            purchaseToken: null,
            actionableSubscription: false,
        };
    }
    const subscription = payload.subscriptionNotification;
    if (subscription) {
        const purchaseToken = subscription.purchaseToken?.trim() ?? "";
        if (!purchaseToken) {
            throw new GooglePlayRtdnError(
                "google_play_rtdn_purchase_token_missing",
            );
        }
        return {
            messageId,
            eventType: `subscription:${Number(subscription.notificationType ?? 0)}`,
            payload,
            purchaseToken,
            actionableSubscription: true,
        };
    }
    const voided = payload.voidedPurchaseNotification;
    if (voided?.productType === 1) {
        const purchaseToken = voided.purchaseToken?.trim() ?? "";
        if (!purchaseToken) {
            throw new GooglePlayRtdnError(
                "google_play_rtdn_purchase_token_missing",
            );
        }
        return {
            messageId,
            eventType: `voided_subscription:${Number(voided.refundType ?? 0)}`,
            payload,
            purchaseToken,
            actionableSubscription: true,
        };
    }
    return {
        messageId,
        eventType: "ignored_non_subscription",
        payload,
        purchaseToken: null,
        actionableSubscription: false,
    };
}

function processingErrorCode(error: unknown): string {
    if (error instanceof GooglePlayRtdnError) return error.code;
    if (error instanceof GooglePlayVerificationError) return error.code;
    if (error instanceof Error) {
        return error.name
            .replace(/[^a-z0-9_-]/gi, "_")
            .toLowerCase()
            .slice(0, 120);
    }
    return "unknown_error";
}

export async function processGooglePlayRtdn(input: {
    rawPayload: string;
    fetchImpl?: typeof fetch;
}) {
    const parsed = parseGooglePlayRtdn(input.rawPayload);
    const config = getGooglePlayBillingConfig();
    if (parsed.payload.packageName !== config.packageName) {
        throw new GooglePlayRtdnError("google_play_rtdn_package_mismatch");
    }

    const shouldProcess = await recordStoreBillingEvent({
        provider: "google_play",
        eventId: parsed.messageId,
        eventType: parsed.eventType,
        rawPayload: input.rawPayload,
    });
    if (!shouldProcess) {
        return { duplicate: true, eventType: parsed.eventType };
    }

    if (!parsed.actionableSubscription || !parsed.purchaseToken) {
        await markStoreBillingEventProcessed({
            provider: "google_play",
            eventId: parsed.messageId,
        });
        return { duplicate: false, eventType: parsed.eventType, ignored: true };
    }

    try {
        const fetchImpl = input.fetchImpl ?? fetch;
        const purchase = await getGooglePlaySubscription(
            parsed.purchaseToken,
            fetchImpl,
        );
        const userId = await resolveGooglePlayPurchaseUser({
            purchaseToken: parsed.purchaseToken,
            purchase,
            packageName: config.packageName,
        });
        if (!userId) {
            throw new GooglePlayRtdnError("google_play_rtdn_owner_unresolved");
        }
        const verified = await persistGooglePlayPremiumForUser({
            userId,
            purchaseToken: parsed.purchaseToken,
            purchase,
            fetchImpl,
        });
        await markStoreBillingEventProcessed({
            provider: "google_play",
            eventId: parsed.messageId,
        });
        return {
            duplicate: false,
            eventType: parsed.eventType,
            userId,
            status: verified.status,
        };
    } catch (error) {
        await markStoreBillingEventProcessed({
            provider: "google_play",
            eventId: parsed.messageId,
            errorCode: processingErrorCode(error),
        });
        throw error;
    }
}
