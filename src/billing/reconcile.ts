import {
    getGooglePlaySubscription,
    GooglePlayApiError,
    type GooglePlaySubscriptionPurchaseV2,
} from "./google-play-client.js";
import { googlePlayBillingConfigured } from "./google-play-config.js";
import { persistGooglePlayPremiumForUser } from "./google-play.js";
import {
    listOverdueActiveStripeSubscriptions,
    markStripeSubscriptionCanceled,
} from "./repository.js";
import {
    retrieveStripeSubscription,
    StripeRequestError,
} from "./stripe-client.js";
import { persistStripeSubscription } from "./stripe-persistence.js";
import {
    listOverdueActiveGooglePlaySubscriptions,
    markStoreSubscriptionCanceled,
} from "./store-repository.js";

export const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
// Do not race the normal renewal webhook/RTDN that lands right at the
// period boundary: only sweep rows whose period ended at least this long ago.
export const PERIOD_END_BUFFER_MS = 15 * 60 * 1000;
// Persisting a still-overdue row refreshes updated_at = now(), so requiring
// updated_at <= now - RECHECK_COOLDOWN_MS keeps the sweep from hot-looping
// on the same rows every interval without any schema change.
export const RECHECK_COOLDOWN_MS = 60 * 60 * 1000;
export const DEFAULT_BATCH_LIMIT = 50;

export interface ReconcileSummary {
    stripeSkipped: boolean;
    stripeChecked: number;
    stripePersisted: number;
    stripeCanceled: number;
    stripeFailed: number;
    googlePlaySkipped: boolean;
    googlePlayChecked: number;
    googlePlayPersisted: number;
    googlePlayCanceled: number;
    googlePlayFailed: number;
}

export interface ReconcileDependencies {
    stripeConfigured: () => boolean;
    googlePlayConfigured: () => boolean;
    listStripe: typeof listOverdueActiveStripeSubscriptions;
    listGooglePlay: typeof listOverdueActiveGooglePlaySubscriptions;
    retrieveStripeSubscription: typeof retrieveStripeSubscription;
    persistStripe: typeof persistStripeSubscription;
    markStripeCanceled: typeof markStripeSubscriptionCanceled;
    getGooglePlaySubscription: (
        purchaseToken: string,
    ) => Promise<GooglePlaySubscriptionPurchaseV2>;
    persistGooglePlay: typeof persistGooglePlayPremiumForUser;
    markGooglePlayCanceled: typeof markStoreSubscriptionCanceled;
}

export interface ReconcileOptions {
    now?: Date;
    batchLimit?: number;
    dependencies?: Partial<ReconcileDependencies>;
}

function defaultDependencies(): ReconcileDependencies {
    return {
        stripeConfigured: () => Boolean(process.env.STRIPE_SECRET_KEY?.trim()),
        googlePlayConfigured: googlePlayBillingConfigured,
        listStripe: listOverdueActiveStripeSubscriptions,
        listGooglePlay: listOverdueActiveGooglePlaySubscriptions,
        retrieveStripeSubscription,
        persistStripe: persistStripeSubscription,
        markStripeCanceled: markStripeSubscriptionCanceled,
        getGooglePlaySubscription: (purchaseToken) =>
            getGooglePlaySubscription(purchaseToken),
        persistGooglePlay: persistGooglePlayPremiumForUser,
        markGooglePlayCanceled: markStoreSubscriptionCanceled,
    };
}

function errorCode(error: unknown): string {
    return error instanceof Error ? error.message : "unknown";
}

/**
 * Re-fetch overdue `active`/`trialing` rows from Stripe and Google Play so
 * a missed terminal webhook/RTDN cannot leave a subscription granting
 * Premium forever. Entitlement evaluators already deny rows past
 * `currentPeriodEnd`; this sweep repairs the stored state (renewed period
 * ends, cancellations) and definitively cancels rows the provider no
 * longer knows about.
 */
