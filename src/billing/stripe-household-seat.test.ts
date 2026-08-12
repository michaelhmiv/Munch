import { afterEach, describe, expect, mock, test } from "bun:test";
import { setStripeSubscriptionItemQuantity } from "./stripe-client.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.STRIPE_SECRET_KEY;

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalKey;
});

function subscription(quantity?: number) {
    return {
        id: "sub_munch",
        customer: "cus_munch",
        status: "active",
        items: {
            data:
                quantity === undefined
                    ? [
                          {
                              id: "si_base",
                              quantity: 1,
                              price: { id: "price_premium" },
                          },
                      ]
                    : [
                          {
                              id: "si_base",
                              quantity: 1,
                              price: { id: "price_premium" },
                          },
                          {
                              id: "si_household",
                              quantity,
                              price: { id: "price_household" },
                          },
                      ],
        },
    };
}

describe("Stripe household seats", () => {
    test("adds the household price with immediate proration", async () => {
        process.env.STRIPE_SECRET_KEY = "sk_test_munch";
        let encoded = "";
        let idempotency = "";
        let calls = 0;
        globalThis.fetch = mock(async (_url, init) => {
            calls += 1;
            if (calls === 1) {
                return new Response(JSON.stringify(subscription()), {
                    status: 200,
                });
            }
            encoded = String(init?.body ?? "");
            idempotency = String(
                (init?.headers as Record<string, string>)?.[
                    "Idempotency-Key"
                ] ?? "",
            );
            return new Response(JSON.stringify(subscription(1)), {
                status: 200,
            });
        }) as unknown as typeof fetch;

        await setStripeSubscriptionItemQuantity({
            subscriptionId: "sub_munch",
            priceId: "price_household",
            quantity: 1,
            idempotencyKey: "household-add-1",
        });

        const params = new URLSearchParams(encoded);
        expect(params.get("items[0][price]")).toBe("price_household");
        expect(params.get("items[0][quantity]")).toBe("1");
        expect(params.get("proration_behavior")).toBe("always_invoice");
        expect(params.get("payment_behavior")).toBe("error_if_incomplete");
        expect(params.get("off_session")).toBe("true");
        expect(idempotency).toBe("household-add-1");
    });

    test("reduces an existing household item with prorated credit", async () => {
        process.env.STRIPE_SECRET_KEY = "sk_test_munch";
        let encoded = "";
        let calls = 0;
        globalThis.fetch = mock(async (_url, init) => {
            calls += 1;
            if (calls === 1) {
                return new Response(JSON.stringify(subscription(2)), {
                    status: 200,
                });
            }
            encoded = String(init?.body ?? "");
            return new Response(JSON.stringify(subscription(1)), {
                status: 200,
            });
        }) as unknown as typeof fetch;

        await setStripeSubscriptionItemQuantity({
            subscriptionId: "sub_munch",
            priceId: "price_household",
            quantity: 1,
            idempotencyKey: "household-remove-1",
        });

        const params = new URLSearchParams(encoded);
        expect(params.get("items[0][id]")).toBe("si_household");
        expect(params.get("items[0][quantity]")).toBe("1");
        expect(params.get("proration_behavior")).toBe("create_prorations");
    });

    test("deletes the household subscription item when the last member leaves", async () => {
        process.env.STRIPE_SECRET_KEY = "sk_test_munch";
        let encoded = "";
        let calls = 0;
        globalThis.fetch = mock(async (_url, init) => {
            calls += 1;
            if (calls === 1) {
                return new Response(JSON.stringify(subscription(1)), {
                    status: 200,
                });
            }
            encoded = String(init?.body ?? "");
            return new Response(JSON.stringify(subscription()), {
                status: 200,
            });
        }) as unknown as typeof fetch;

        await setStripeSubscriptionItemQuantity({
            subscriptionId: "sub_munch",
            priceId: "price_household",
            quantity: 0,
            idempotencyKey: "household-remove-last",
        });

        const params = new URLSearchParams(encoded);
        expect(params.get("items[0][id]")).toBe("si_household");
        expect(params.get("items[0][deleted]")).toBe("true");
    });
});
