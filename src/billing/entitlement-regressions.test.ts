import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    mock,
    setSystemTime,
    test,
} from "bun:test";
import { Hono } from "hono";
import * as actualAuth from "../auth/auth.js";
import * as actualHouseholdRepo from "../households/repository.js";
import * as actualOverride from "./override.js";
import * as actualBillingRepo from "./repository.js";
import * as actualStoreRepo from "./store-repository.js";

// Fixed fixture dates, with the wall clock frozen at `now` (between pastDate
// and futureDate) in beforeEach — several production paths under test read
// `new Date()` directly instead of taking an injected `now`, so without the
// freeze these tests would only pass inside the pastDate–futureDate window.
const now = new Date("2026-11-20T12:00:00.000Z");
const pastDate = new Date("2026-11-19T12:00:00.000Z");
const futureDate = new Date("2026-12-20T12:00:00.000Z");

const originalEnv = { ...process.env };

const state = {
    sessionUser: null as { id: string; email: string } | null,
    stripeByUser: new Map<
        string,
        actualBillingRepo.LatestStripeSubscriptionRecord | null
    >(),
    storeByUser: new Map<
        string,
        actualStoreRepo.LatestStoreSubscriptionRecord | null
    >(),
    overrideByUser: new Map<string, boolean>(),
    householdByUser: new Map<
        string,
        Awaited<
            ReturnType<typeof actualHouseholdRepo.getActiveHouseholdContext>
        >
    >(),
    seatCountsByHousehold: new Map<
        string,
        { activeNonOwnerCount: number; desiredSeatQuantity: number }
    >(),
    itemQuantityBySubAndPrice: new Map<string, number>(),
};

mock.module("../auth/auth.js", () => ({
    ...actualAuth,
    getMunchBetterAuth: () => ({
        api: {
            getSession: async () =>
                state.sessionUser ? { user: state.sessionUser } : null,
        },
    }),
}));

mock.module("./repository.js", () => ({
    ...actualBillingRepo,
    getLatestStripeSubscriptionRecord: async (userId: string) =>
        state.stripeByUser.get(userId) ?? null,
    getSubscriptionSnapshot: async (userId: string) => {
        const record = state.stripeByUser.get(userId) ?? null;
        return record
            ? {
                  status: record.status,
                  currentPeriodEnd: record.currentPeriodEnd,
                  graceExpiresAt: record.graceExpiresAt,
              }
            : { status: null };
    },
    getSubscriptionItemQuantity: async (
        stripeSubscriptionId: string,
        stripePriceId: string,
    ) =>
        state.itemQuantityBySubAndPrice.get(
            `${stripeSubscriptionId}:${stripePriceId}`,
        ) ?? 0,
}));

mock.module("./store-repository.js", () => ({
    ...actualStoreRepo,
    getLatestStoreSubscriptionRecord: async (userId: string) =>
        state.storeByUser.get(userId) ?? null,
}));

mock.module("./override.js", () => ({
    ...actualOverride,
    hasActivePremiumOverride: async (userId: string) =>
        state.overrideByUser.get(userId) ?? false,
}));

mock.module("../households/repository.js", () => ({
    ...actualHouseholdRepo,
    getActiveHouseholdContext: async (userId: string) =>
        state.householdByUser.get(userId) ?? null,
    getHouseholdSeatCounts: async (householdId: string) =>
        state.seatCountsByHousehold.get(householdId) ?? {
            activeNonOwnerCount: 0,
            desiredSeatQuantity: 0,
        },
}));

const { createAccountRouter } = await import("../accounts/routes.js");
const { resolveAndroidEntitlements } =
    await import("./android-entitlements.js");
const { subscriptionProvidesPremium } = await import("./capabilities.js");
const { decideEntitlement } = await import("./entitlements.js");
const { getHouseholdSeatCoverage, ownerCanPurchaseHouseholdSeats } =
    await import("./household-seats.js");
const { chooseDirectSubscription } = await import("./subscription-sources.js");

