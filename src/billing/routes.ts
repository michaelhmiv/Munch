import { Hono } from "hono";
import { verifyStripeWebhookSignature } from "./stripe-webhook.js";
import { processStripeWebhook } from "./webhook-service.js";

export function createBillingRouter(): Hono {
    const billing = new Hono();

    billing.post("/webhooks/stripe", async (c) => {
        const signature = c.req.header("stripe-signature");
        const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
        if (!signature || !secret) {
            return c.json({ error: "invalid_webhook_configuration" }, 400);
        }

        const rawPayload = await c.req.text();
        try {
            verifyStripeWebhookSignature(rawPayload, signature, secret);
        } catch {
            return c.json({ error: "invalid_webhook_signature" }, 400);
        }

        try {
            const result = await processStripeWebhook(rawPayload);
            return c.json({ received: true, result });
        } catch {
            console.error("Stripe webhook processing failed");
            return c.json({ error: "webhook_processing_failed" }, 500);
        }
    });

    return billing;
}
