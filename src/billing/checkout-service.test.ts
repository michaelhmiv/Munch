import { describe, expect, test } from "bun:test";
import {
    assertUsableSubscriptionPrice,
    shouldRetryCheckoutWithoutStoredCustomer,
} from "./checkout-service.js";
import { StripeRequestError, type StripePrice } from "./stripe-client.js";

function price(overrides: Partial<StripePrice> = {}): StripePrice {
    return {
        id: "price_munch_monthly",
        active: true,
        livemode: true,
        type: "recurring",
        recurring: { interval: "month", interval_count: 1 },
        ...overrides,
    };
}

describe("premium checkout price validation", () => {
    test("accepts an active recurring price", () => {
        expect(() => assertUsableSubscriptionPrice(price())).not.toThrow();
    });

    test("rejects an inactive price", () => {
        expect(() =>
            assertUsableSubscriptionPrice(price({ active: false })),
        ).toThrow("Configured Stripe price is inactive");
    });

    test("rejects a one-time price", () => {
        expect(() =>
            assertUsableSubscriptionPrice(
                price({ type: "one_time", recurring: null }),
            ),
        ).toThrow("Configured Stripe price is not recurring");
    });
});

describe("stale Stripe customer recovery", () => {
    test("retries a stored customer rejected by Stripe invalid request", () => {
        expect(
            shouldRetryCheckoutWithoutStoredCustomer(
                "cus_legacy",
                new StripeRequestError(
                    "stripe_invalid_request_error",
                    400,
                    "No such customer",
                    "customer",
                ),
            ),
        ).toBe(true);
    });

    test("retries resource-missing responses for a stored customer", () => {
        expect(
            shouldRetryCheckoutWithoutStoredCustomer(
                "cus_legacy",
                new StripeRequestError("resource_missing", 404),
            ),
        ).toBe(true);
    });

    test("does not retry when there is no stored customer", () => {
        expect(
            shouldRetryCheckoutWithoutStoredCustomer(
                null,
                new StripeRequestError("stripe_invalid_request_error", 400),
            ),
        ).toBe(false);
    });

    test("does not retry server-side Stripe failures", () => {
        expect(
            shouldRetryCheckoutWithoutStoredCustomer(
                "cus_existing",
                new StripeRequestError("api_error", 500),
            ),
        ).toBe(false);
    });
});
