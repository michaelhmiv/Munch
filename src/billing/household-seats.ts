import {
    acceptHouseholdInvitation,
    clearHouseholdInvitationSeatReservation,
    clearHouseholdSeatReleaseReservation,
    getActiveHouseholdContext,
    getHouseholdSeatCounts,
    removeHouseholdMember,
    reserveHouseholdInvitationSeat,
    reserveHouseholdSeatRelease,
} from "../households/repository.js";
import { dissolveHousehold, leaveHousehold } from "../households/lifecycle.js";
import { getPlatformConfig } from "../platform/config.js";
import { PRODUCT_CONFIG } from "../product-config.js";
import {
    getLatestStripeSubscriptionRecord,
    getSubscriptionItemQuantity,
    replaceSubscriptionItems,
    type LatestStripeSubscriptionRecord,
} from "./repository.js";
import {
    setStripeSubscriptionItemQuantity,
    StripeRequestError,
    subscriptionItemQuantity,
    type StripeSubscription,
} from "./stripe-client.js";

// Backwards-compatible exports. Pricing and member-count policy live in
// PRODUCT_CONFIG so authorization, billing calculations, and UI contracts share
// the same inputs.
export const PREMIUM_MONTHLY_CENTS = PRODUCT_CONFIG.premiumPriceMonthlyCents;
export const HOUSEHOLD_MEMBER_MONTHLY_CENTS =
    PRODUCT_CONFIG.householdMemberPriceMonthlyCents;
export const MAX_ADDITIONAL_HOUSEHOLD_MEMBERS =
    PRODUCT_CONFIG.householdMemberLimit - 1;

export interface HouseholdSeatCoverage {
    ownerHasBillablePremium: boolean;
    activeNonOwnerCount: number;
    billedSeatQuantity: number;
    covered: boolean;
}

function subscriptionItems(subscription: StripeSubscription) {
    return (subscription.items?.data ?? [])
        .filter(
            (item) =>
                typeof item.id === "string" &&
                typeof item.price?.id === "string",
        )
        .map((item) => ({
            stripeSubscriptionItemId: item.id,
            stripePriceId: item.price?.id as string,
            quantity: Math.max(0, Number(item.quantity ?? 0)),
        }));
}

function recordProvidesPremium(
    record: LatestStripeSubscriptionRecord,
    now = new Date(),
): boolean {
    if (record.status === "active" || record.status === "trialing") return true;
    return Boolean(
        record.status === "past_due" &&
        record.graceExpiresAt &&
        record.graceExpiresAt.getTime() > now.getTime(),
    );
}

export function paidHouseholdSeatCoverage(
    billedSeatQuantity: number,
    activeNonOwnerCount: number,
): boolean {
    return (
        Number.isInteger(billedSeatQuantity) &&
        Number.isInteger(activeNonOwnerCount) &&
        activeNonOwnerCount >= 0 &&
        activeNonOwnerCount <= MAX_ADDITIONAL_HOUSEHOLD_MEMBERS &&
        billedSeatQuantity >= activeNonOwnerCount
    );
}

export function householdMonthlyTotalCents(
    activeNonOwnerCount: number,
): number {
    if (
        !Number.isInteger(activeNonOwnerCount) ||
        activeNonOwnerCount < 0 ||
        activeNonOwnerCount > MAX_ADDITIONAL_HOUSEHOLD_MEMBERS
    ) {
        throw new Error("Household member count is invalid");
    }
    return (
        PREMIUM_MONTHLY_CENTS +
        activeNonOwnerCount * HOUSEHOLD_MEMBER_MONTHLY_CENTS
    );
}

async function billableOwnerSubscription(ownerUserId: string) {
    const config = getPlatformConfig();
    const record = await getLatestStripeSubscriptionRecord(ownerUserId);
    if (
        !record ||
        record.stripePriceId !== config.stripePriceId ||
        !recordProvidesPremium(record)
    ) {
        throw new Error("household_owner_paid_premium_required");
    }
    return { config, record };
}

