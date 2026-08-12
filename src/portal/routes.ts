import { Hono } from "hono";
import { requireSameOrigin } from "../accounts/csrf.js";
import { clearWebSession, requireWebSession } from "../accounts/session.js";
import { getRailwayExportFile } from "../export.js";
import { deleteAllUserData, upsertProfile } from "../storage.js";
import { revokeOAuthConnection } from "./repository.js";

function isTimezone(value: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
        return true;
    } catch {
        return false;
    }
}

export function createPortalRouter(): Hono {
    const portal = new Hono();

    portal.use("*", async (c, next) => {
        await next();
        c.header("Cache-Control", "private, no-store");
        c.header("Pragma", "no-cache");
    });

    // The old account portal is retained only as a compatibility URL. All
    // user-facing account controls now live inside the unified Munch app.
    portal.get("/account/portal", requireWebSession, (c) =>
        c.redirect("/app/settings", 303),
    );

    // Compatibility endpoint for older website clients. The primary app uses
    // /api/app/preferences, which has the same profile semantics.
    portal.post(
        "/account/portal/preferences",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            const body = (await c.req.json()) as Record<string, unknown>;
            const timezone =
                typeof body.timezone === "string" ? body.timezone.trim() : "";
            if (!timezone || !isTimezone(timezone)) {
                return c.json({ error: "invalid_timezone" }, 400);
            }
            const weightUnit = body.preferred_weight_unit;
            const drinkUnit = body.preferred_drink_unit;
            if (
                weightUnit !== null &&
                weightUnit !== "kg" &&
                weightUnit !== "lb"
            ) {
                return c.json({ error: "invalid_weight_unit" }, 400);
            }
            if (
                drinkUnit !== null &&
                drinkUnit !== "us" &&
                drinkUnit !== "uk"
            ) {
                return c.json({ error: "invalid_drink_unit" }, 400);
            }
            const profile = await upsertProfile(c.get("munchUserId"), {
                timezone,
                preferred_weight_unit: weightUnit,
                widgets_enabled: body.widgets_enabled === true,
                alcohol_tracking_enabled:
                    body.alcohol_tracking_enabled === true,
                preferred_drink_unit: drinkUnit,
            });
            return c.json({ saved: true, profile });
        },
    );

    // Compatibility endpoint for old portal clients. New app clients revoke
    // through DELETE /api/app/connections/:tokenFamilyId.
    portal.post(
        "/account/portal/connections/revoke",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            const body = (await c.req.json()) as {
                token_family_id?: unknown;
            };
            if (typeof body.token_family_id !== "string") {
                return c.json({ error: "token_family_id_required" }, 400);
            }
            const revoked = await revokeOAuthConnection(
                c.get("munchUserId"),
                body.token_family_id,
            );
            return c.json({ revoked });
        },
    );

    portal.post(
        "/account/portal/delete",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            const body = (await c.req.json()) as { confirmation?: unknown };
            if (body.confirmation !== "DELETE MY MUNCH ACCOUNT") {
                return c.json({ error: "confirmation_mismatch" }, 400);
            }
            const userId = c.get("munchUserId");
            try {
                await deleteAllUserData(userId);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "deletion_failed";
                if (message.includes("household_owner_transfer_required")) {
                    return c.json(
                        { error: "dissolve_household_before_deletion" },
                        409,
                    );
                }
                throw error;
            }
            await clearWebSession(c);
            return c.json({ deleted: true });
        },
    );

    portal.get("/exports/download", async (c) => {
        c.set("suppressAccessLog", true);
        const token = c.req.query("token");
        if (!token) return c.json({ error: "export_token_required" }, 400);
        const file = await getRailwayExportFile(token);
        if (!file) return c.json({ error: "invalid_or_expired_export" }, 404);
        const safeName = file.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
        return c.body(file.content, 200, {
            "Content-Type": file.contentType,
            "Content-Disposition": `attachment; filename="${safeName}"`,
            "Cache-Control": "private, no-store",
            Pragma: "no-cache",
            "X-Content-Type-Options": "nosniff",
        });
    });

    return portal;
}
