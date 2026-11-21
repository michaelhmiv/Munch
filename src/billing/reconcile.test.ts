import { describe, expect, test } from "bun:test";
import { GooglePlayApiError } from "./google-play-client.js";
import {
    reconcileOverdueSubscriptions,
    type ReconcileDependencies,
} from "./reconcile.js";
import {
    StripeRequestError,
    type StripeSubscription,
} from "./stripe-client.js";

const now = new Date("2026-11-20T12:00:00.000Z");
const futurePeriodEndSeconds = Math.floor(
    new Date("2026-12-20T12:00:00.000Z").getTime() / 1000,
);

function stripeSubscription(
    overrides: Partial<StripeSubscription> = {},
): StripeSubscription {
    return {
        id: "sub_overdue",
        customer: "cus_overdue",
        status: "canceled",
        metadata: { munch_user_id: "user-1" },
        items: { data: [] },
        ...overrides,
    };
}

function harness(overrides: Partial<ReconcileDependencies> = {}): {
    deps: Partial<ReconcileDependencies>;
    persistedStripe: Array<{
        userId: string;
        subscription: StripeSubscription;
    }>;
    canceledStripe: Array<{ userId: string; stripeSubscriptionId: string }>;
    persistedPlay: Array<{ userId: string; purchaseToken: string }>;
    canceledPlay: Array<{ appId: string; purchaseToken: string }>;
} {
    const persistedStripe: Array<{
        userId: string;
        subscription: StripeSubscription;
    }> = [];
    const canceledStripe: Array<{
        userId: string;
        stripeSubscriptionId: string;
    }> = [];
    const persistedPlay: Array<{ userId: string; purchaseToken: string }> = [];
    const canceledPlay: Array<{ appId: string; purchaseToken: string }> = [];
    const deps: Partial<ReconcileDependencies> = {
        stripeConfigured: () => true,
        googlePlayConfigured: () => false,
        listStripe: async () => [],
        listGooglePlay: async () => [],
        retrieveStripeSubscription: async () => stripeSubscription(),
        persistStripe: async (input) => {
            persistedStripe.push(input);
        },
        markStripeCanceled: async (input) => {
            canceledStripe.push(input);
        },
        getGooglePlaySubscription: async () => ({}),
        persistGooglePlay: async (input) => {
            persistedPlay.push(input);
            return {
                provider: "google_play",
                productId: "munch_premium_monthly",
                status: "active",
                currentPeriodStart: null,
                currentPeriodEnd: null,
                graceExpiresAt: null,
                canceledAt: null,
                providerState: "SUBSCRIPTION_STATE_ACTIVE",
                acknowledged: true,
                latestOrderId: null,
                linkedPurchaseToken: null,
                testPurchase: false,
            };
        },
        markGooglePlayCanceled: async (input) => {
            canceledPlay.push(input);
        },
        ...overrides,
    };
    return {
        deps,
        persistedStripe,
        canceledStripe,
        persistedPlay,
        canceledPlay,
    };
}

