import { Hono } from "hono";
import { deleteAllUserData } from "../storage.js";
import { requireSameOrigin } from "./csrf.js";
import { clearWebSession, requireWebSession } from "./session.js";

export function createAccountLifecycleRouter(): Hono {
    const router = new Hono();

    router.delete(
        "/api/app/account",
        requireSameOrigin,
        requireWebSession,
        async (c) => {
            const body = (await c.req.json().catch(() => ({}))) as {
                confirmation?: unknown;
            };
            if (body.confirmation !== "DELETE MY MUNCH ACCOUNT") {
                return c.json({ error: "confirmation_mismatch" }, 400);
            }

            const userId = c.get("munchUserId");
            try {
                await deleteAllUserData(userId);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "deletion_failed";
                if (
                    message.includes("household") &&
                    message.includes("owner")
                ) {
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

    return router;
}
