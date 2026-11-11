import { afterEach, describe, expect, test } from "bun:test";
import {
    downscaleImageFile,
    fitWithinEdge,
    parseImageDimensions,
    photoCaptureMarkup,
    probeImageDimensions,
} from "./photo-capture.js";

/**
 * Photo-flow P8: the shared capture control's contract — two explicit
 * actions (camera default, library secondary), the file input hidden
 * and never presented bare, and each surface's existing input
 * contract (ids/names) preserved.
 */
describe("photoCaptureMarkup", () => {
    test("renders Take photo (primary) + Choose from library (secondary) and a hidden input", () => {
        const markup = photoCaptureMarkup({
            inputId: "meal-photo-file",
            label: "Meal photo",
        });
        expect(markup).toContain("data-photo-capture");
        expect(markup).toContain('data-capture-action="camera"');
        expect(markup).toContain("Take photo");
        expect(markup).toContain('data-capture-action="library"');
        expect(markup).toContain("Choose from library");
        expect(markup).toContain('id="meal-photo-file"');
        expect(markup).toContain('type="file"');
        expect(markup).toContain("hidden");
        // Camera is the primary action and comes first.
        expect(markup.indexOf("Take photo")).toBeLessThan(
            markup.indexOf("Choose from library"),
        );
        // The bare-input pattern the brief bans: a visible labelled
        // file field with capture= as the only affordance.
        expect(markup).not.toContain('capture="environment"');
    });

    test("cook form contract: name=photos + multiple", () => {
        const markup = photoCaptureMarkup({
            name: "photos",
            label: "Photos",
            multiple: true,
        });
        expect(markup).toContain('name="photos"');
        expect(markup).toContain("multiple");
    });
});

describe("fitWithinEdge (photo-flow P7 downscale math)", () => {
    test("a 4032×3024 phone frame caps at the long edge, aspect kept", () => {
        expect(fitWithinEdge(4032, 3024, 1568)).toEqual({
            width: 1568,
            height: 1176,
            scaled: true,
        });
    });

    test("small images pass through unscaled", () => {
        expect(fitWithinEdge(800, 600, 1568)).toEqual({
            width: 800,
            height: 600,
            scaled: false,
        });
    });

    test("portrait frames cap on height", () => {
        expect(fitWithinEdge(1176, 4032, 1568)).toEqual({
            width: 457,
            height: 1568,
            scaled: true,
        });
    });
});

/**
 * Photo-prepare speed (Nov 11): the downscale fast path learns the
 * frame's dimensions from its header bytes, then asks the decoder
 * to resize DURING the decode. The fixtures below are tiny synthetic
 * headers — just the bytes each format's parser reads.
 */

function pngHeader(width: number, height: number, total = 64) {
    const bytes = new Uint8Array(Math.max(total, 24));
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0, 0, 0, 13], 8); // IHDR length
    bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
    bytes[16] = (width >>> 24) & 0xff;
    bytes[17] = (width >>> 16) & 0xff;
    bytes[18] = (width >>> 8) & 0xff;
    bytes[19] = width & 0xff;
    bytes[20] = (height >>> 24) & 0xff;
    bytes[21] = (height >>> 16) & 0xff;
    bytes[22] = (height >>> 8) & 0xff;
    bytes[23] = height & 0xff;
    return bytes;
}

function jpegHeader(
    width: number,
    height: number,
    { sofMarker = 0xc0, withExif = false } = {},
) {
    const parts: number[] = [0xff, 0xd8]; // SOI
    parts.push(0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)); // APP0
    if (withExif) {
        parts.push(0xff, 0xe1, 0x00, 0x08, ...new Array(6).fill(0)); // APP1
    }
    parts.push(
        0xff,
        sofMarker,
        0x00,
        0x11, // segment length 17
        0x08, // precision
        (height >> 8) & 0xff,
        height & 0xff,
        (width >> 8) & 0xff,
        width & 0xff,
        0x03, // components
        1,
        0x22,
        0,
        2,
        0x11,
        1,
        3,
        0x11,
        1,
    );
    return new Uint8Array(parts);
}