describe("reconcileOverdueSubscriptions", () => {
    test("persists the live canceled state for an overdue Stripe row", async () => {
        const { deps, persistedStripe } = harness({
            listStripe: async () => [
                { userId: "user-1", stripeSubscriptionId: "sub_overdue" },
            ],
        });
        const summary = await reconcileOverdueSubscriptions({
            now,
            dependencies: deps,
        });
        expect(summary.stripeChecked).toBe(1);
        expect(summary.stripePersisted).toBe(1);
        expect(persistedStripe[0]?.userId).toBe("user-1");
        expect(persistedStripe[0]?.subscription.status).toBe("canceled");
    });

    test("persists a renewed period end for a row that actually renewed", async () => {
        const { deps, persistedStripe } = harness({
            listStripe: async () => [
                { userId: "user-1", stripeSubscriptionId: "sub_overdue" },
            ],
            retrieveStripeSubscription: async () =>
                stripeSubscription({
                    status: "active",
                    current_period_end: futurePeriodEndSeconds,
                }),
        });
        const summary = await reconcileOverdueSubscriptions({
            now,
            dependencies: deps,
        });
        expect(summary.stripePersisted).toBe(1);
        expect(persistedStripe[0]?.subscription.current_period_end).toBe(
            futurePeriodEndSeconds,
        );
    });

    test("marks a Stripe 404 row canceled without aborting the batch", async () => {
        const { deps, canceledStripe, persistedStripe } = harness({
            listStripe: async () => [
                { userId: "user-1", stripeSubscriptionId: "sub_gone" },
                { userId: "user-2", stripeSubscriptionId: "sub_overdue" },
            ],
            retrieveStripeSubscription: async (subscriptionId) => {
                if (subscriptionId === "sub_gone") {
                    throw new StripeRequestError("resource_missing", 404);
                }
                return stripeSubscription({
                    id: subscriptionId,
                    metadata: { munch_user_id: "user-2" },
                });
            },
        });
        const summary = await reconcileOverdueSubscriptions({
            now,
            dependencies: deps,
        });
        expect(summary.stripeCanceled).toBe(1);
        expect(canceledStripe[0]?.stripeSubscriptionId).toBe("sub_gone");
        expect(summary.stripePersisted).toBe(1);
        expect(persistedStripe[0]?.userId).toBe("user-2");
    });

    test("continues past a transient Stripe 5xx so later rows still reconcile", async () => {
        const { deps, persistedStripe } = harness({
            listStripe: async () => [
                { userId: "user-1", stripeSubscriptionId: "sub_flaky" },
                { userId: "user-2", stripeSubscriptionId: "sub_overdue" },
            ],
            retrieveStripeSubscription: async (subscriptionId) => {
                if (subscriptionId === "sub_flaky") {
                    throw new StripeRequestError("api_error", 500);
                }
                return stripeSubscription({
                    id: subscriptionId,
                    metadata: { munch_user_id: "user-2" },
                });
            },
        });
        const summary = await reconcileOverdueSubscriptions({
            now,
            dependencies: deps,
        });
        expect(summary.stripeFailed).toBe(1);
        expect(summary.stripePersisted).toBe(1);
        expect(persistedStripe[0]?.userId).toBe("user-2");
    });

    test("does not reassign a subscription whose metadata names another user", async () => {
        const { deps, persistedStripe } = harness({
            listStripe: async () => [
                { userId: "user-1", stripeSubscriptionId: "sub_overdue" },
            ],
            retrieveStripeSubscription: async () =>
                stripeSubscription({
                    metadata: { munch_user_id: "someone-else" },
                }),
        });
        const summary = await reconcileOverdueSubscriptions({
            now,
            dependencies: deps,
        });
        expect(summary.stripePersisted).toBe(0);
        expect(summary.stripeFailed).toBe(1);
        expect(persistedStripe).toEqual([]);
    });

    test("skips the Stripe pass cleanly when Stripe is not configured", async () => {
        let listed = false;
        const { deps } = harness({
            stripeConfigured: () => false,
            listStripe: async () => {
                listed = true;
                return [];
            },
        });
        const summary = await reconcileOverdueSubscriptions({
            now,
            dependencies: deps,
        });
        expect(summary.stripeSkipped).toBe(true);
        expect(listed).toBe(false);
    });

    test("reconciles an overdue Google Play row through persist", async () => {
        const { deps, persistedPlay } = harness({
            googlePlayConfigured: () => true,
            listGooglePlay: async () => [
                {
                    userId: "user-9",
                    appId: "business.munch.app",
                    purchaseToken: "play-token-1",
                },
            ],
        });
        const summary = await reconcileOverdueSubscriptions({
            now,
            dependencies: deps,
        });
        expect(summary.googlePlayChecked).toBe(1);
        expect(summary.googlePlayPersisted).toBe(1);
        expect(persistedPlay[0]).toEqual({
            userId: "user-9",
            purchaseToken: "play-token-1",
            purchase: {},
            now,
        });
    });

    test("skips the Google Play pass cleanly when Play is not configured", async () => {
        let listed = false;
        const { deps } = harness({
            googlePlayConfigured: () => false,
            listGooglePlay: async () => {
                listed = true;
                return [];
            },
        });
        const summary = await reconcileOverdueSubscriptions({
            now,
            dependencies: deps,
        });
        expect(summary.googlePlaySkipped).toBe(true);
        expect(listed).toBe(false);
    });

    test("marks a Google Play 410 row canceled", async () => {
        const { deps, canceledPlay } = harness({
            googlePlayConfigured: () => true,
            listGooglePlay: async () => [
                {
                    userId: "user-9",
                    appId: "business.munch.app",
                    purchaseToken: "play-token-gone",
                },
            ],
            getGooglePlaySubscription: async () => {
                throw new GooglePlayApiError(410, "gone");
            },
        });
        const summary = await reconcileOverdueSubscriptions({
            now,
            dependencies: deps,
        });
        expect(summary.googlePlayCanceled).toBe(1);
        expect(canceledPlay[0]?.purchaseToken).toBe("play-token-gone");
    });
});