export async function ownerCanPurchaseHouseholdSeats(
    ownerUserId: string,
): Promise<boolean> {
    try {
        await billableOwnerSubscription(ownerUserId);
        return true;
    } catch {
        return false;
    }
}

export async function getHouseholdSeatCoverage(input: {
    ownerUserId: string;
    householdId: string;
}): Promise<HouseholdSeatCoverage> {
    const counts = await getHouseholdSeatCounts(input.householdId);
    try {
        const { config, record } = await billableOwnerSubscription(
            input.ownerUserId,
        );
        const billedSeatQuantity = await getSubscriptionItemQuantity(
            record.stripeSubscriptionId,
            config.stripeHouseholdMemberPriceId,
        );
        return {
            ownerHasBillablePremium: true,
            activeNonOwnerCount: counts.activeNonOwnerCount,
            billedSeatQuantity,
            covered: paidHouseholdSeatCoverage(
                billedSeatQuantity,
                counts.activeNonOwnerCount,
            ),
        };
    } catch {
        return {
            ownerHasBillablePremium: false,
            activeNonOwnerCount: counts.activeNonOwnerCount,
            billedSeatQuantity: 0,
            covered: false,
        };
    }
}

async function setOwnerSeatQuantity(input: {
    ownerUserId: string;
    quantity: number;
    idempotencyKey: string;
}): Promise<void> {
    if (
        !Number.isInteger(input.quantity) ||
        input.quantity < 0 ||
        input.quantity > MAX_ADDITIONAL_HOUSEHOLD_MEMBERS
    ) {
        throw new Error("household_member_limit_reached");
    }
    const { config, record } = await billableOwnerSubscription(
        input.ownerUserId,
    );
    const subscription = await setStripeSubscriptionItemQuantity({
        subscriptionId: record.stripeSubscriptionId,
        priceId: config.stripeHouseholdMemberPriceId,
        quantity: input.quantity,
        idempotencyKey: input.idempotencyKey,
    });
    await replaceSubscriptionItems(
        record.stripeSubscriptionId,
        subscriptionItems(subscription),
    );
    const applied = subscriptionItemQuantity(
        subscription,
        config.stripeHouseholdMemberPriceId,
    );
    if (applied !== input.quantity) {
        throw new Error("household_seat_quantity_not_applied");
    }
}

async function reconcileDesiredQuantity(input: {
    ownerUserId: string;
    householdId: string;
    operationKey: string;
}): Promise<void> {
    const counts = await getHouseholdSeatCounts(input.householdId);
    await setOwnerSeatQuantity({
        ownerUserId: input.ownerUserId,
        quantity: counts.desiredSeatQuantity,
        idempotencyKey: `${input.operationKey}:reconcile:${counts.desiredSeatQuantity}`,
    });
}

function logSeatFailure(operation: string, error: unknown): void {
    if (error instanceof StripeRequestError) {
        console.error(
            `[billing] household_seat_failed operation=${operation} reason=${error.code} status=${error.status} param=${error.param ?? "none"} request_id=${error.requestId ?? "none"} message=${error.stripeMessage ?? "none"}`,
        );
        return;
    }
    console.error(
        `[billing] household_seat_failed operation=${operation} reason=${error instanceof Error ? error.message : "unknown"}`,
    );
}

export async function acceptPaidHouseholdInvitation(input: {
    userId: string;
    token: string;
    displayName: string;
}) {
    const reservation = await reserveHouseholdInvitationSeat({
        userId: input.userId,
        token: input.token,
    });
    const operationKey = `munch-household-add-${reservation.invitationId}`;
    try {
        await setOwnerSeatQuantity({
            ownerUserId: reservation.ownerUserId,
            quantity: reservation.targetSeatQuantity,
            idempotencyKey: `${operationKey}:${reservation.targetSeatQuantity}`,
        });
        return await acceptHouseholdInvitation({
            userId: input.userId,
            token: input.token,
            displayName: input.displayName,
        });
    } catch (error) {
        logSeatFailure("accept", error);
        await clearHouseholdInvitationSeatReservation(
            reservation.invitationId,
        ).catch(() => undefined);
        await reconcileDesiredQuantity({
            ownerUserId: reservation.ownerUserId,
            householdId: reservation.householdId,
            operationKey,
        }).catch((reconcileError) =>
            logSeatFailure("accept_reconcile", reconcileError),
        );
        throw error;
    }
}

