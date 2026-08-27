import { createHash } from "node:crypto";
import { withBillingDatabase } from "../platform/database.js";
import type { SubscriptionStatus } from "./entitlements.js";

export type StoreBillingProvider = "google_play" | "apple_app_store";

export interface StoreSubscriptionRecord {
    userId: string;
    provider: StoreBillingProvider;
    appId: string;
    productId: string;
    purchaseToken: string;
    obfuscatedAccountId?: string | null;
    status: SubscriptionStatus;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    graceExpiresAt?: Date | null;
    canceledAt?: Date | null;
    providerState?: string | null;
    acknowledged: boolean;
    latestOrderId?: string | null;
    linkedPurchaseToken?: string | null;
    testPurchase?: boolean;
    verifiedAt: Date;
}

export interface LatestStoreSubscriptionRecord {
    provider: StoreBillingProvider;
    appId: string;
    productId: string;
    status: SubscriptionStatus;
    currentPeriodEnd: Date | null;
    graceExpiresAt: Date | null;
    canceledAt: Date | null;
    providerState: string | null;
    acknowledged: boolean;
    verifiedAt: Date;
}

export async function upsertStoreSubscription(
    subscription: StoreSubscriptionRecord,
): Promise<boolean> {
    return withBillingDatabase(async (tx) => {
        const rows = await tx<Array<{ user_id: string }>>`
            insert into munch.store_subscriptions as existing (
                user_id,
                provider,
                app_id,
                product_id,
                purchase_token,
                obfuscated_account_id,
                status,
                current_period_start,
                current_period_end,
                grace_expires_at,
                canceled_at,
                provider_state,
                acknowledged,
                latest_order_id,
                linked_purchase_token,
                test_purchase,
                verified_at
            ) values (
                ${subscription.userId},
                ${subscription.provider}::munch.store_billing_provider,
                ${subscription.appId},
                ${subscription.productId},
                ${subscription.purchaseToken},
                ${subscription.obfuscatedAccountId ?? null},
                ${subscription.status}::munch.subscription_status,
                ${subscription.currentPeriodStart ?? null},
                ${subscription.currentPeriodEnd ?? null},
                ${subscription.graceExpiresAt ?? null},
                ${subscription.canceledAt ?? null},
                ${subscription.providerState ?? null},
                ${subscription.acknowledged},
                ${subscription.latestOrderId ?? null},
                ${subscription.linkedPurchaseToken ?? null},
                ${subscription.testPurchase ?? false},
                ${subscription.verifiedAt}
            )
            on conflict (provider, app_id, purchase_token) do update
            set product_id = excluded.product_id,
                obfuscated_account_id = excluded.obfuscated_account_id,
                status = excluded.status,
                current_period_start = excluded.current_period_start,
                current_period_end = excluded.current_period_end,
                grace_expires_at = excluded.grace_expires_at,
                canceled_at = excluded.canceled_at,
                provider_state = excluded.provider_state,
                acknowledged = excluded.acknowledged,
                latest_order_id = excluded.latest_order_id,
                linked_purchase_token = excluded.linked_purchase_token,
                test_purchase = excluded.test_purchase,
                verified_at = excluded.verified_at,
                updated_at = now()
            where existing.user_id = excluded.user_id
            returning user_id
        `;
        return rows[0]?.user_id === subscription.userId;
    });
}

export async function getLatestStoreSubscriptionRecord(
    userId: string,
): Promise<LatestStoreSubscriptionRecord | null> {
    return withBillingDatabase(async (tx) => {
        const rows = await tx<
            Array<{
                provider: StoreBillingProvider;
                app_id: string;
                product_id: string;
                status: SubscriptionStatus;
                current_period_end: Date | null;
                grace_expires_at: Date | null;
                canceled_at: Date | null;
                provider_state: string | null;
                acknowledged: boolean;
                verified_at: Date;
            }>
        >`
            select
                provider::text as provider,
                app_id,
                product_id,
                status::text as status,
                current_period_end,
                grace_expires_at,
                canceled_at,
                provider_state,
                acknowledged,
                verified_at
            from munch.store_subscriptions
            where user_id = ${userId}
            order by updated_at desc
            limit 1
        `;
        const row = rows[0];
        return row
            ? {
                  provider: row.provider,
                  appId: row.app_id,
                  productId: row.product_id,
                  status: row.status,
                  currentPeriodEnd: row.current_period_end,
                  graceExpiresAt: row.grace_expires_at,
                  canceledAt: row.canceled_at,
                  providerState: row.provider_state,
                  acknowledged: row.acknowledged,
                  verifiedAt: row.verified_at,
              }
            : null;
    });
}

export async function findStoreSubscriptionOwner(input: {
    provider: StoreBillingProvider;
    appId: string;
    purchaseToken: string;
}): Promise<string | null> {
    return withBillingDatabase(async (tx) => {
        const rows = await tx<Array<{ user_id: string }>>`
            select user_id
            from munch.store_subscriptions
            where provider = ${input.provider}::munch.store_billing_provider
              and app_id = ${input.appId}
              and purchase_token = ${input.purchaseToken}
            limit 1
        `;
        return rows[0]?.user_id ?? null;
    });
}

export async function recordStoreBillingEvent(input: {
    provider: StoreBillingProvider;
    eventId: string;
    eventType: string;
    rawPayload: string;
}): Promise<boolean> {
    const payloadSha256 = createHash("sha256")
        .update(input.rawPayload, "utf8")
        .digest("hex");
    return withBillingDatabase(async (tx) => {
        const rows = await tx<Array<{ event_id: string }>>`
            insert into munch.store_billing_events as existing (
                provider,
                event_id,
                event_type,
                payload_sha256,
                attempts
            ) values (
                ${input.provider}::munch.store_billing_provider,
                ${input.eventId},
                ${input.eventType},
                ${payloadSha256},
                1
            )
            on conflict (provider, event_id) do update
            set attempts = existing.attempts + 1,
                processing_error_code = null
            where existing.processed_at is null
              and existing.payload_sha256 = excluded.payload_sha256
              and existing.event_type = excluded.event_type
            returning event_id
        `;
        return Boolean(rows[0]);
    });
}

export async function markStoreBillingEventProcessed(input: {
    provider: StoreBillingProvider;
    eventId: string;
    errorCode?: string;
}): Promise<void> {
    const errorCode = input.errorCode ?? null;
    await withBillingDatabase(async (tx) => {
        await tx`
            update munch.store_billing_events
            set processed_at = case
                    when ${errorCode}::text is null then now()
                    else null
                end,
                processing_error_code = ${errorCode}::text
            where provider = ${input.provider}::munch.store_billing_provider
              and event_id = ${input.eventId}
        `;
    });
}
