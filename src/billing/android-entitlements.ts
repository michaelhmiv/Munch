import { getLatestStripeSubscriptionRecord } from "./repository.js";
import { subscriptionProvidesPremium } from "./capabilities.js";
import type { SubscriptionSnapshot } from "./entitlements.js";

export interface AndroidEntitlements {
    adFree: boolean | null;
}

export function androidEntitlementsFromLegacyStripePremium(
    subscription: SubscriptionSnapshot | null,
    now = new Date(),
): AndroidEntitlements {
    return {
        adFree: Boolean(
            subscription && subscriptionProvidesPremium(subscription, now),
        ),
    };
}

/**
 * Existing Stripe Premium customers retain their website/MCP capabilities and
 * also receive the approved Android ad-free benefit. This remains a separate
 * entitlement from the Munch feature tier and from future store products.
 */
export async function resolveAndroidEntitlements(
    userId: string,
): Promise<AndroidEntitlements> {
    try {
        const subscription = await getLatestStripeSubscriptionRecord(userId);
        return androidEntitlementsFromLegacyStripePremium(subscription);
    } catch (error) {
        console.warn("Android ad-free entitlement lookup failed", {
            errorName: error instanceof Error ? error.name : "unknown",
        });
        return { adFree: null };
    }
}