export async function removePaidHouseholdMember(input: {
    ownerUserId: string;
    householdId: string;
    membershipId: string;
}): Promise<boolean> {
    const reservation = await reserveHouseholdSeatRelease({
        requesterUserId: input.ownerUserId,
        householdId: input.householdId,
        membershipId: input.membershipId,
    });
    const operationKey = `munch-household-remove-${reservation.membershipId}`;
    try {
        await setOwnerSeatQuantity({
            ownerUserId: reservation.ownerUserId,
            quantity: reservation.targetSeatQuantity,
            idempotencyKey: `${operationKey}:${reservation.targetSeatQuantity}`,
        });
        const removed = await removeHouseholdMember({
            userId: input.ownerUserId,
            householdId: input.householdId,
            membershipId: input.membershipId,
        });
        if (!removed) throw new Error("household_member_not_removed");
        return true;
    } catch (error) {
        logSeatFailure("remove", error);
        await clearHouseholdSeatReleaseReservation(
            reservation.membershipId,
        ).catch(() => undefined);
        await reconcileDesiredQuantity({
            ownerUserId: reservation.ownerUserId,
            householdId: reservation.householdId,
            operationKey,
        }).catch((reconcileError) =>
            logSeatFailure("remove_reconcile", reconcileError),
        );
        throw error;
    }
}

export async function leavePaidHousehold(userId: string): Promise<boolean> {
    const household = await getActiveHouseholdContext(userId);
    if (!household) return false;
    if (household.role === "owner") {
        throw new Error("Household owner must dissolve the household");
    }
    const reservation = await reserveHouseholdSeatRelease({
        requesterUserId: userId,
        householdId: household.householdId,
        selfLeave: true,
    });
    const operationKey = `munch-household-leave-${reservation.membershipId}`;
    try {
        await setOwnerSeatQuantity({
            ownerUserId: reservation.ownerUserId,
            quantity: reservation.targetSeatQuantity,
            idempotencyKey: `${operationKey}:${reservation.targetSeatQuantity}`,
        });
        const left = await leaveHousehold(userId);
        if (!left) throw new Error("household_member_not_removed");
        return true;
    } catch (error) {
        logSeatFailure("leave", error);
        await clearHouseholdSeatReleaseReservation(
            reservation.membershipId,
        ).catch(() => undefined);
        await reconcileDesiredQuantity({
            ownerUserId: reservation.ownerUserId,
            householdId: reservation.householdId,
            operationKey,
        }).catch((reconcileError) =>
            logSeatFailure("leave_reconcile", reconcileError),
        );
        throw error;
    }
}

export async function dissolvePaidHousehold(input: {
    ownerUserId: string;
    householdId: string;
}): Promise<boolean> {
    const operationKey = `munch-household-dissolve-${input.householdId}`;
    const counts = await getHouseholdSeatCounts(input.householdId);
    try {
        if (counts.desiredSeatQuantity > 0 || counts.activeNonOwnerCount > 0) {
            await setOwnerSeatQuantity({
                ownerUserId: input.ownerUserId,
                quantity: 0,
                idempotencyKey: `${operationKey}:0`,
            });
        }
        const dissolved = await dissolveHousehold({
            userId: input.ownerUserId,
            householdId: input.householdId,
        });
        if (!dissolved) throw new Error("household_not_dissolved");
        return true;
    } catch (error) {
        logSeatFailure("dissolve", error);
        const household = await getActiveHouseholdContext(
            input.ownerUserId,
        ).catch(() => null);
        if (household?.householdId === input.householdId) {
            await reconcileDesiredQuantity({
                ownerUserId: input.ownerUserId,
                householdId: input.householdId,
                operationKey,
            }).catch((reconcileError) =>
                logSeatFailure("dissolve_reconcile", reconcileError),
            );
        }
        throw error;
    }
}
