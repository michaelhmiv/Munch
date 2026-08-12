import { Hono } from "hono";
import { requireSameOrigin } from "../accounts/csrf.js";
import { requireWebSession } from "../accounts/session.js";
import { getMunchBetterAuth } from "../auth/auth.js";
import { getBetterAuthRuntimeConfig } from "../auth/config.js";
import { resolveMunchCapabilities } from "../billing/capabilities.js";
import {
    acceptPaidHouseholdInvitation,
    ownerCanPurchaseHouseholdSeats,
    removePaidHouseholdMember,
} from "../billing/household-seats.js";
import { StripeRequestError } from "../billing/stripe-client.js";
import { sendHouseholdInvitation } from "./email.js";
import {
    createHousehold,
    createHouseholdInvitation,
    getActiveHouseholdContext,
    listHouseholdMembers,
    updateHouseholdMemberRole,
} from "./repository.js";

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function jsonError(c: any, error: unknown) {
    if (error instanceof StripeRequestError) {
        const status = error.status === 402 ? 402 : 503;
        return c.json(
            {
                error:
                    error.status === 402
                        ? "household_seat_payment_failed"
                        : "household_billing_unavailable",
            },
            status,
        );
    }
    const message = error instanceof Error ? error.message : "Request failed";
    const status =
        message.includes("not found") || message.includes("invalid or expired")
            ? 404
            : message.includes("already") || message.includes("limit")
              ? 409
              : message.includes("different email")
                ? 403
                : message.includes("paid_premium_required")
                  ? 403
                  : 400;
    return c.json({ error: message }, status);
}

async function directPremiumRequired(c: any, userId: string) {
    const capabilities = await resolveMunchCapabilities(userId);
    if (
        capabilities.tier === "premium" &&
        capabilities.entitlementSource !== "household_subscription"
    ) {
        return null;
    }
    return c.json({ error: "direct_premium_required" }, 403);
}

