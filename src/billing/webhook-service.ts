import {
    markStripeWebhookProcessed,
    recordStripeWebhookEvent,
    upsertStripeCustomer,
} from "./repository.js";
import type { StripeSubscription } from "./stripe-client.js";
import { persistStripeSubscription } from "./stripe-persistence.js";

interface StripeEventEnvelope {
    id: string;
    type: string;
    livemode: boolean;
    created: number;
    data: {
        object: unknown;
    };
}

interface StripeSubscriptionObject {
    id: string;
    customer: string;
    status: string;
    current_period_start?: number;
    current_period_end?: number;
    trial_end?: number | null;
    cancel_at_period_end?: boolean;
    canceled_at?: number | null;
    metadata?: Record<string, string>;
    items?: {
        data?: Array<{
            id?: string;
            quantity?: number | null;
            price?: {
                id?: string;
            };
        }>;
    };
}

interface StripeCheckoutObject {
    id: string;
    customer?: string | null;
    client_reference_id?: string | null;
    metadata?: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
}

function parseEvent(rawPayload: string): StripeEventEnvelope {
    const parsed = JSON.parse(rawPayload) as unknown;
    const record = asRecord(parsed);
    const data = asRecord(record?.data);
    if (
        !record ||
        typeof record.id !== "string" ||
        typeof record.type !== "string" ||
        typeof record.livemode !== "boolean" ||
        typeof record.created !== "number" ||
        !data ||
        !("object" in data)
    ) {
        throw new Error("invalid_event_envelope");
    }

    return {
        id: record.id,
        type: record.type,
        livemode: record.livemode,
        created: record.created,
        data: { object: data.object },
    };
}

function userIdFromMetadata(
    metadata: Record<string, string> | undefined,
    fallback?: string | null,
): string {
    const value = metadata?.munch_user_id ?? fallback;
    if (
        !value ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value,
        )
    ) {
        throw new Error("missing_user_mapping");
    }
    return value;
}

async function processCheckoutCompleted(value: unknown): Promise<void> {
    const checkout = value as StripeCheckoutObject;
    if (!checkout || typeof checkout.id !== "string") {
        throw new Error("invalid_checkout_object");
    }
    const userId = userIdFromMetadata(
        checkout.metadata,
        checkout.client_reference_id,
    );
    if (typeof checkout.customer === "string") {
        await upsertStripeCustomer(userId, checkout.customer);
    }
}

async function processSubscription(
    value: unknown,
    eventCreated: number,
): Promise<void> {
    const subscription = value as StripeSubscriptionObject;
    if (
        !subscription ||
        typeof subscription.id !== "string" ||
        typeof subscription.customer !== "string" ||
        typeof subscription.status !== "string"
    ) {
        throw new Error("invalid_subscription_object");
    }

    const userId = userIdFromMetadata(subscription.metadata);
    // The payload shape was validated above; the persistence helper
    // re-validates the status and normalizes line items before writing.
    await persistStripeSubscription({
        userId,
        subscription: subscription as unknown as StripeSubscription,
        graceAnchorMs: eventCreated * 1000,
    });
}

function processingErrorCode(error: unknown): string {
    if (error instanceof SyntaxError) return "invalid_json";
    if (!(error instanceof Error)) return "unknown_error";

    const allowed = new Set([
        "invalid_event_envelope",
        "unsupported_subscription_status",
        "missing_user_mapping",
        "invalid_checkout_object",
        "invalid_subscription_object",
    ]);
    return allowed.has(error.message) ? error.message : "database_write_failed";
}

export async function processStripeWebhook(
    rawPayload: string,
): Promise<"processed" | "duplicate" | "ignored"> {
    const event = parseEvent(rawPayload);
    const claimed = await recordStripeWebhookEvent({
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        rawPayload,
    });
    if (!claimed) return "duplicate";

    try {
        if (event.type === "checkout.session.completed") {
            await processCheckoutCompleted(event.data.object);
        } else if (event.type.startsWith("customer.subscription.")) {
            await processSubscription(event.data.object, event.created);
        } else {
            await markStripeWebhookProcessed(event.id);
            return "ignored";
        }

        await markStripeWebhookProcessed(event.id);
        return "processed";
    } catch (error) {
        await markStripeWebhookProcessed(event.id, processingErrorCode(error));
        throw error;
    }
}
