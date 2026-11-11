/**
 * Shared camera-first photo capture control (photo-flow P8).
 *
 * ONE control for every photo capture/attach point in the app — meal
 * photo, receipt scan, pantry scan, cook photos. Michael's ruling:
 * "the 'choose file' stuff needs to just be default camera with an
 * option to add photo from library. It's almost always gonna be
 * camera."
 *
 * On the web the control renders two real buttons — "Take photo"
 * (drives the file input with capture="environment", which opens the
 * camera directly on mobile browsers) and "Choose from library" (the
 * same input without the capture hint). The raw file input itself is
 * never presented bare. In the packaged app, mobile/capture-native.js
 * upgrades the SAME control: it flags the element
 * (data-native-capture="true", which disables this module's click
 * wiring) and drives @capacitor/camera instead — camera by default,
 * library as the visible secondary action.
 *
 * Selection state lives on the control's single file input, so every
 * existing consumer (FormData forms, input.files readers) works
 * unchanged, and a `photo-capture:change` event announces new files.
 */

export const PHOTO_CAPTURE_CHANGE_EVENT = "photo-capture:change";

/** Long-edge cap for client-side downscale before upload (P7). Phone
 * cameras ship 3–8 MB frames; the vision model needs none of that
 * resolution, and every megabyte costs upload seconds on mobile. */
export const PHOTO_DOWNSCALE_MAX_EDGE = 1568;

function escapeAttribute(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;");
}

function escapeText(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

/**
 * The control markup. `inputId` / `name` preserve each surface's
 * existing contract (the meal-photo dialog reads #meal-photo-file;
 * cook forms submit a FormData field named "photos"; pantry.js reads
 * #pantry-photo / #receipt-photo).
 */
export function photoCaptureMarkup({
    inputId,
    name,
    label,
    multiple = false,
    accept = "image/jpeg,image/png,image/webp",
    cameraLabel = "Take photo",
    libraryLabel = "Choose from library",
} = {}) {
    return `<div class="photo-capture" data-photo-capture><span class="photo-capture-label">${escapeText(label ?? "Photo")}</span><div class="photo-capture-actions"><button class="button button-primary photo-capture-button" type="button" data-capture-action="camera">${escapeText(cameraLabel)}</button><button class="button button-secondary photo-capture-button" type="button" data-capture-action="library">${escapeText(libraryLabel)}</button></div><input class="photo-capture-input" type="file"${inputId ? ` id="${escapeAttribute(inputId)}"` : ""}${name ? ` name="${escapeAttribute(name)}"` : ""} accept="${escapeAttribute(accept)}"${multiple ? " multiple" : ""} hidden /><p class="tiny photo-capture-files" data-capture-files role="status"></p></div>`;
}

/** Reflect the input's current selection in the control's file line. */
export function updatePhotoCaptureFileList(control, files) {
    const line = control?.querySelector?.("[data-capture-files]");
    if (!line) return;
    const names = [...(files ?? [])].map((file) => file.name).filter(Boolean);
    line.textContent = names.length
        ? names.length === 1
            ? names[0]
            : `${names.length} photos selected`
        : "";
}

/**
 * Hand files to a control programmatically (the packaged enhancer's
 * native-camera delivery path): they land on the control's input, the
 * file line updates, and `photo-capture:change` fires — the same
 * observable state as a user picking the files on the web.
 */
export function setPhotoCaptureFiles(control, files, { append = false } = {}) {
    const input = control?.querySelector?.("input.photo-capture-input");
    if (!input) return false;
    const transfer = new DataTransfer();
    if (append) {
        for (const file of input.files ?? []) transfer.items.add(file);
    }
    for (const file of files ?? []) transfer.items.add(file);
    input.files = transfer.files;
    updatePhotoCaptureFileList(control, input.files);
    control.dispatchEvent(
        new CustomEvent(PHOTO_CAPTURE_CHANGE_EVENT, {
            bubbles: true,
            detail: { control, files: [...input.files] },
        }),
    );
    return true;
}

let installed = false;

/**
 * Wire the web behaviour: one delegated click + change pair for the
 * whole document, so dynamically rendered surfaces (dialogs, cook
 * forms, the draft review) need no per-render setup. Controls flagged
 * data-native-capture="true" (the packaged enhancer) are left alone.
 */
export function installPhotoCapture() {
    if (installed || typeof document === "undefined") return;
    installed = true;
    document.addEventListener("click", (event) => {
        const button = event.target?.closest?.("[data-capture-action]");
        if (!button) return;
        const control = button.closest("[data-photo-capture]");
        if (!control || control.dataset.nativeCapture === "true") return;
        const input = control.querySelector("input.photo-capture-input");
        if (!input) return;
        if (button.dataset.captureAction === "camera") {
            input.setAttribute("capture", "environment");
        } else {
            input.removeAttribute("capture");
        }
        input.click();
    });
    document.addEventListener("change", (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) return;
        if (!input.classList?.contains("photo-capture-input")) return;
        const control = input.closest("[data-photo-capture]");
        if (!control) return;
        updatePhotoCaptureFileList(control, input.files);
        control.dispatchEvent(
            new CustomEvent(PHOTO_CAPTURE_CHANGE_EVENT, {
                bubbles: true,
                detail: { control, files: [...(input.files ?? [])] },
            }),
        );
    });
}

