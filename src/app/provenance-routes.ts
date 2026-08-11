import { Hono } from "hono";
import { requireWebSession } from "../accounts/session.js";
import { getNutritionProvenanceAnalysis } from "../nutrition-provenance.js";
import { getUserTimezone } from "../storage.js";
import { shiftLocalDate, todayInTz } from "../tz.js";

function validDate(value: string): boolean {
    return (
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    );
}

function dayCount(startDate: string, endDate: string): number {
    return (
        Math.floor(
            (Date.parse(`${endDate}T00:00:00Z`) -
                Date.parse(`${startDate}T00:00:00Z`)) /
                86_400_000,
        ) + 1
    );
}

export function createProvenanceRouter(): Hono {
    const router = new Hono();

    router.get("/api/app/provenance", requireWebSession, async (c) => {
        const userId = c.get("munchUserId");
        const timezone = await getUserTimezone(userId);
        const endDate = c.req.query("end")?.trim() || todayInTz(timezone);
        const startDate =
            c.req.query("start")?.trim() || shiftLocalDate(endDate, -29);
        if (!validDate(startDate) || !validDate(endDate)) {
            return c.json({ error: "invalid_date" }, 400);
        }
        const days = dayCount(startDate, endDate);
        if (days < 1 || days > 366) {
            return c.json({ error: "invalid_date_range" }, 400);
        }
        const analysis = await getNutritionProvenanceAnalysis(
            userId,
            startDate,
            endDate,
            timezone,
        );
        return c.json({ startDate, endDate, timezone, ...analysis }, 200, {
            "Cache-Control": "private, no-store",
            Pragma: "no-cache",
        });
    });

    return router;
}
