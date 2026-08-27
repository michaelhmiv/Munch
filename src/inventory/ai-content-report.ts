import { randomUUID } from "node:crypto";
import { withUserDatabase } from "../platform/database.js";

export type AiContentReportReason =
    | "offensive"
    | "unsafe"
    | "misleading"
    | "other";

export interface AiContentReportInput {
    surface: "pantry_meal_idea";
    contentExcerpt: string;
    reason: AiContentReportReason;
    details?: string;
}

function requiredText(
    value: unknown,
    label: string,
    maximumLength: number,
): string {
    if (typeof value !== "string") throw new Error(`${label} is required`);
    const normalized = value.trim();
    if (!normalized || normalized.length > maximumLength) {
        throw new Error(`${label} is invalid`);
    }
    return normalized;
}

export function parseAiContentReportBody(value: unknown): AiContentReportInput {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("AI content report must be an object");
    }
    const body = value as Record<string, unknown>;
    if (body.surface !== "pantry_meal_idea") {
        throw new Error("Unsupported AI content report surface");
    }
    const reason = body.reason;
    if (
        reason !== "offensive" &&
        reason !== "unsafe" &&
        reason !== "misleading" &&
        reason !== "other"
    ) {
        throw new Error("Invalid AI content report reason");
    }
    const details =
        body.details === undefined || body.details === null || body.details === ""
            ? undefined
            : requiredText(body.details, "AI content report details", 1000);
    return {
        surface: "pantry_meal_idea",
        contentExcerpt: requiredText(
            body.content_excerpt,
            "AI content report excerpt",
            2000,
        ),
        reason,
        details,
    };
}

export async function submitAiContentReport(
    userId: string,
    input: AiContentReportInput,
): Promise<string> {
    const reportId = randomUUID();
    await withUserDatabase(userId, async (tx) => {
        await tx`
            insert into munch.ai_content_reports (
                id,
                user_id,
                surface,
                content_excerpt,
                reason,
                details
            ) values (
                ${reportId},
                ${userId},
                ${input.surface},
                ${input.contentExcerpt},
                ${input.reason},
                ${input.details ?? null}
            )
        `;
    });
    return reportId;
}
