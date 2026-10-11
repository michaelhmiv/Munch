import { describe, expect, test } from "bun:test";
import { androidEntitlementsFromLegacyStripePremium } from "./android-entitlements.js";

const now = new Date("2026-10-10T12:00:00.000Z");

describe("Android ad-free entitlement", () => {
    test("maps active and trialing legacy Stripe Premium to ad-free access", () => {
        expect(
            androidEntitlementsFromLegacyStripePremium(
                { status: "active" },
                now,
            ),
        ).toEqual({ adFree: true });
        expect(
            androidEntitlementsFromLegacyStripePremium(
                { status: "trialing" },
                now,
            ),
        ).toEqual({ adFree: true });
    });

    test("keeps ad-free access during the existing paid grace period", () => {
        expect(
            androidEntitlementsFromLegacyStripePremium(
                {
                    status: "past_due",
                    graceExpiresAt: new Date("2026-10-10T12:01:00.000Z"),
                },
                now,
            ),
        ).toEqual({ adFree: true });
    });

    test("does not grant ad-free access after Stripe Premium ends", () => {
        for (const status of [
            null,
            "canceled",
            "unpaid",
            "paused",
            "incomplete",
        ] as const) {
            expect(
                androidEntitlementsFromLegacyStripePremium({ status }, now),
            ).toEqual({ adFree: false });
        }
        expect(
            androidEntitlementsFromLegacyStripePremium(
                {
                    status: "past_due",
                    graceExpiresAt: new Date("2026-10-10T11:59:00.000Z"),
                },
                now,
            ),
        ).toEqual({ adFree: false });
    });

    test("fails closed without a verified Stripe subscription", () => {
        expect(androidEntitlementsFromLegacyStripePremium(null, now)).toEqual({
            adFree: false,
        });
    });
});
