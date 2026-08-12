import { getActiveHouseholdContext } from "../households/repository.js";
import type { SubscriptionSnapshot } from "./entitlements.js";
import { getHouseholdSeatCoverage } from "./household-seats.js";
import { hasActivePremiumOverride } from "./override.js";
import { getSubscriptionSnapshot } from "./repository.js";

export const FREE_HISTORY_DAYS = 30;
export const FREE_SAVED_FOOD_LIMIT = 25;

export interface HouseholdCapabilityContext {
    householdId: string;
    householdName: string;
    ownerUserId: string;
    role: "owner" | "member" | "viewer";
    displayName: string;
}

export interface MunchCapabilities {
    tier: "free" | "premium";
    coreNutrition: true;
    historyDays: number | null;
    savedFoodLimit: number | null;
    personalRecipesRead: boolean;
    personalRecipesWrite: boolean;
    personalPlanningRead: boolean;
    personalPlanningWrite: boolean;
    householdRead: boolean;
    householdWrite: boolean;
    householdManage: boolean;
    household: HouseholdCapabilityContext | null;
    entitlementSource:
        | "free"
        | "direct_subscription"
        | "explicit_override"
        | "household_subscription"
        | "retained_read_access";
}

export function subscriptionProvidesPremium(
    subscription: SubscriptionSnapshot,
    now: Date,
): boolean {
    if (
        subscription.status === "active" ||
        subscription.status === "trialing"
    ) {
        return true;
    }
    return Boolean(
        subscription.status === "past_due" &&
        subscription.graceExpiresAt &&
        subscription.graceExpiresAt.getTime() > now.getTime(),
    );
}

export function capabilitiesFromSubscription(
    subscription: SubscriptionSnapshot,
    now = new Date(),
): MunchCapabilities {
    const premium = subscriptionProvidesPremium(subscription, now);
    return {
        tier: premium ? "premium" : "free",
        coreNutrition: true,
        historyDays: premium ? null : FREE_HISTORY_DAYS,
        savedFoodLimit: premium ? null : FREE_SAVED_FOOD_LIMIT,
        personalRecipesRead: premium,
        personalRecipesWrite: premium,
        personalPlanningRead: premium,
        personalPlanningWrite: premium,
        householdRead: false,
        householdWrite: false,
        householdManage: false,
        household: null,
        entitlementSource: premium ? "direct_subscription" : "free",
    };
}

function applyPremiumOverride(
    capabilities: MunchCapabilities,
): MunchCapabilities {
    return {
        ...capabilities,
        tier: "premium",
        historyDays: null,
        savedFoodLimit: null,
        personalRecipesRead: true,
        personalRecipesWrite: true,
        personalPlanningRead: true,
        personalPlanningWrite: true,
        entitlementSource: "explicit_override",
    };
}

function applyHouseholdPremium(
    capabilities: MunchCapabilities,
): MunchCapabilities {
    return {
        ...capabilities,
        tier: "premium",
        historyDays: null,
        savedFoodLimit: null,
        personalRecipesRead: true,
        personalRecipesWrite: true,
        personalPlanningRead: true,
        personalPlanningWrite: true,
        entitlementSource: "household_subscription",
    };
}

export async function resolveMunchCapabilities(
    userId: string,
): Promise<MunchCapabilities> {
    const [directSubscription, household, explicitOverride] = await Promise.all(
        [
            getSubscriptionSnapshot(userId),
            getActiveHouseholdContext(userId),
            hasActivePremiumOverride(userId),
        ],
    );
    const direct = capabilitiesFromSubscription(directSubscription);
    let result = explicitOverride ? applyPremiumOverride(direct) : direct;
    if (!household) return result;

    const coverage = await getHouseholdSeatCoverage({
        ownerUserId: household.ownerUserId,
        householdId: household.householdId,
    });
    const isOwner =
        household.role === "owner" && household.ownerUserId === userId;
    const inheritedPremium =
        !isOwner && result.tier !== "premium" && coverage.covered;
    if (inheritedPremium) {
        result = applyHouseholdPremium(result);
    }

    const canEditRole =
        household.role === "owner" || household.role === "member";
    // Explicit overrides exist for trusted review/test accounts and preserve
    // their ability to exercise shared UI. Real paid households require both an
    // active owner subscription and sufficient paid seat quantity.
    const sharedBillingActive =
        result.entitlementSource === "explicit_override" ||
        (coverage.ownerHasBillablePremium && coverage.covered);

    return {
        ...result,
        household: {
            householdId: household.householdId,
            householdName: household.householdName,
            ownerUserId: household.ownerUserId,
            role: household.role,
            displayName: household.displayName,
        },
        householdRead: true,
        householdWrite: sharedBillingActive && canEditRole,
        householdManage: sharedBillingActive && isOwner,
        entitlementSource:
            result.entitlementSource === "household_subscription"
                ? "household_subscription"
                : result.tier === "premium"
                  ? result.entitlementSource
                  : "retained_read_access",
    };
}
