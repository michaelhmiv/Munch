import { describe, expect, test } from "bun:test";
import {
    androidFreeBaselineCapabilities,
    capabilitiesFromSubscription,
    failClosedMunchCapabilities,
    FREE_HISTORY_DAYS,
    FREE_SAVED_FOOD_LIMIT,
} from "./capabilities.js";

const now = new Date("2026-08-04T17:00:00.000Z");

describe("Munch capability resolution", () => {
    test("includes all non-AI Android features in the free baseline", () => {
        const result = androidFreeBaselineCapabilities(null, "android-user");
        expect(result.tier).toBe("free");
        expect(result.entitlementSource).toBe("android_free_baseline");
        expect(result.historyDays).toBeNull();
        expect(result.savedFoodLimit).toBeNull();
        expect(result.personalRecipesRead).toBe(true);
        expect(result.personalRecipesWrite).toBe(true);
        expect(result.personalPlanningRead).toBe(true);
        expect(result.personalPlanningWrite).toBe(true);
        expect(result.householdRead).toBe(false);
        expect(result.householdWrite).toBe(false);
    });

    test("keeps Android household permissions aligned with membership roles", () => {
        const base = {
            householdId: "household-id",
            householdName: "Shared",
            ownerUserId: "android-user",
            role: "owner" as const,
            displayName: "Owner",
        };
        const owner = androidFreeBaselineCapabilities(base, "android-user");
        const member = androidFreeBaselineCapabilities(
            {
                ...base,
                ownerUserId: "other",
                role: "member",
                displayName: "Member",
            },
            "android-user",
        );
        const viewer = androidFreeBaselineCapabilities(
            {
                ...base,
                ownerUserId: "other",
                role: "viewer",
                displayName: "Viewer",
            },
            "android-user",
        );

        expect(owner.householdWrite).toBe(true);
        expect(owner.householdManage).toBe(true);
        expect(member.householdRead).toBe(true);
        expect(member.householdWrite).toBe(true);
        expect(member.householdManage).toBe(false);
        expect(viewer.householdRead).toBe(true);
        expect(viewer.householdWrite).toBe(false);
        expect(viewer.householdManage).toBe(false);
    });

    test("gives permanent core access without a subscription", () => {
        const result = capabilitiesFromSubscription({ status: null }, now);
        expect(result.tier).toBe("free");
        expect(result.coreNutrition).toBe(true);
        expect(result.historyDays).toBe(FREE_HISTORY_DAYS);
        expect(result.savedFoodLimit).toBe(FREE_SAVED_FOOD_LIMIT);
        expect(result.personalRecipesWrite).toBe(false);
        expect(result.householdWrite).toBe(false);
    });

    test("gives direct premium capabilities to active and trialing users", () => {
        for (const status of ["active", "trialing"] as const) {
            const result = capabilitiesFromSubscription({ status }, now);
            expect(result.tier).toBe("premium");
            expect(result.historyDays).toBeNull();
            expect(result.savedFoodLimit).toBeNull();
            expect(result.personalRecipesWrite).toBe(true);
            expect(result.personalPlanningWrite).toBe(true);
        }
    });

    test("honors only an unexpired past-due grace period", () => {
        expect(
            capabilitiesFromSubscription(
                {
                    status: "past_due",
                    graceExpiresAt: new Date("2026-08-05T00:00:00.000Z"),
                },
                now,
            ).tier,
        ).toBe("premium");
        expect(
            capabilitiesFromSubscription(
                {
                    status: "past_due",
                    graceExpiresAt: new Date("2026-08-03T00:00:00.000Z"),
                },
                now,
            ).tier,
        ).toBe("free");
    });

    test("never removes core access for ended Stripe states", () => {
        for (const status of [
            "incomplete",
            "incomplete_expired",
            "past_due",
            "canceled",
            "unpaid",
            "paused",
        ] as const) {
            const result = capabilitiesFromSubscription({ status }, now);
            expect(result.coreNutrition).toBe(true);
            expect(result.tier).toBe("free");
        }
    });

    test("fails closed for gated features when capability lookup is unavailable", () => {
        const result = failClosedMunchCapabilities();
        expect(result.coreNutrition).toBe(true);
        expect(result.personalRecipesRead).toBe(false);
        expect(result.personalRecipesWrite).toBe(false);
        expect(result.personalPlanningRead).toBe(false);
        expect(result.personalPlanningWrite).toBe(false);
        expect(result.householdRead).toBe(false);
        expect(result.householdWrite).toBe(false);
    });
});