export async function reconcileOverdueSubscriptions(
    options: ReconcileOptions = {},
): Promise<ReconcileSummary> {
    const deps: ReconcileDependencies = {
        ...defaultDependencies(),
        ...options.dependencies,
    };
    const now = options.now ?? new Date();
    const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
    const periodEndedBefore = new Date(now.getTime() - PERIOD_END_BUFFER_MS);
    const updatedBefore = new Date(now.getTime() - RECHECK_COOLDOWN_MS);
    const summary: ReconcileSummary = {
        stripeSkipped: false,
        stripeChecked: 0,
        stripePersisted: 0,
        stripeCanceled: 0,
        stripeFailed: 0,
        googlePlaySkipped: false,
        googlePlayChecked: 0,
        googlePlayPersisted: 0,
        googlePlayCanceled: 0,
        googlePlayFailed: 0,
    };

    if (!deps.stripeConfigured()) {
        summary.stripeSkipped = true;
    } else {
        const rows = await deps.listStripe({
            periodEndedBefore,
            updatedBefore,
            limit: batchLimit,
        });
        for (const row of rows) {
            summary.stripeChecked += 1;
            try {
                const subscription = await deps.retrieveStripeSubscription(
                    row.stripeSubscriptionId,
                );
                const metadataUserId = subscription.metadata?.munch_user_id;
                if (metadataUserId && metadataUserId !== row.userId) {
                    console.error(
                        `[billing] reconcile_stripe_user_mismatch subscription=${row.stripeSubscriptionId}`,
                    );
                    summary.stripeFailed += 1;
                    continue;
                }
                await deps.persistStripe({
                    userId: row.userId,
                    subscription,
                    graceAnchorMs: now.getTime(),
                });
                summary.stripePersisted += 1;
            } catch (error) {
                if (
                    error instanceof StripeRequestError &&
                    (error.status === 404 || error.code === "resource_missing")
                ) {
                    await deps.markStripeCanceled({
                        userId: row.userId,
                        stripeSubscriptionId: row.stripeSubscriptionId,
                        canceledAt: now,
                    });
                    summary.stripeCanceled += 1;
                    continue;
                }
                summary.stripeFailed += 1;
                console.error(
                    `[billing] reconcile_stripe_failed subscription=${row.stripeSubscriptionId} reason=${errorCode(error)}`,
                );
            }
        }
    }

    if (!deps.googlePlayConfigured()) {
        summary.googlePlaySkipped = true;
    } else {
        const rows = await deps.listGooglePlay({
            periodEndedBefore,
            updatedBefore,
            limit: batchLimit,
        });
        for (const row of rows) {
            summary.googlePlayChecked += 1;
            try {
                const purchase = await deps.getGooglePlaySubscription(
                    row.purchaseToken,
                );
                await deps.persistGooglePlay({
                    userId: row.userId,
                    purchaseToken: row.purchaseToken,
                    purchase,
                    now,
                });
                summary.googlePlayPersisted += 1;
            } catch (error) {
                if (
                    error instanceof GooglePlayApiError &&
                    (error.status === 404 || error.status === 410)
                ) {
                    await deps.markGooglePlayCanceled({
                        provider: "google_play",
                        appId: row.appId,
                        purchaseToken: row.purchaseToken,
                        canceledAt: now,
                        verifiedAt: now,
                    });
                    summary.googlePlayCanceled += 1;
                    continue;
                }
                summary.googlePlayFailed += 1;
                console.error(
                    `[billing] reconcile_google_play_failed reason=${errorCode(error)}`,
                );
            }
        }
    }

    return summary;
}

let reconcileRunning = false;

export function startSubscriptionReconciliation(): void {
    setInterval(() => {
        if (reconcileRunning) return;
        reconcileRunning = true;
        reconcileOverdueSubscriptions()
            .catch((error) => {
                console.error(
                    `[billing] subscription_reconciliation_failed reason=${errorCode(error)}`,
                );
            })
            .finally(() => {
                reconcileRunning = false;
            });
    }, RECONCILE_INTERVAL_MS);
}