export function createHouseholdRouter(): Hono {
    const router = new Hono();

    router.get("/account/household", requireWebSession, async (c) => {
        const userId = c.get("munchUserId");
        const household = await getActiveHouseholdContext(userId);
        return c.json({
            household,
            members: household
                ? await listHouseholdMembers(userId, household.householdId)
                : [],
        });
    });

    router.post(
        "/account/household/create",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            try {
                const userId = c.get("munchUserId");
                const denied = await directPremiumRequired(c, userId);
                if (denied) return denied;

                const body = (await c.req.json()) as {
                    name?: unknown;
                    display_name?: unknown;
                };
                if (
                    typeof body.name !== "string" ||
                    typeof body.display_name !== "string"
                ) {
                    return c.json(
                        { error: "name_and_display_name_required" },
                        400,
                    );
                }
                return c.json({
                    household: await createHousehold({
                        userId,
                        name: body.name,
                        displayName: body.display_name,
                    }),
                });
            } catch (error) {
                return jsonError(c, error);
            }
        },
    );

    router.post(
        "/account/household/invite",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            try {
                const userId = c.get("munchUserId");
                const denied = await directPremiumRequired(c, userId);
                if (denied) return denied;

                const body = (await c.req.json()) as {
                    email?: unknown;
                    role?: unknown;
                };
                const household = await getActiveHouseholdContext(userId);
                if (!household || household.role !== "owner") {
                    return c.json({ error: "household_owner_required" }, 403);
                }
                if (!(await ownerCanPurchaseHouseholdSeats(userId))) {
                    return c.json(
                        { error: "household_owner_paid_premium_required" },
                        403,
                    );
                }
                if (
                    typeof body.email !== "string" ||
                    (body.role !== "member" && body.role !== "viewer")
                ) {
                    return c.json(
                        { error: "valid_email_and_role_required" },
                        400,
                    );
                }
                const invitation = await createHouseholdInvitation({
                    userId,
                    householdId: household.householdId,
                    email: body.email,
                    role: body.role,
                });
                const baseUrl = getBetterAuthRuntimeConfig().baseUrl;
                const acceptUrl = new URL("/household/accept", baseUrl);
                acceptUrl.searchParams.set("token", invitation.rawToken);
                await sendHouseholdInvitation({
                    email: body.email.trim().toLowerCase(),
                    householdName: household.householdName,
                    invitedByDisplayName: household.displayName,
                    acceptUrl: acceptUrl.toString(),
                    expiresAt: invitation.expiresAt,
                });
                return c.json({
                    invited: true,
                    invitation_id: invitation.invitationId,
                    expires_at: invitation.expiresAt,
                    charge_on_accept_cents: 200,
                });
            } catch (error) {
                return jsonError(c, error);
            }
        },
    );

    router.get("/household/accept", async (c) => {
        const token = c.req.query("token") ?? "";
        if (!token || token.length > 200) {
            return c.html("Invalid invitation.", 400);
        }
        const session = await getMunchBetterAuth().api.getSession({
            headers: c.req.raw.headers,
        });
        const returnTo = `/household/accept?token=${encodeURIComponent(token)}`;
        if (!session?.user) {
            return c.redirect(
                `/account/login?return_to=${encodeURIComponent(returnTo)}`,
                303,
            );
        }
        return c.html(
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join household — Munch</title><link rel="stylesheet" href="/styles.css"></head><body class="auth-page"><main class="auth-main"><section class="auth-card"><p class="section-kicker">Munch household</p><h1>Join this household</h1><p>The household owner pays $2/month for your Premium seat when you accept. Your personal meals, macros, water, weight, and goals stay private. Household recipes, meal plans, and grocery lists are shared automatically while you are a member.</p><p class="tiny">The household sharing relationship is part of the discounted seat and cannot be disabled independently. Leaving the household ends this household-provided Premium access.</p><form class="auth-form" method="post" action="/household/accept"><input type="hidden" name="token" value="${escapeHtml(token)}"><div class="field"><label for="display-name">Display name</label><input id="display-name" name="display_name" required maxlength="80"></div><button class="button button-primary" type="submit">Accept and join household</button></form></section></main></body></html>`,
        );
    });

    router.post(
        "/household/accept",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            try {
                const body = await c.req.parseBody();
                if (
                    typeof body.token !== "string" ||
                    typeof body.display_name !== "string"
                ) {
                    return c.json(
                        { error: "token_and_display_name_required" },
                        400,
                    );
                }
                await acceptPaidHouseholdInvitation({
                    userId: c.get("munchUserId"),
                    token: body.token,
                    displayName: body.display_name,
                });
                return c.redirect("/app/household", 303);
            } catch (error) {
                return jsonError(c, error);
            }
        },
    );

    router.post(
        "/account/household/member/role",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            try {
                const userId = c.get("munchUserId");
                const body = (await c.req.json()) as {
                    membership_id?: unknown;
                    role?: unknown;
                };
                const household = await getActiveHouseholdContext(userId);
                if (!household || household.role !== "owner") {
                    return c.json({ error: "household_owner_required" }, 403);
                }
                if (
                    typeof body.membership_id !== "string" ||
                    (body.role !== "member" && body.role !== "viewer")
                ) {
                    return c.json(
                        { error: "membership_and_role_required" },
                        400,
                    );
                }
                return c.json({
                    updated: await updateHouseholdMemberRole({
                        userId,
                        householdId: household.householdId,
                        membershipId: body.membership_id,
                        role: body.role,
                    }),
                });
            } catch (error) {
                return jsonError(c, error);
            }
        },
    );

    router.post(
        "/account/household/member/remove",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            try {
                const userId = c.get("munchUserId");
                const body = (await c.req.json()) as {
                    membership_id?: unknown;
                };
                const household = await getActiveHouseholdContext(userId);
                if (!household || household.role !== "owner") {
                    return c.json({ error: "household_owner_required" }, 403);
                }
                if (typeof body.membership_id !== "string") {
                    return c.json({ error: "membership_required" }, 400);
                }
                return c.json({
                    removed: await removePaidHouseholdMember({
                        ownerUserId: userId,
                        householdId: household.householdId,
                        membershipId: body.membership_id,
                    }),
                });
            } catch (error) {
                return jsonError(c, error);
            }
        },
    );

    return router;
}
