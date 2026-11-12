import { afterEach, describe, expect, test } from "bun:test";
import {
    downscaleImageFile,
    fitWithinEdge,
    parseImageDimensions,
    photoCaptureMarkup,
    probeImageDimensions,
    stripImageMetadata,
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

function pngChunk(type: string, data: Uint8Array) {
    const out = new Uint8Array(12 + data.length);
    out[0] = (data.length >>> 24) & 0xff;
    out[1] = (data.length >>> 16) & 0xff;
    out[2] = (data.length >>> 8) & 0xff;
    out[3] = data.length & 0xff;
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    return out;
}

/** A complete, well-formed PNG: signature, IHDR, extras, IDAT, IEND. */
function pngComplete(
    width: number,
    height: number,
    extraChunks: Uint8Array[] = [],
) {
    const ihdr = new Uint8Array(13);
    ihdr[0] = (width >>> 24) & 0xff;
    ihdr[1] = (width >>> 16) & 0xff;
    ihdr[2] = (width >>> 8) & 0xff;
    ihdr[3] = width & 0xff;
    ihdr[4] = (height >>> 24) & 0xff;
    ihdr[5] = (height >>> 16) & 0xff;
    ihdr[6] = (height >>> 8) & 0xff;
    ihdr[7] = height & 0xff;
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", ihdr),
        ...extraChunks,
        pngChunk("IDAT", new Uint8Array([0x78, 0x9c, 0x63, 0x60])),
        pngChunk("IEND", new Uint8Array(0)),
    ];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/**
 * A complete JPEG whose APP1 carries an EXIF header and a GPS
 * payload, followed by SOF0 and a Start-Of-Scan with entropy bytes.
 */
function jpegWithExif(width: number, height: number) {
    const parts: number[] = [0xff, 0xd8]; // SOI
    parts.push(0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)); // APP0
    const exifPayload = [
        ...new TextEncoder().encode("Exif\0\0GPS 37.7749 -122.4194"),
    ];
    parts.push(
        0xff,
        0xe1,
        ((exifPayload.length + 2) >> 8) & 0xff,
        (exifPayload.length + 2) & 0xff,
        ...exifPayload,
    );
    parts.push(
        0xff,
        0xc0, // SOF0
        0x00,
        0x11,
        0x08,
        (height >> 8) & 0xff,
        height & 0xff,
        (width >> 8) & 0xff,
        width & 0xff,
        0x03,
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
    parts.push(
        0xff,
        0xda, // SOS
        0x00,
        0x0c,
        0x03,
        1,
        0x00,
        2,
        0x11,
        3,
        0x11,
        0x00,
        0x3f,
        0x00,
        0x7e, // entropy byte 1
        0x42, // entropy byte 2
        0xff,
        0xd9, // EOI
    );
    return new Uint8Array(parts);
}

function webpChunk(fourcc: string, data: Uint8Array) {
    const padded = data.length + (data.length % 2);
    const out = new Uint8Array(8 + padded);
    out.set(new TextEncoder().encode(fourcc), 0);
    out[4] = data.length & 0xff;
    out[5] = (data.length >> 8) & 0xff;
    out[6] = (data.length >> 16) & 0xff;
    out[7] = (data.length >> 24) & 0xff;
    out.set(data, 8);
    return out;
}

/** A complete VP8X WebP with EXIF + XMP chunks and their VP8X flags set. */
function webpWithExif(width: number, height: number) {
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x08 | 0x04; // EXIF + XMP feature flags
    const w = width - 1;
    const h = height - 1;
    vp8x[4] = w & 0xff;
    vp8x[5] = (w >> 8) & 0xff;
    vp8x[6] = (w >> 16) & 0xff;
    vp8x[7] = h & 0xff;
    vp8x[8] = (h >> 8) & 0xff;
    vp8x[9] = (h >> 16) & 0xff;
    const chunks = [
        webpChunk("VP8X", vp8x),
        webpChunk("EXIF", new TextEncoder().encode("GPSWEBP 37.7749")),
        webpChunk("XMP ", new TextEncoder().encode("<x:xmpmeta/>")),
        webpChunk("VP8L", new Uint8Array([0x2f, 0x00, 0x00, 0x00, 0x00])),
    ];
    const bodyLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(12 + bodyLength);
    out.set(new TextEncoder().encode("RIFF"), 0);
    const riffSize = 4 + bodyLength;
    out[4] = riffSize & 0xff;
    out[5] = (riffSize >> 8) & 0xff;
    out[6] = (riffSize >> 16) & 0xff;
    out[7] = (riffSize >> 24) & 0xff;
    out.set(new TextEncoder().encode("WEBP"), 8);
    let at = 12;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

describe("stripImageMetadata (container-level EXIF strip)", () => {
    const asText = (bytes: Uint8Array) =>
        new TextDecoder("iso-8859-1").decode(bytes);

    test("a JPEG loses its EXIF/GPS APP1; the scan tail survives verbatim", async () => {
        const original = jpegWithExif(800, 600);
        const file = new File([original], "meal.jpg", {
            type: "image/jpeg",
        });
        const stripped = await stripImageMetadata(file);
        expect(stripped).not.toBeNull();
        expect(stripped).not.toBe(file);
        const bytes = new Uint8Array(await stripped!.arrayBuffer());
        expect(asText(bytes)).not.toContain("Exif");
        expect(asText(bytes)).not.toContain("GPS");
        expect(asText(bytes)).not.toContain("37.7749");
        expect(bytes.length).toBeLessThan(original.length);
        expect(parseImageDimensions(bytes)).toEqual({
            width: 800,
            height: 600,
        });
        // Entropy bytes + EOI at the tail are byte-identical.
        expect(bytes.slice(-4)).toEqual(
            new Uint8Array([0x7e, 0x42, 0xff, 0xd9]),
        );
    });

    test("a JPEG with no APP1 is returned as itself, verified clean", async () => {
        const complete = new File([jpegWithExifClean(800, 600)], "c.jpg", {
            type: "image/jpeg",
        });
        expect(await stripImageMetadata(complete)).toBe(complete);
    });

    test("a PNG loses eXIf and text chunks; image chunks survive", async () => {
        const original = pngComplete(800, 600, [
            pngChunk("eXIf", new TextEncoder().encode("GPSPNG 37.7749")),
            pngChunk("tEXt", new TextEncoder().encode("Comment\0shot at home")),
        ]);
        const file = new File([original], "meal.png", {
            type: "image/png",
        });
        const stripped = await stripImageMetadata(file);
        expect(stripped).not.toBeNull();
        expect(stripped).not.toBe(file);
        const bytes = new Uint8Array(await stripped!.arrayBuffer());
        expect(asText(bytes)).not.toContain("eXIf");
        expect(asText(bytes)).not.toContain("GPSPNG");
        expect(asText(bytes)).not.toContain("shot at home");
        expect(asText(bytes)).toContain("IDAT");
        expect(asText(bytes)).toContain("IEND");
        expect(parseImageDimensions(bytes)).toEqual({
            width: 800,
            height: 600,
        });
    });

    test("a WebP loses EXIF and XMP chunks; VP8X flags are cleared", async () => {
        const file = new File([webpWithExif(800, 600)], "meal.webp", {
            type: "image/webp",
        });
        const stripped = await stripImageMetadata(file);
        expect(stripped).not.toBeNull();
        expect(stripped).not.toBe(file);
        const bytes = new Uint8Array(await stripped!.arrayBuffer());
        expect(asText(bytes)).not.toContain("GPSWEBP");
        expect(asText(bytes)).not.toContain("xmpmeta");
        // RIFF size recomputed: file length minus 8, little-endian.
        const riffSize =
            (bytes[4] |
                (bytes[5] << 8) |
                (bytes[6] << 16) |
                (bytes[7] << 24)) >>>
            0;
        expect(riffSize).toBe(bytes.length - 8);
        // VP8X data starts at 12 (header) + 8 (chunk header) = 20.
        expect(bytes[20] & (0x08 | 0x04)).toBe(0);
        expect(parseImageDimensions(bytes)).toEqual({
            width: 800,
            height: 600,
        });
    });

    test("unrecognized or truncated containers read as cannot-strip", async () => {
        const gif = new File(
            [new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
            "anim.gif",
            { type: "image/gif" },
        );
        expect(await stripImageMetadata(gif)).toBeNull();
        const truncated = new File(
            [jpegWithExif(800, 600).slice(0, 10)],
            "cut.jpg",
            { type: "image/jpeg" },
        );
        expect(await stripImageMetadata(truncated)).toBeNull();
    });
});

function jpegWithExifClean(width: number, height: number) {
    // jpegWithExif minus the APP1: rebuild by stripping manually —
    // simpler: same layout with an APP0-only header + SOS tail.
    const parts: number[] = [0xff, 0xd8];
    parts.push(0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0));
    parts.push(
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        (height >> 8) & 0xff,
        height & 0xff,
        (width >> 8) & 0xff,
        width & 0xff,
        0x03,
        1,
        0x22,
        0,
        2,
        0x11,
        1,
        3,
        0x11,
        1,
        0xff,
        0xda,
        0x00,
        0x0c,
        0x03,
        1,
        0x00,
        2,
        0x11,
        3,
        0x11,
        0x00,
        0x3f,
        0x00,
        0xff,
        0xd9,
    );
    return new Uint8Array(parts);
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

    test("a metadata-free frame already inside the cap returns untouched, no decode", async () => {
        const calls = stubBrowser({ fullWidth: 800, fullHeight: 600 });
        const file = new File([pngComplete(800, 600)], "small.png", {
            type: "image/png",
        });
        const prepared = await downscaleImageFile(file);
        expect(prepared).toBe(file);
        expect(calls).toHaveLength(0);
    });

    test("an in-cap JPEG with EXIF/GPS uploads stripped bytes, no decode", async () => {
        // createImageBitmap is stubbed to throw: the strip must
        // happen at the container level, before any decode exists.
        const calls = stubBrowser({ fullWidth: 800, fullHeight: 600 });
        const file = new File([jpegWithExif(800, 600)], "meal.jpg", {
            type: "image/jpeg",
        });
        const prepared = await downscaleImageFile(file);
        expect(calls).toHaveLength(0);
        expect(prepared).not.toBe(file);
        const bytes = new Uint8Array(await prepared.arrayBuffer());
        const text = new TextDecoder("iso-8859-1").decode(bytes);
        expect(text).not.toContain("Exif");
        expect(text).not.toContain("GPS");
        expect(text).not.toContain("37.7749");
        expect(parseImageDimensions(bytes)).toEqual({
            width: 800,
            height: 600,
        });
    });

    test("an in-cap PNG with an eXIf chunk uploads stripped bytes, no decode", async () => {
        const calls = stubBrowser({ fullWidth: 800, fullHeight: 600 });
        const file = new File(
            [
                pngComplete(800, 600, [
                    pngChunk(
                        "eXIf",
                        new TextEncoder().encode("GPSLAT 37.7749"),
                    ),
                ]),
            ],
            "meal.png",
            { type: "image/png" },
        );
        const prepared = await downscaleImageFile(file);
        expect(calls).toHaveLength(0);
        expect(prepared).not.toBe(file);
        const bytes = new Uint8Array(await prepared.arrayBuffer());
        const text = new TextDecoder("iso-8859-1").decode(bytes);
        expect(text).not.toContain("eXIf");
        expect(text).not.toContain("GPSLAT");
        expect(parseImageDimensions(bytes)).toEqual({
            width: 800,
            height: 600,
        });
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