/**
 * How much of a file's head the dimension probe reads. PNG and WebP
 * carry dimensions in the first 32 bytes; JPEG's SOF segment can sit
 * behind APPn blocks (EXIF thumbnails included), so the window is
 * generous — but bounded: a header not found inside it counts as
 * "unknown" and the caller falls back to a full decode.
 */
export const IMAGE_HEADER_PROBE_BYTES = 65536;

function saneDimensions(width, height) {
    if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width < 1 ||
        height < 1 ||
        width > 100000 ||
        height > 100000
    ) {
        return null;
    }
    return { width, height };
}

/** Start-Of-Frame markers carry dimensions; C4 (DHT), C8 (JPG) and
 * CC (DAC) sit in the same C0–CF range but do not. */
function isJpegSofMarker(marker) {
    return (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
    );
}

function parseJpegDimensions(bytes) {
    let offset = 2; // skip SOI (FF D8)
    while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        // Markers may be preceded by any number of FF fill bytes.
        let markerAt = offset + 1;
        while (markerAt < bytes.length && bytes[markerAt] === 0xff) {
            markerAt += 1;
        }
        if (markerAt >= bytes.length) return null;
        const marker = bytes[markerAt];
        offset = markerAt + 1;
        // Standalone markers (SOI, EOI, TEM, RSTn) carry no length.
        if (
            marker === 0xd8 ||
            marker === 0xd9 ||
            marker === 0x01 ||
            (marker >= 0xd0 && marker <= 0xd7)
        ) {
            continue;
        }
        // Start of scan: entropy data follows; dimensions never do.
        if (marker === 0xda) return null;
        if (offset + 1 >= bytes.length) return null;
        const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
        if (segmentLength < 2) return null;
        if (isJpegSofMarker(marker)) {
            // length(2) precision(1) height(2) width(2)
            if (offset + 6 >= bytes.length) return null;
            const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
            const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
            return saneDimensions(width, height);
        }
        offset += segmentLength;
    }
    return null;
}

function parsePngDimensions(bytes) {
    // 8-byte signature, then IHDR: length(4) "IHDR" width(4) height(4).
    if (bytes.length < 24) return null;
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < signature.length; i += 1) {
        if (bytes[i] !== signature[i]) return null;
    }
    if (
        bytes[12] !== 0x49 || // I
        bytes[13] !== 0x48 || // H
        bytes[14] !== 0x44 || // D
        bytes[15] !== 0x52 // R
    ) {
        return null;
    }
    const width =
        (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const height =
        (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    return saneDimensions(width >>> 0, height >>> 0);
}

function parseWebpDimensions(bytes) {
    // "RIFF" size(4) "WEBP", then the first chunk decides the layout.
    if (bytes.length < 16) return null;
    if (
        bytes[0] !== 0x52 || // R
        bytes[1] !== 0x49 || // I
        bytes[2] !== 0x46 || // F
        bytes[3] !== 0x46 || // F
        bytes[8] !== 0x57 || // W
        bytes[9] !== 0x45 || // E
        bytes[10] !== 0x42 || // B
        bytes[11] !== 0x50 // P
    ) {
        return null;
    }
    const chunk = String.fromCharCode(
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    );
    if (chunk === "VP8X") {
        if (bytes.length < 30) return null;
        const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
        const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
        return saneDimensions(width, height);
    }
    if (chunk === "VP8L") {
        if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
        const b1 = bytes[22];
        const width = (bytes[21] | ((b1 & 0x3f) << 8)) + 1;
        const height =
            ((b1 >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)) + 1;
        return saneDimensions(width, height);
    }
    if (chunk === "VP8 ") {
        // Lossy bitstream: 3-byte frame tag, 9D 01 2A start code,
        // then 14-bit width/height (top 2 bits are scale factors).
        if (bytes.length < 30) return null;
        if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
            return null;
        }
        const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
        const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
        return saneDimensions(width, height);
    }
    return null;
}

function parseGifDimensions(bytes) {
    if (bytes.length < 10) return null;
    if (
        bytes[0] !== 0x47 || // G
        bytes[1] !== 0x49 || // I
        bytes[2] !== 0x46 || // F
        bytes[3] !== 0x38 // 8
    ) {
        return null;
    }
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    return saneDimensions(width, height);
}

