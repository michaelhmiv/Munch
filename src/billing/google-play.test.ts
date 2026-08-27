import { describe, expect, test } from "bun:test";
import {
    googlePlayObfuscatedAccountId,
    GooglePlayVerificationError,
    normalizeGooglePlaySubscription,
} from "./google-play.js";

const productId = "munch_premium_monthly";
const basePlanId = "monthly";
const now = new Date("2026-08-27T12:00:00.000Z");

function purchase(state: string, expiry = "2026-09-27T12:00:00.000Z") {
    return {
        startTime: "2026-08-27T12:00:00.000Z",
        subscriptionState: state,
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
        lineItems: [
            {
                productId,
                expiryTime: expiry,
                latestSuccessfulOrderId: "GPA.1234-5678-9012-34567",
                offerDetails: { basePlanId },
            },
        ],
    };
}

describe("Google Play subscription verification primitives", () => {
    test("uses a deterministic 64-character non-PII account hash", () => {
        const first = googlePlayObfuscatedAccountId(
            "d5076d27-02f8-4b9a-a243-58cbd65ff6aa",
        );
        const second = googlePlayObfuscatedAccountId(
            "d5076d27-02f8-4b9a-a243-58cbd65ff6aa",
        );
        expect(first).toBe(second);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(first).not.toContain("d5076d27");
    });

    test("maps active Play subscriptions to active Premium state", () => {
        const result = normalizeGooglePlaySubscription(
            purchase("SUBSCRIPTION_STATE_ACTIVE"),
            productId,
            basePlanId,
            now,
        );
        expect(result.status).toBe("active");
        expect(result.acknowledged).toBe(false);
        expect(result.currentPeriodEnd?.toISOString()).toBe(
            "2026-09-27T12:00:00.000Z",
        );
    });

    test("maps grace period to past-due with an entitlement deadline", () => {
        const result = normalizeGooglePlaySubscription(
            purchase("SUBSCRIPTION_STATE_IN_GRACE_PERIOD"),
            productId,
            basePlanId,
            now,
        );
        expect(result.status).toBe("past_due");
        expect(result.graceExpiresAt?.toISOString()).toBe(
            "2026-09-27T12:00:00.000Z",
        );
    });

    test("keeps canceled subscriptions active only until their paid expiry", () => {
        expect(
            normalizeGooglePlaySubscription(
                purchase("SUBSCRIPTION_STATE_CANCELED"),
                productId,
                basePlanId,
                now,
            ).status,
        ).toBe("active");
        expect(
            normalizeGooglePlaySubscription(
                purchase(
                    "SUBSCRIPTION_STATE_CANCELED",
                    "2026-08-26T12:00:00.000Z",
                ),
                productId,
                basePlanId,
                now,
            ).status,
        ).toBe("canceled");
    });

    test("does not grant active state for pending, hold, paused, or expired purchases", () => {
        const cases = [
            ["SUBSCRIPTION_STATE_PENDING", "incomplete"],
            ["SUBSCRIPTION_STATE_ON_HOLD", "unpaid"],
            ["SUBSCRIPTION_STATE_PAUSED", "paused"],
            ["SUBSCRIPTION_STATE_EXPIRED", "canceled"],
            [
                "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED",
                "incomplete_expired",
            ],
        ] as const;
        for (const [state, expected] of cases) {
            expect(
                normalizeGooglePlaySubscription(
                    purchase(state),
                    productId,
                    basePlanId,
                    now,
                ).status,
            ).toBe(expected);
        }
    });

    test("rejects a different subscription product or base plan", () => {
        expect(() =>
            normalizeGooglePlaySubscription(
                {
                    ...purchase("SUBSCRIPTION_STATE_ACTIVE"),
                    lineItems: [
                        {
                            productId: "other_product",
                            expiryTime: "2026-09-27T12:00:00.000Z",
                            offerDetails: { basePlanId },
                        },
                    ],
                },
                productId,
                basePlanId,
                now,
            ),
        ).toThrow(GooglePlayVerificationError);
        expect(() =>
            normalizeGooglePlaySubscription(
                {
                    ...purchase("SUBSCRIPTION_STATE_ACTIVE"),
                    lineItems: [
                        {
                            productId,
                            expiryTime: "2026-09-27T12:00:00.000Z",
                            offerDetails: { basePlanId: "annual" },
                        },
                    ],
                },
                productId,
                basePlanId,
                now,
            ),
        ).toThrow(GooglePlayVerificationError);
    });
});
