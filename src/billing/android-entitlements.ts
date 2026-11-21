import {
    resolveMunchCapabilities,
    subscriptionProvidesPremium,
    type MunchCapabilities,
} from "./capabilities.js";
import type { SubscriptionSnapshot } from "./entitlements.js";

export interface AndroidEntitlements {
    adFree: boolean | null;
}

export function androidEntitlementsFromSubscription(
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
 * Backwards-compatible name for the original Stripe-only helper. The mapping
 * itself is rail-neutral: it only reads the snapshot's status/grace fields.
 */
export function androidEntitlementsFromLegacyStripePremium(
    subscription: SubscriptionSnapshot | null,
    now = new Date(),
): AndroidEntitlements {
    return androidEntitlementsFromSubscription(subscription, now);
}

export function androidEntitlementsFromCapabilities(
    capabilities: Pick<MunchCapabilities, "tier"> | null,
): AndroidEntitlements {
    return {
        adFree: capabilities?.tier === "premium",
    };
}

export type AndroidCapabilitiesLoader = (
    userId: string,
) => Promise<Pick<MunchCapabilities, "tier">>;

/**
 * Premium subscribers receive the Android ad-free benefit. Ad-free follows
 * the fully resolved account Premium tier — a direct subscription on any
 * rail (Stripe or store), an active explicit premium override, or a
 * covered paid household seat — because Munch's product contract defines
 * Premium as ad-free + MCP + in-app AI chat, and capability resolution
 * already grants all three groups `tier: "premium"`.
 *
 * The tier is resolved on the `"web"` (account-wide) surface via
 * `resolveMunchCapabilities(userId, "web")`: the `"android"` surface
 * intentionally reports a free baseline, so resolving there would mask
 * ad-free for every Android bearer client.
 *
 * A lookup failure returns `{ adFree: null }` (fail-soft, no throw) so the
 * caller can leave the ad state undecided rather than guessing; the ads
 * policy only shows ads on an explicit `adFree === false`.
 */
export async function resolveAndroidEntitlements(
    userId: string,
    loadCapabilities: AndroidCapabilitiesLoader = (id) =>
        resolveMunchCapabilities(id, "web"),
): Promise<AndroidEntitlements> {
    try {
        const capabilities = await loadCapabilities(userId);
        return androidEntitlementsFromCapabilities(capabilities);
    } catch (error) {
        console.warn("Android ad-free entitlement lookup failed", {
            errorName: error instanceof Error ? error.name : "unknown",
        });
        return { adFree: null };
    }
}
