import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { withUserDatabase } from "../platform/database.js";

export const MAX_COOK_MEDIA_BYTES = 8 * 1024 * 1024;
export const COOK_MEDIA_MIME_TYPES = [
    "image/jpeg",
    "image/png",
    "image/webp",
] as const;
export type CookMediaMimeType = (typeof COOK_MEDIA_MIME_TYPES)[number];

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mediaSecret(): string {
    const secret = process.env.BETTER_AUTH_SECRET?.trim();
    if (secret) return secret;
    if (process.env.NODE_ENV === "production") {
        throw new Error("BETTER_AUTH_SECRET is required for cook media URLs");
    }
    return "munch-development-cook-media-secret";
}

function baseUrl(): string {
    const configured = process.env.MUNCH_APP_BASE_URL?.trim();
    if (!configured) return "https://munch.business";
    try {
        return new URL(configured).origin;
    } catch {
        return "https://munch.business";
    }
}

function base64Url(value: Uint8Array | string): string {
    const buffer =
        typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    return buffer.toString("base64url");
}

function sign(value: string): string {
    return createHmac("sha256", mediaSecret())
        .update(value)
        .digest("base64url");
}

export interface CookMediaUpload {
    bytes: Uint8Array;
    mimeType: string;
    fileName?: string;
    openaiFileId?: string;
    caption?: string;
}

export interface CookMediaFailure {
    fileName?: string;
    code:
        | "invalid_type"
        | "too_large"
        | "empty"
        | "download_failed"
        | "unsupported";
    message: string;
}

export function normalizeCookMediaMimeType(
    value: string | undefined,
): CookMediaMimeType {
    const normalized =
        (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if ((COOK_MEDIA_MIME_TYPES as readonly string[]).includes(normalized)) {
        return normalized as CookMediaMimeType;
    }
    throw new Error("Cook photos must be JPEG, PNG, or WebP images");
}

export function validateCookMediaUpload(
    input: CookMediaUpload,
): CookMediaUpload {
    const mimeType = normalizeCookMediaMimeType(input.mimeType);
    if (input.bytes.byteLength === 0) throw new Error("Cook photo is empty");
    if (input.bytes.byteLength > MAX_COOK_MEDIA_BYTES) {
        throw new Error("Cook photo is too large (maximum 8 MB)");
    }
    if (input.fileName && input.fileName.length > 255) {
        throw new Error("Cook photo file name is too long");
    }
    if (input.caption && input.caption.length > 4000) {
        throw new Error("Cook photo caption is too long");
    }
    const startsWith = (...bytes: number[]) =>
        bytes.every((value, index) => input.bytes[index] === value);
    const hasSignature =
        (mimeType === "image/jpeg" && startsWith(0xff, 0xd8, 0xff)) ||
        (mimeType === "image/png" &&
            startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) ||
        (mimeType === "image/webp" &&
            startsWith(0x52, 0x49, 0x46, 0x46) &&
            input.bytes[8] === 0x57 &&
            input.bytes[9] === 0x45 &&
            input.bytes[10] === 0x42 &&
            input.bytes[11] === 0x50);
    if (!hasSignature) {
        throw new Error(
            "Cook photo bytes do not match the declared image type",
        );
    }
    return { ...input, mimeType };
}

export function cookMediaSha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export function cookMediaUrl(
    userId: string,
    mediaId: string,
    expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
): string {
    const payload = base64Url(JSON.stringify({ userId, mediaId, expiresAt }));
    return `${baseUrl()}/media/cooks/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(`${payload}.${sign(payload)}`)}`;
}

export function verifyCookMediaToken(
    token: string,
    expectedMediaId: string,
): { userId: string; mediaId: string; expiresAt: number } | null {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expectedSignature = sign(payload);
    const actual = Buffer.from(signature);
    const expected = Buffer.from(expectedSignature);
    if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
    ) {
        return null;
    }
    try {
        const parsed = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8"),
        ) as {
            userId?: unknown;
            mediaId?: unknown;
            expiresAt?: unknown;
        };
        if (
            typeof parsed.userId !== "string" ||
            !UUID_RE.test(parsed.userId) ||
            typeof parsed.mediaId !== "string" ||
            !UUID_RE.test(parsed.mediaId) ||
            parsed.mediaId !== expectedMediaId ||
            typeof parsed.expiresAt !== "number" ||
            !Number.isFinite(parsed.expiresAt) ||
            parsed.expiresAt < Math.floor(Date.now() / 1000)
        ) {
            return null;
        }
        return {
            userId: parsed.userId,
            mediaId: parsed.mediaId,
            expiresAt: parsed.expiresAt,
        };
    } catch {
        return null;
    }
}

export async function getCookMediaBytes(
    userId: string,
    mediaId: string,
): Promise<{
    bytes: Uint8Array;
    mimeType: string;
    fileName: string | null;
} | null> {
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<
            Array<{
                bytes: Uint8Array;
                mime_type: string;
                file_name: string | null;
            }>
        >`
            select bytes, mime_type, file_name
            from munch.cook_media
            where id = ${mediaId}
            limit 1
        `;
        const row = rows[0];
        if (!row) return null;
        return {
            bytes: new Uint8Array(row.bytes),
            mimeType: row.mime_type,
            fileName: row.file_name,
        };
    });
}
