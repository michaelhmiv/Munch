import { describe, expect, test } from "bun:test";
import { assertUsableSubscriptionPrice } from "./checkout-service.js";
import type { StripePrice } from "./stripe-client.js";

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
