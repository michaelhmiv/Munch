import { Hono } from "hono";
import { requireSameOrigin } from "../accounts/csrf.js";
import { safeLocalRedirectPath } from "../accounts/redirect.js";
import { requireWebSession } from "../accounts/session.js";
import { PRODUCT_CONFIG } from "../product-config.js";
import {
    createCheckoutForUser,
    createCustomerPortalForUser,
    verifyCheckoutForUser,
} from "./checkout-service.js";
import { GooglePlayApiError } from "./google-play-client.js";
import { googlePlayBillingConfigured } from "./google-play-config.js";
import {
    googlePlayObfuscatedAccountId,
    GooglePlayVerificationError,
    verifyGooglePlayPremium,
} from "./google-play.js";
import { StripeRequestError } from "./stripe-client.js";
import { getDirectSubscriptionSnapshot } from "./subscription-sources.js";
import { verifyStripeWebhookSignature } from "./stripe-webhook.js";
import { processStripeWebhook } from "./webhook-service.js";

function checkoutFailureReason(error: unknown): string {
    if (error instanceof StripeRequestError) {
        return `stripe_${error.code}`;
    }
    if (error instanceof Error) {
        return error.message.replace(/\s+/g, "_").toLowerCase().slice(0, 120);
    }
    return "unknown_error";
}

function logCheckoutFailure(error: unknown, reason: string): void {
    if (error instanceof StripeRequestError) {
        const message = error.stripeMessage
            ?.replace(/[\r\n]+/g, " ")
            .slice(0, 300);
        console.error(
            `[billing] checkout_failed reason=${reason} status=${error.status} code=${error.code} param=${error.param ?? "unknown"} request_id=${error.requestId ?? "unknown"}${message ? ` stripe_message=${JSON.stringify(message)}` : ""}`,
        );
        return;
    }
    console.error(`[billing] checkout_failed reason=${reason}`);
}

function playVerificationStatus(error: GooglePlayVerificationError): 400 | 409 {
    return error.code === "google_play_purchase_already_claimed" ? 409 : 400;
}

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

    billing.get("/billing/google-play/config", requireWebSession, async (c) => {
        if (c.get("munchAuthTransport") !== "bearer") {
            return c.json({ error: "installed_app_required" }, 403);
        }
        const userId = c.get("munchUserId");
        const subscription = await getDirectSubscriptionSnapshot(userId);
        return c.json(
            {
                configured: googlePlayBillingConfigured(),
                packageName: PRODUCT_CONFIG.googlePlayPackageName,
                productId: PRODUCT_CONFIG.googlePlayPremiumProductId,
                basePlanId: PRODUCT_CONFIG.googlePlayPremiumBasePlanId,
                obfuscatedAccountId: googlePlayObfuscatedAccountId(userId),
                currentSubscription: {
                    provider: subscription.provider,
                    status: subscription.status,
                    currentPeriodEnd:
                        subscription.currentPeriodEnd?.toISOString() ?? null,
                },
            },
            200,
            { "Cache-Control": "no-store, private" },
        );
    });

    billing.post(
        "/billing/google-play/verify",
        requireWebSession,
        async (c) => {
            if (c.get("munchAuthTransport") !== "bearer") {
                return c.json({ error: "installed_app_required" }, 403);
            }
            if (!googlePlayBillingConfigured()) {
                return c.json(
                    { error: "google_play_billing_not_configured" },
                    503,
                );
            }

            let purchaseToken = "";
            try {
                const body = (await c.req.json()) as {
                    purchase_token?: unknown;
                };
                purchaseToken =
                    typeof body.purchase_token === "string"
                        ? body.purchase_token.trim()
                        : "";
            } catch {
                return c.json({ error: "invalid_request" }, 400);
            }

            try {
                const verified = await verifyGooglePlayPremium({
                    userId: c.get("munchUserId"),
                    purchaseToken,
                });
                return c.json(
                    {
                        provider: verified.provider,
                        productId: verified.productId,
                        status: verified.status,
                        currentPeriodEnd:
                            verified.currentPeriodEnd?.toISOString() ?? null,
                        graceExpiresAt:
                            verified.graceExpiresAt?.toISOString() ?? null,
                        acknowledged: verified.acknowledged,
                        testPurchase: verified.testPurchase,
                    },
                    200,
                    { "Cache-Control": "no-store, private" },
                );
            } catch (error) {
                if (error instanceof GooglePlayVerificationError) {
                    return c.json(
                        { error: error.code },
                        playVerificationStatus(error),
                    );
                }
                if (error instanceof GooglePlayApiError) {
                    console.error(
                        `[billing] google_play_api_failed status=${error.status} code=${error.code}`,
                    );
                    return c.json(
                        { error: "google_play_verification_unavailable" },
                        502,
                    );
                }
                console.error("[billing] google_play_verification_failed");
                return c.json(
                    { error: "google_play_verification_unavailable" },
                    503,
                );
            }
        },
    );

    billing.post(
        "/billing/checkout",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            let returnTo: string | undefined;
            try {
                const body = (await c.req.json()) as { returnTo?: unknown };
                if (typeof body.returnTo === "string") {
                    returnTo = safeLocalRedirectPath(body.returnTo);
                }
            } catch {
                // An empty body is valid for ordinary account checkout.
            }

            try {
                const checkout = await createCheckoutForUser({
                    userId: c.get("munchUserId"),
                    successReturnTo: returnTo,
                    cancelReturnTo: returnTo,
                });
                return c.json(checkout);
            } catch (error) {
                const reason = checkoutFailureReason(error);
                logCheckoutFailure(error, reason);
                return c.json(
                    {
                        error: "billing_checkout_unavailable",
                        reason,
                    },
                    503,
                );
            }
        },
    );

    billing.get("/billing/success", requireWebSession, async (c) => {
        const sessionId = c.req.query("session_id");
        if (!sessionId) {
            return c.json({ error: "checkout_session_required" }, 400);
        }

        try {
            await verifyCheckoutForUser(c.get("munchUserId"), sessionId);
            return c.redirect(
                safeLocalRedirectPath(c.req.query("return_to")),
                303,
            );
        } catch {
            return c.json({ error: "checkout_verification_failed" }, 400);
        }
    });

    billing.get("/billing/canceled", requireWebSession, (c) =>
        c.redirect(safeLocalRedirectPath(c.req.query("return_to")), 303),
    );

    billing.post(
        "/billing/portal",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            try {
                const portal = await createCustomerPortalForUser(
                    c.get("munchUserId"),
                );
                return c.json(portal);
            } catch {
                return c.json({ error: "billing_portal_unavailable" }, 409);
            }
        },
    );

    return billing;
}
