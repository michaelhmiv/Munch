import { Hono } from "hono";
import { exportAccountData } from "./account-export.js";
import { requireSameOrigin } from "./accounts/csrf.js";
import { requireWebSession } from "./accounts/session.js";
import { getRailwayExportFile } from "./export.js";

export function createAccountExportRouter(): Hono {
    const router = new Hono();

    router.post(
        "/api/app/export",
        requireSameOrigin,
        requireWebSession,
        async (c) => c.json(await exportAccountData(c.get("munchUserId"))),
    );

    router.get("/exports/download", async (c) => {
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

    return router;
}
