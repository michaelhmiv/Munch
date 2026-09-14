import { describe, expect, test } from "bun:test";
import {
    cookMediaSha256,
    cookMediaUrl,
    normalizeCookMediaMimeType,
    validateCookMediaUpload,
    verifyCookMediaToken,
} from "./media.js";

describe("durable cook media contract", () => {
    test("validates supported images and produces stable hashes", () => {
        const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
        const upload = validateCookMediaUpload({
            bytes,
            mimeType: "image/jpeg; charset=binary",
            fileName: "wings.jpg",
        });
        expect(upload.mimeType).toBe("image/jpeg");
        expect(cookMediaSha256(bytes)).toHaveLength(64);
        expect(() => normalizeCookMediaMimeType("text/plain")).toThrow();
        expect(() =>
            validateCookMediaUpload({
                bytes: new Uint8Array([1, 2, 3]),
                mimeType: "image/jpeg",
            }),
        ).toThrow("do not match");
    });

    test("signs and verifies ownership-scoped URLs", () => {
        const userId = "00000000-0000-4000-8000-000000000001";
        const mediaId = "00000000-0000-4000-8000-000000000002";
        const url = cookMediaUrl(
            userId,
            mediaId,
            Math.floor(Date.now() / 1000) + 60,
        );
        const token = new URL(url).searchParams.get("token");
        expect(token).toBeTruthy();
        expect(verifyCookMediaToken(token!, mediaId)?.userId).toBe(userId);
        expect(
            verifyCookMediaToken(
                token!,
                "00000000-0000-4000-8000-000000000003",
            ),
        ).toBeNull();
    });
});