function webpVp8xHeader(width: number, height: number) {
    const bytes = new Uint8Array(30);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
    const w = width - 1;
    const h = height - 1;
    bytes[24] = w & 0xff;
    bytes[25] = (w >> 8) & 0xff;
    bytes[26] = (w >> 16) & 0xff;
    bytes[27] = h & 0xff;
    bytes[28] = (h >> 8) & 0xff;
    bytes[29] = (h >> 16) & 0xff;
    return bytes;
}

function webpVp8lHeader(width: number, height: number) {
    // 640×480 packs to 7F C2 77 00 after the 2F signature byte;
    // pack generally: 14 bits (width-1), then 14 bits (height-1),
    // little-endian bit order.
    const bytes = new Uint8Array(25);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // VP8L
    bytes[20] = 0x2f;
    const w = width - 1;
    const h = height - 1;
    bytes[21] = w & 0xff;
    bytes[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
    bytes[23] = (h >> 2) & 0xff;
    bytes[24] = (h >> 10) & 0x0f;
    return bytes;
}

function webpVp8Header(width: number, height: number) {
    const bytes = new Uint8Array(30);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
    bytes[23] = 0x9d;
    bytes[24] = 0x01;
    bytes[25] = 0x2a;
    bytes[26] = width & 0xff;
    bytes[27] = (width >> 8) & 0xff;
    bytes[28] = height & 0xff;
    bytes[29] = (height >> 8) & 0xff;
    return bytes;
}

describe("parseImageDimensions (header probe)", () => {
    test("PNG dimensions come from IHDR", () => {
        expect(parseImageDimensions(pngHeader(4032, 3024))).toEqual({
            width: 4032,
            height: 3024,
        });
    });

    test("JPEG dimensions come from the SOF0 segment, past APP0", () => {
        expect(parseImageDimensions(jpegHeader(4032, 3024))).toEqual({
            width: 4032,
            height: 3024,
        });
    });

    test("JPEG walk skips an EXIF APP1 block and reads a progressive SOF2", () => {
        expect(
            parseImageDimensions(
                jpegHeader(3024, 4032, { sofMarker: 0xc2, withExif: true }),
            ),
        ).toEqual({ width: 3024, height: 4032 });
    });

    test("WebP dimensions come from the VP8X canvas size", () => {
        expect(parseImageDimensions(webpVp8xHeader(1920, 1080))).toEqual({
            width: 1920,
            height: 1080,
        });
    });

    test("WebP dimensions come from the VP8L packed header", () => {
        expect(parseImageDimensions(webpVp8lHeader(640, 480))).toEqual({
            width: 640,
            height: 480,
        });
    });

    test("WebP dimensions come from the lossy VP8 frame header", () => {
        expect(parseImageDimensions(webpVp8Header(800, 600))).toEqual({
            width: 800,
            height: 600,
        });
    });

    test("truncated headers read as unknown, never as a guess", () => {
        expect(
            parseImageDimensions(pngHeader(4032, 3024).slice(0, 8)),
        ).toBeNull();
        expect(
            parseImageDimensions(jpegHeader(4032, 3024).slice(0, 12)),
        ).toBeNull();
        expect(parseImageDimensions(new Uint8Array([0xff, 0xd8]))).toBeNull();
    });

    test("garbage and empty bytes read as unknown", () => {
        expect(
            parseImageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
        ).toBeNull();
        expect(parseImageDimensions(new Uint8Array(0))).toBeNull();
        // A JPEG that reaches Start-Of-Scan with no SOF before it.
        expect(
            parseImageDimensions(
                new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 12]),
            ),
        ).toBeNull();
    });
});

describe("probeImageDimensions", () => {
    test("reads dimensions from a File's head without decoding", async () => {
        const file = new File([jpegHeader(4032, 3024)], "photo.jpg", {
            type: "image/jpeg",
        });
        expect(await probeImageDimensions(file)).toEqual({
            width: 4032,
            height: 3024,
        });
    });

    test("an unrecognized file probes as unknown", async () => {
        const file = new File([new Uint8Array([9, 9, 9, 9])], "photo.jpg", {
            type: "image/jpeg",
        });
        expect(await probeImageDimensions(file)).toBeNull();
    });
});