afterAll(() => {
    mock.module("../auth/auth.js", () => actualAuth);
    mock.module("./repository.js", () => actualBillingRepo);
    mock.module("./store-repository.js", () => actualStoreRepo);
    mock.module("./override.js", () => actualOverride);
    mock.module("../households/repository.js", () => actualHouseholdRepo);
});

beforeEach(() => {
    setSystemTime(new Date(now));
    state.sessionUser = null;
    state.stripeByUser.clear();
    state.storeByUser.clear();
    state.overrideByUser.clear();
    state.householdByUser.clear();
    state.seatCountsByHousehold.clear();
    state.itemQuantityBySubAndPrice.clear();
});

afterEach(() => {
    setSystemTime();
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
});

function configureStripeEnv(extra: Record<string, string> = {}) {
    Object.assign(process.env, {
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/munch",
        MUNCH_APP_BASE_URL: "https://munch.example",
        STRIPE_SECRET_KEY: "sk_test_regressions",
        STRIPE_WEBHOOK_SECRET: "whsec_regressions",
        STRIPE_PRICE_ID: "price_current_399",
        STRIPE_HOUSEHOLD_MEMBER_PRICE_ID: "price_seat_199",
        ...extra,
    });
}

describe("W2 billing entitlement regressions", () => {
    test("Defect 1: active and trialing subscriptions past currentPeriodEnd do not provide Premium; past_due grace is unchanged", () => {
        // Expired active subscription must not grant Premium.
        expect(
            subscriptionProvidesPremium(
                { status: "active", currentPeriodEnd: pastDate },
                now,
            ),
        ).toBe(false);
        const expiredActiveDecision = decideEntitlement(
            { status: "active", currentPeriodEnd: pastDate },
            now,
        );
        expect(expiredActiveDecision.allowMcp).toBe(false);
        expect(expiredActiveDecision.reason).toBe("subscription_ended");

        // Expired trialing subscription must not grant Premium.
        expect(
            subscriptionProvidesPremium(
                { status: "trialing", currentPeriodEnd: pastDate },
                now,
            ),
        ).toBe(false);
        const expiredTrialDecision = decideEntitlement(
            { status: "trialing", currentPeriodEnd: pastDate },
            now,
        );
        expect(expiredTrialDecision.allowMcp).toBe(false);
        expect(expiredTrialDecision.reason).toBe("subscription_ended");

        // PR #302 grandfathering: trialing & active with future or null period end still grant Premium.
        expect(
            subscriptionProvidesPremium(
                { status: "active", currentPeriodEnd: futureDate },
                now,
            ),
        ).toBe(true);
        expect(
            subscriptionProvidesPremium(
                { status: "trialing", currentPeriodEnd: futureDate },
                now,
            ),
        ).toBe(true);
        expect(
            subscriptionProvidesPremium(
                { status: "trialing", currentPeriodEnd: null },
                now,
            ),
        ).toBe(true);

        // past_due grace behaviour unchanged.
        expect(
            subscriptionProvidesPremium(
                {
                    status: "past_due",
                    currentPeriodEnd: pastDate,
                    graceExpiresAt: futureDate,
                },
                now,
            ),
        ).toBe(true);
        expect(
            subscriptionProvidesPremium(
                {
                    status: "past_due",
                    currentPeriodEnd: pastDate,
                    graceExpiresAt: pastDate,
                },
                now,
            ),
        ).toBe(false);
        expect(
            decideEntitlement(
                {
                    status: "past_due",
                    currentPeriodEnd: pastDate,
                    graceExpiresAt: futureDate,
                },
                now,
            ).reason,
        ).toBe("past_due_grace");

        // Source selection does not rank an expired active row above an unexpired past_due grace row.
        const chosen = chooseDirectSubscription(
            [
                {
                    provider: "stripe",
                    status: "active",
                    currentPeriodEnd: pastDate,
                },
                {
                    provider: "google_play",
                    status: "past_due",
                    currentPeriodEnd: pastDate,
                    graceExpiresAt: futureDate,
                },
            ],
            now,
        );
        expect(chosen.provider).toBe("google_play");
    });

    test("Defect 2: GET /account reports Premium (not payment_required) for a Google Play-only subscriber", async () => {
        state.sessionUser = {
            id: "play-only-user",
            email: "play@example.test",
        };
        state.stripeByUser.set("play-only-user", null);
        state.storeByUser.set("play-only-user", {
            provider: "google_play",
            appId: "business.munch.app",
            productId: "munch_premium_monthly",
            status: "active",
            currentPeriodEnd: futureDate,
            graceExpiresAt: null,
            canceledAt: null,
            providerState: "SUBSCRIPTION_STATE_ACTIVE",
            acknowledged: true,
            verifiedAt: now,
        });

        const app = new Hono();
        app.route("/", createAccountRouter());
        const response = await app.request("https://munch.test/account");
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            subscription: {
                provider?: string | null;
                status: string | null;
            };
            entitlement: {
                allowMcp: boolean;
                canUseProtectedTools: boolean;
                reason: string;
            };
        };

        expect(body.subscription.provider).toBe("google_play");
        expect(body.subscription.status).toBe("active");
        expect(body.entitlement.allowMcp).toBe(true);
        expect(body.entitlement.canUseProtectedTools).toBe(true);
        expect(body.entitlement.reason).toBe("active");
    });

    test("Defect 3: override Premium and household-seat Premium both yield adFree", async () => {
        configureStripeEnv();

        // Tester-override user with no direct subscription.
        state.overrideByUser.set("override-user", true);
        expect(await resolveAndroidEntitlements("override-user")).toEqual({
            adFree: true,
        });

        // Household member covered by a paid owner seat, with no direct subscription or override.
        state.stripeByUser.set("owner-user", {
            stripeSubscriptionId: "sub_owner_1",
            stripePriceId: "price_current_399",
            status: "active",
            currentPeriodEnd: futureDate,
            graceExpiresAt: null,
        });
        state.householdByUser.set("member-user", {
            householdId: "hh-1",
            householdName: "Kitchen",
            ownerUserId: "owner-user",
            role: "member",
            displayName: "Member",
            androidFreeAccess: false,
        });
        state.seatCountsByHousehold.set("hh-1", {
            activeNonOwnerCount: 1,
            desiredSeatQuantity: 1,
        });
        state.itemQuantityBySubAndPrice.set("sub_owner_1:price_seat_199", 1);

        expect(await resolveAndroidEntitlements("member-user")).toEqual({
            adFree: true,
        });
    });

    test("Defect 4: grandfathered-price owner subscription yields household coverage (covered: true) while keeping seat-price check separate", async () => {
        configureStripeEnv({
            STRIPE_GRANDFATHERED_PRICE_IDS: "price_grandfathered_299",
        });

        state.stripeByUser.set("grandfathered-owner", {
            stripeSubscriptionId: "sub_legacy_299",
            stripePriceId: "price_grandfathered_299",
            status: "active",
            currentPeriodEnd: futureDate,
            graceExpiresAt: null,
        });
        state.seatCountsByHousehold.set("hh-legacy", {
            activeNonOwnerCount: 1,
            desiredSeatQuantity: 1,
        });
        state.itemQuantityBySubAndPrice.set("sub_legacy_299:price_seat_199", 1);

        const coverage = await getHouseholdSeatCoverage({
            ownerUserId: "grandfathered-owner",
            householdId: "hh-legacy",
        });
        expect(coverage).toEqual({
            ownerHasBillablePremium: true,
            activeNonOwnerCount: 1,
            billedSeatQuantity: 1,
            covered: true,
        });
        expect(
            await ownerCanPurchaseHouseholdSeats("grandfathered-owner"),
        ).toBe(true);

        // Member-seat price alone or unknown price must still not count as a billable owner plan.
        state.stripeByUser.set("seat-only-user", {
            stripeSubscriptionId: "sub_seat_only",
            stripePriceId: "price_seat_199",
            status: "active",
            currentPeriodEnd: futureDate,
            graceExpiresAt: null,
        });
        const seatOnlyCoverage = await getHouseholdSeatCoverage({
            ownerUserId: "seat-only-user",
            householdId: "hh-legacy",
        });
        expect(seatOnlyCoverage.ownerHasBillablePremium).toBe(false);
        expect(seatOnlyCoverage.covered).toBe(false);
    });

    test("Defect 1 boundary: currentPeriodEnd exactly at now does not provide Premium", () => {
        expect(
            subscriptionProvidesPremium(
                { status: "active", currentPeriodEnd: now },
                now,
            ),
        ).toBe(false);
        expect(
            subscriptionProvidesPremium(
                { status: "trialing", currentPeriodEnd: now },
                now,
            ),
        ).toBe(false);
        const decision = decideEntitlement(
            { status: "active", currentPeriodEnd: now },
            now,
        );
        expect(decision.allowMcp).toBe(false);
        expect(decision.reason).toBe("subscription_ended");
    });

    test("Defect 1 household: an expired active owner subscription yields no seat coverage", async () => {
        configureStripeEnv();
        state.stripeByUser.set("expired-owner", {
            stripeSubscriptionId: "sub_expired_owner",
            stripePriceId: "price_current_399",
            status: "active",
            currentPeriodEnd: pastDate,
            graceExpiresAt: null,
        });
        state.seatCountsByHousehold.set("hh-expired", {
            activeNonOwnerCount: 1,
            desiredSeatQuantity: 1,
        });
        state.itemQuantityBySubAndPrice.set(
            "sub_expired_owner:price_seat_199",
            1,
        );

        const coverage = await getHouseholdSeatCoverage({
            ownerUserId: "expired-owner",
            householdId: "hh-expired",
        });
        expect(coverage.ownerHasBillablePremium).toBe(false);
        expect(coverage.covered).toBe(false);
        expect(await ownerCanPurchaseHouseholdSeats("expired-owner")).toBe(
            false,
        );
    });

    test("Defect 2 composition: GET /account ends entitlement for a Play subscriber past period end", async () => {
        state.sessionUser = {
            id: "play-expired-user",
            email: "play-expired@example.test",
        };
        state.stripeByUser.set("play-expired-user", null);
        state.storeByUser.set("play-expired-user", {
            provider: "google_play",
            appId: "business.munch.app",
            productId: "munch_premium_monthly",
            status: "active",
            currentPeriodEnd: pastDate,
            graceExpiresAt: null,
            canceledAt: null,
            providerState: "SUBSCRIPTION_STATE_ACTIVE",
            acknowledged: true,
            verifiedAt: now,
        });

        const app = new Hono();
        app.route("/", createAccountRouter());
        const response = await app.request("https://munch.test/account");
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            subscription: { provider?: string | null; status: string | null };
            entitlement: { allowMcp: boolean; reason: string };
        };
        expect(body.subscription.provider).toBe("google_play");
        expect(body.subscription.status).toBe("active");
        expect(body.entitlement.allowMcp).toBe(false);
        expect(body.entitlement.reason).toBe("subscription_ended");
    });

    test("Defect 3 boundary: a member of a free Android household does not yield adFree", async () => {
        configureStripeEnv();
        state.householdByUser.set("android-free-member", {
            householdId: "hh-android-free",
            householdName: "Free Kitchen",
            ownerUserId: "android-free-owner",
            role: "member",
            displayName: "Free Member",
            androidFreeAccess: true,
        });
        state.seatCountsByHousehold.set("hh-android-free", {
            activeNonOwnerCount: 1,
            desiredSeatQuantity: 0,
        });

        expect(await resolveAndroidEntitlements("android-free-member")).toEqual(
            { adFree: false },
        );
    });
});
