import { selectPrimaryStripePriceId } from "../platform/config.js";
import type { SubscriptionStatus } from "./entitlements.js";
import {
    replaceSubscriptionItems,
    upsertStripeCustomer,
    upsertSubscription,
    type StripeSubscriptionItemRecord,
} from "./repository.js";
import type { StripeSubscription } from "./stripe-client.js";

const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

export function stripeSubscriptionStatus(value: string): SubscriptionStatus {
    const allowed: SubscriptionStatus[] = [
        "incomplete",
        "incomplete_expired",
        "trialing",
        "active",
        "past_due",
        "canceled",
        "unpaid",
        "paused",
    ];
    if (!allowed.includes(value as SubscriptionStatus)) {
        throw new Error("unsupported_subscription_status");
    }
    return value as SubscriptionStatus;
}

function optionalDate(timestamp: number | null | undefined): Date | null {
    return typeof timestamp === "number" && Number.isFinite(timestamp)
        ? new Date(timestamp * 1000)
        : null;
}

export function normalizedStripeItems(
    subscription: StripeSubscription,
): StripeSubscriptionItemRecord[] {
    return (subscription.items?.data ?? [])
        .filter(
            (item) =>
                typeof item.id === "string" &&
                typeof item.price?.id === "string",
        )
        .map((item) => ({
            stripeSubscriptionItemId: item.id as string,
            stripePriceId: item.price?.id as string,
            quantity: Math.max(0, Number(item.quantity ?? 0)),
        }));
}

/**
 * Persist a Stripe subscription (retrieved from the API or received via
 * webhook) as the local source of truth: customer mapping, subscription
 * row, and line items. The stored primary price ID is chosen with
 * `selectPrimaryStripePriceId`, so a grandfathered owner's plan price is
 * never overwritten by the household seat price when both line items are
 * present. `graceAnchorMs` anchors the 3-day past_due grace window
 * (webhooks pass the event creation time; API-driven callers use now).
 */
export async function persistStripeSubscription(input: {
    userId: string;
    subscription: StripeSubscription;
    graceAnchorMs?: number;
}): Promise<void> {
    const { subscription } = input;
    const status = stripeSubscriptionStatus(subscription.status);
    const items = normalizedStripeItems(subscription);
    const graceAnchorMs = input.graceAnchorMs ?? Date.now();

    await upsertStripeCustomer(input.userId, subscription.customer);
    await upsertSubscription({
        userId: input.userId,
        stripeSubscriptionId: subscription.id,
        stripePriceId: selectPrimaryStripePriceId(items),
        status,
        currentPeriodStart: optionalDate(subscription.current_period_start),
        currentPeriodEnd: optionalDate(subscription.current_period_end),
        trialEnd: optionalDate(subscription.trial_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
        canceledAt: optionalDate(subscription.canceled_at),
        graceExpiresAt:
            status === "past_due"
                ? new Date(graceAnchorMs + GRACE_PERIOD_MS)
                : null,
    });
    await replaceSubscriptionItems(subscription.id, items);
}
