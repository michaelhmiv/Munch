import type { Context } from "hono";
import { capabilitySurfaceFromRequest } from "./capabilities.js";

export function androidAiTaskCreditsUnavailable(c: Context): Response | null {
    if (capabilitySurfaceFromRequest(c) !== "android") return null;
    return c.json(
        {
            error: "android_ai_credits_unavailable",
            message:
                "Munch AI task credits are not available in Android yet. Continue with saved recipes or manual entry.",
        },
        503,
    );
}
