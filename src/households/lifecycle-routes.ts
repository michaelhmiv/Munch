import { Hono } from "hono";
import { requireSameOrigin } from "../accounts/csrf.js";
import { requireWebSession } from "../accounts/session.js";
import {
    dissolvePaidHousehold,
    leavePaidHousehold,
} from "../billing/household-seats.js";
import { StripeRequestError } from "../billing/stripe-client.js";
import { getActiveHouseholdContext } from "./repository.js";

function failure(c: any, error: unknown) {
    if (error instanceof StripeRequestError) {
        return c.json({ error: "household_billing_unavailable" }, 503);
    }
    const message = error instanceof Error ? error.message : "Request failed";
    const status = message.includes("owner required") ? 403 : 400;
    return c.json({ error: message }, status);
}

export function createHouseholdLifecycleRouter(): Hono {
    const router = new Hono();

    router.post(
        "/account/household/transfer",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            // Paid household ownership is also Stripe billing ownership. We do
            // not silently move a recurring subscription between customers.
            // Owners can dissolve the household and the intended new owner can
            // create a new one from their own Premium account.
            return c.json(
                { error: "paid_household_ownership_transfer_not_supported" },
                409,
            );
        },
    );

    router.post(
        "/account/household/leave",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            try {
                const body = (await c.req.json()) as { confirm?: unknown };
                if (body.confirm !== true) {
                    return c.json({ error: "confirmation_required" }, 400);
                }
                return c.json({
                    left: await leavePaidHousehold(c.get("munchUserId")),
                });
            } catch (error) {
                return failure(c, error);
            }
        },
    );

    router.post(
        "/account/household/dissolve",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            try {
                const body = (await c.req.json()) as {
                    confirmation?: unknown;
                };
                if (body.confirmation !== "DISSOLVE HOUSEHOLD") {
                    return c.json(
                        { error: "dissolution_confirmation_required" },
                        400,
                    );
                }
                const userId = c.get("munchUserId");
                const household = await getActiveHouseholdContext(userId);
                if (!household || household.role !== "owner") {
                    return c.json({ error: "household_owner_required" }, 403);
                }
                return c.json({
                    dissolved: await dissolvePaidHousehold({
                        ownerUserId: userId,
                        householdId: household.householdId,
                    }),
                });
            } catch (error) {
                return failure(c, error);
            }
        },
    );

    return router;
}
