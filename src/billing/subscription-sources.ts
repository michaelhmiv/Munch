import type { SubscriptionSnapshot } from "./entitlements.js";
import { getLatestStripeSubscriptionRecord } from "./repository.js";
import {
    getLatestStoreSubscriptionRecord,
    type StoreBillingProvider,
} from "./store-repository.js";

export type DirectBillingProvider = "stripe" | StoreBillingProvider;

export interface DirectSubscriptionSnapshot extends SubscriptionSnapshot {
    provider: DirectBillingProvider | null;
    productId?: string | null;
}

function accessRank(subscription: SubscriptionSnapshot, now: Date): number {
    if (subscription.status === "active" || subscription.status === "trialing") {
        return 4;
    }
    if (
        subscription.status === "past_due" &&
        subscription.graceExpiresAt &&
        subscription.graceExpiresAt.getTime() > now.getTime()
    ) {
        return 3;
    }
    if (subscription.status !== null) return 1;
    return 0;
}

function laterPeriodEnd(
    left: DirectSubscriptionSnapshot,
    right: DirectSubscriptionSnapshot,
): DirectSubscriptionSnapshot {
    const leftEnd = left.currentPeriodEnd?.getTime() ?? 0;
    const rightEnd = right.currentPeriodEnd?.getTime() ?? 0;
    return rightEnd > leftEnd ? right : left;
}

export function chooseDirectSubscription(
    subscriptions: DirectSubscriptionSnapshot[],
    now = new Date(),
): DirectSubscriptionSnapshot {
    let selected: DirectSubscriptionSnapshot = {
        provider: null,
        status: null,
    };
    for (const subscription of subscriptions) {
        const selectedRank = accessRank(selected, now);
        const candidateRank = accessRank(subscription, now);
        if (candidateRank > selectedRank) {
            selected = subscription;
        } else if (candidateRank === selectedRank && candidateRank > 0) {
            selected = laterPeriodEnd(selected, subscription);
        }
    }
    return selected;
}

export async function getDirectSubscriptionSnapshot(
    userId: string,
): Promise<DirectSubscriptionSnapshot> {
    const [stripe, store] = await Promise.all([
        getLatestStripeSubscriptionRecord(userId),
        getLatestStoreSubscriptionRecord(userId),
    ]);
    const candidates: DirectSubscriptionSnapshot[] = [];
    if (stripe) {
        candidates.push({
            provider: "stripe",
            productId: stripe.stripePriceId,
            status: stripe.status,
            currentPeriodEnd: stripe.currentPeriodEnd,
            graceExpiresAt: stripe.graceExpiresAt,
        });
    }
    if (store) {
        candidates.push({
            provider: store.provider,
            productId: store.productId,
            status: store.status,
            currentPeriodEnd: store.currentPeriodEnd,
            graceExpiresAt: store.graceExpiresAt,
        });
    }
    return chooseDirectSubscription(candidates);
}
