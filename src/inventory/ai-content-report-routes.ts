import { Hono } from "hono";
import { requireSameOrigin } from "../accounts/csrf.js";
import { requireWebSession } from "../accounts/session.js";
import {
    parseAiContentReportBody,
    submitAiContentReport,
} from "./ai-content-report.js";

export function createAiContentReportRouter(): Hono {
    const app = new Hono();

    app.post(
        "/api/app/pantry/meal-ideas/report",
        requireWebSession,
        requireSameOrigin,
        async (c) => {
            let report;
            try {
                report = parseAiContentReportBody(await c.req.json());
            } catch (error) {
                return c.json(
                    {
                        error: "invalid_ai_content_report",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Invalid AI content report",
                    },
                    400,
                );
            }
            const reportId = await submitAiContentReport(
                c.get("munchUserId"),
                report,
            );
            return c.json(
                { received: true, report_id: reportId },
                201,
                { "Cache-Control": "no-store, private" },
            );
        },
    );

    return app;
}