describe("downscaleImageFile (decoder-resize fast path)", () => {
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const originalDocument = globalThis.document;

    afterEach(() => {
        globalThis.createImageBitmap = originalCreateImageBitmap;
        Object.defineProperty(globalThis, "document", {
            value: originalDocument,
            configurable: true,
        });
    });

    function stubBrowser({
        fullWidth,
        fullHeight,
        failOnResize = false,
        encodedBytes = 100,
    }: {
        fullWidth: number;
        fullHeight: number;
        failOnResize?: boolean;
        encodedBytes?: number;
    }) {
        const calls: { options?: Record<string, unknown> }[] = [];
        const bitmap = (width: number, height: number) => ({
            width,
            height,
            close() {},
        });
        globalThis.createImageBitmap = (async (
            _source: unknown,
            options?: Record<string, unknown>,
        ) => {
            calls.push({ options });
            if (options) {
                if (failOnResize) {
                    throw new Error("resize decode unsupported");
                }
                return bitmap(
                    Number(options.resizeWidth),
                    Number(options.resizeHeight),
                );
            }
            return bitmap(fullWidth, fullHeight);
        }) as typeof createImageBitmap;
        Object.defineProperty(globalThis, "document", {
            value: {
                createElement: () => ({
                    width: 0,
                    height: 0,
                    getContext: () => ({ drawImage: () => {} }),
                    toBlob: (
                        callback: (blob: Blob | null) => void,
                        type: string,
                    ) =>
                        callback(
                            new Blob([new Uint8Array(encodedBytes)], { type }),
                        ),
                }),
            },
            configurable: true,
        });
        return calls;
    }

    test("probed dimensions reach createImageBitmap as resize options", async () => {
        const calls = stubBrowser({ fullWidth: 4032, fullHeight: 3024 });
        // Padded past the encoded blob size so the result is smaller.
        const file = new File(
            [jpegHeader(4032, 3024), new Uint8Array(4096)],
            "photo.jpg",
            {
                type: "image/jpeg",
            },
        );
        const prepared = await downscaleImageFile(file);
        expect(calls).toHaveLength(1);
        expect(calls[0].options).toEqual({
            resizeWidth: 1568,
            resizeHeight: 1176,
            resizeQuality: "high",
        });
        expect(prepared).not.toBe(file);
        expect(prepared.type).toBe("image/jpeg");
        expect(prepared.name).toBe("photo.jpg");
    });

    test("a rejected resize decode falls back to the full decode", async () => {
        const calls = stubBrowser({
            fullWidth: 4032,
            fullHeight: 3024,
            failOnResize: true,
        });
        const file = new File(
            [jpegHeader(4032, 3024), new Uint8Array(4096)],
            "photo.jpg",
            {
                type: "image/jpeg",
            },
        );
        const prepared = await downscaleImageFile(file);
        expect(calls).toHaveLength(2);
        expect(calls[0].options).toBeDefined();
        expect(calls[1].options).toBeUndefined();
        expect(prepared).not.toBe(file);
    });

    test("a frame already inside the cap returns untouched, no decode", async () => {
        const calls = stubBrowser({ fullWidth: 800, fullHeight: 600 });
        const file = new File([pngHeader(800, 600)], "small.png", {
            type: "image/png",
        });
        const prepared = await downscaleImageFile(file);
        expect(prepared).toBe(file);
        expect(calls).toHaveLength(0);
    });

    test("an unprobeable header keeps the plain full-decode path", async () => {
        const calls = stubBrowser({ fullWidth: 4032, fullHeight: 3024 });
        const bytes = new Uint8Array(4096).fill(7);
        const file = new File([bytes], "photo.jpg", { type: "image/jpeg" });
        const prepared = await downscaleImageFile(file);
        expect(calls).toHaveLength(1);
        expect(calls[0].options).toBeUndefined();
        expect(prepared).not.toBe(file);
    });
});