/**
 * Parse pixel dimensions out of raw header bytes — no decode. JPEG
 * dimensions live in a Start-Of-Frame segment, PNG's in IHDR,
 * WebP's in its VP8/VP8L/VP8X chunk, GIF's in the logical screen
 * descriptor. Returns null for anything unrecognized or truncated.
 */
export function parseImageDimensions(bytes) {
    if (!bytes || bytes.length < 2) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        return parseJpegDimensions(bytes);
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
        return parsePngDimensions(bytes);
    }
    if (bytes[0] === 0x52 && bytes[1] === 0x49) {
        return parseWebpDimensions(bytes);
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49) {
        return parseGifDimensions(bytes);
    }
    return null;
}

/**
 * An image file's pixel dimensions, read from its header bytes
 * alone. Decoding a full-resolution phone frame just to learn its
 * size is the expensive step this avoids (the downscale fast path
 * feeds these dimensions back into the decoder as resize options).
 * Returns null when the header is unreadable or unrecognized.
 */
export async function probeImageDimensions(file) {
    if (!file || typeof file.slice !== "function") return null;
    try {
        const head = file.slice(0, IMAGE_HEADER_PROBE_BYTES);
        const bytes = new Uint8Array(await head.arrayBuffer());
        return parseImageDimensions(bytes);
    } catch {
        return null;
    }
}

/** Fit (width, height) inside a long-edge cap, preserving aspect. */
export function fitWithinEdge(width, height, maxEdge) {
    const longest = Math.max(width, height);
    if (!Number.isFinite(longest) || longest <= maxEdge) {
        return { width, height, scaled: false };
    }
    const ratio = maxEdge / longest;
    return {
        width: Math.max(1, Math.round(width * ratio)),
        height: Math.max(1, Math.round(height * ratio)),
        scaled: true,
    };
}

/**
 * Downscale an image file client-side before upload (photo-flow P7):
 * long edge capped at PHOTO_DOWNSCALE_MAX_EDGE, re-encoded as JPEG.
 * Any failure — undecodable image, no canvas, a result that is not
 * actually smaller — returns the original file untouched.
 *
 * Fast path: the header probe learns the frame's dimensions WITHOUT
 * decoding it, and the decoder is then handed those dimensions as
 * resize options, so scaling happens DURING the decode. The previous
 * shape decoded the full-resolution frame first and scaled after —
 * on a phone that full-res decode inside the WebView was the whole
 * wait (Nov 11 production: the server answered a meal-photo POST in
 * 276 ms while the user felt ~10 s). If the probe or the resize
 * decode is unavailable, the flow falls back to the full decode,
 * and from there to the original file, exactly as before.
 */
export async function downscaleImageFile(
    file,
    { maxEdge = PHOTO_DOWNSCALE_MAX_EDGE, quality = 0.85 } = {},
) {
    if (!file || !String(file.type ?? "").startsWith("image/")) return file;
    if (
        typeof createImageBitmap === "undefined" ||
        typeof document === "undefined"
    ) {
        return file;
    }
    try {
        const probed = await probeImageDimensions(file);
        const probedFit = probed
            ? fitWithinEdge(probed.width, probed.height, maxEdge)
            : null;
        // Known dimensions, already inside the cap: no decode at all.
        if (probedFit && !probedFit.scaled) return file;
        let bitmap = null;
        let decoderScaled = false;
        if (probedFit?.scaled) {
            try {
                bitmap = await createImageBitmap(file, {
                    resizeWidth: probedFit.width,
                    resizeHeight: probedFit.height,
                    resizeQuality: "high",
                });
                decoderScaled = true;
            } catch {
                // Resize decode unsupported or rejected — the plain
                // full decode below is the standing fallback.
                bitmap = null;
            }
        }
        bitmap ??= await createImageBitmap(file);
        const fitted = fitWithinEdge(bitmap.width, bitmap.height, maxEdge);
        // A decoder-scaled bitmap sits exactly AT the cap, so its own
        // fit reads "not scaled" — that is the success case, not the
        // pass-through case. The canvas draw below uses `fitted`,
        // computed from the bitmap's real size, so a decoder that
        // ignored the resize options still lands on the right size.
        if (!fitted.scaled && !decoderScaled) {
            bitmap.close?.();
            return file;
        }
        const canvas = document.createElement("canvas");
        canvas.width = fitted.width;
        canvas.height = fitted.height;
        const context = canvas.getContext("2d");
        if (!context) {
            bitmap.close?.();
            return file;
        }
        context.drawImage(bitmap, 0, 0, fitted.width, fitted.height);
        bitmap.close?.();
        const blob = await new Promise((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", quality),
        );
        if (!blob || blob.size >= file.size) return file;
        const baseName = String(file.name || "photo").replace(/\.[^.]+$/, "");
        return new File([blob], `${baseName}.jpg`, {
            type: "image/jpeg",
            lastModified: Date.now(),
        });
    } catch {
        return file;
    }
}
