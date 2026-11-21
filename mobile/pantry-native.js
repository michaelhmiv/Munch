import { requestJson as api, scanInstalledBarcode } from "./mobile-runtime.js";
// Photo-flow P8: pantry/receipt capture is the shared capture
// control's job now (public/photo-capture.js on the web,
// mobile/capture-native.js packaged). This module keeps only the
// barcode lane that is genuinely pantry-specific.
import "./capture-native.js";

const $ = (selector) => document.querySelector(selector);

function status(message, error = false) {
    const openSheet = document.querySelector("dialog.sheet[open]");
    const target = openSheet?.querySelector(".sheet-status") || $("#status");
    if (!target) return;
    target.textContent = message || "";
    target.classList.toggle("is-error", Boolean(error && message));
}

function currentScope() {
    return $("#scope")?.value || "personal";
}

function locationValue() {
    return $("#native-barcode-location")?.value || "unspecified";
}

function createAction(text, onClick, className = "secondary") {
    const control = document.createElement("button");
    control.type = "button";
    if (className) control.className = className;
    control.textContent = text;
    control.addEventListener("click", onClick);
    return control;
}

function clearBarcodeReview() {
    const existing = $("#native-barcode-review");
    if (!existing) return;
    if (existing.open) existing.close();
    existing.remove();
}

function renderBarcodeReview(barcode, candidate) {
    clearBarcodeReview();
    const sheet = document.createElement("dialog");
    sheet.id = "native-barcode-review";
    sheet.className = "sheet";
    sheet.setAttribute("aria-labelledby", "native-barcode-title");

    const head = document.createElement("div");
    head.className = "sheet-head";
    const handle = document.createElement("div");
    handle.className = "sheet-handle";
    handle.setAttribute("aria-hidden", "true");
    const headRow = document.createElement("div");
    headRow.className = "sheet-head-row";
    const titleGroup = document.createElement("div");
    titleGroup.className = "sheet-title-group";
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Barcode match";
    const title = document.createElement("h2");
    title.id = "native-barcode-title";
    title.textContent = candidate.name;
    titleGroup.append(eyebrow, title);

    const close = createAction(
        "Close",
        () => {
            sheet.close();
        },
        "sheet-close",
    );
    headRow.append(titleGroup, close);
    head.append(handle, headRow);

    const sheetStatus = document.createElement("p");
    sheetStatus.className = "sheet-status";
    sheetStatus.setAttribute("role", "status");
    sheetStatus.setAttribute("aria-live", "polite");

    const body = document.createElement("div");
    body.className = "stack";

    const details = document.createElement("p");
    details.className = "muted";
    details.textContent = [
        candidate.brand,
        candidate.provider ? `verified by ${candidate.provider}` : null,
        `barcode ${barcode}`,
    ]
        .filter(Boolean)
        .join(" · ");

    const location = document.createElement("label");
    location.textContent = "Store in";
    const select = document.createElement("select");
    select.id = "native-barcode-location";
    for (const [value, text] of [
        ["unspecified", "Unsorted"],
        ["pantry", "Pantry"],
        ["fridge", "Fridge"],
        ["freezer", "Freezer"],
    ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        select.append(option);
    }
    location.append(select);

    const actions = document.createElement("div");
    actions.className = "fields sheet-actions";
    const cancel = createAction("Cancel", () => {
        sheet.close();
        status("");
    });
    const add = createAction(
        "Add to Pantry",
        async () => {
            add.disabled = true;
            status("Adding scanned product…");
            try {
                await api("/api/app/pantry/reconcile", {
                    method: "POST",
                    body: JSON.stringify({
                        scope: currentScope(),
                        source_type: "pantry_scan",
                        idempotency_key: `mobile-barcode:${crypto.randomUUID()}`,
                        operations: [
                            {
                                action: "acquire",
                                name: candidate.name,
                                location: locationValue(),
                                quantity_mode: "presence_only",
                                food_provider: candidate.provider || undefined,
                                provider_food_id:
                                    candidate.provider_food_id || undefined,
                                barcode,
                                confidence:
                                    typeof candidate.confidence === "number"
                                        ? candidate.confidence
                                        : candidate.verified
                                          ? 1
                                          : undefined,
                            },
                        ],
                    }),
                });
                clearBarcodeReview();
                status(`${candidate.name} added to Pantry.`);
                $("#refresh")?.click();
            } catch (error) {
                status(
                    error?.message || "Unable to add scanned product.",
                    true,
                );
                add.disabled = false;
            }
        },
        "",
    );
    actions.append(cancel, add);
    body.append(details, location, actions);
    sheet.append(head, sheetStatus, body);

    sheet.addEventListener("click", (event) => {
        if (event.target !== sheet) return;
        const rect = sheet.getBoundingClientRect();
        const outside =
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom;
        if (outside) sheet.close();
    });
    sheet.addEventListener("close", () => {
        sheet.remove();
        $("#native-barcode-scan")?.focus({ preventScroll: true });
    });

    const host = $("#workspace") || document.body;
    host.append(sheet);
    sheet.showModal();
    select.focus({ preventScroll: true });
}

async function scanBarcode() {
    status("Opening barcode scanner…");
    clearBarcodeReview();
    try {
        const result = await scanInstalledBarcode();
        const barcode = String(result?.ScanResult || "").trim();
        if (!barcode) {
            status("");
            return;
        }
        status("Looking up product…");
        const candidate = await api(
            `/api/app/food-barcode?barcode=${encodeURIComponent(barcode)}`,
        );
        if (!candidate) {
            status(
                `No verified food match was found for barcode ${barcode}. Use Add to Pantry instead.`,
                true,
            );
            return;
        }
        renderBarcodeReview(barcode, candidate);
    } catch (error) {
        const message = String(
            error?.message || error || "Barcode scan failed.",
        );
        if (/cancel/i.test(message)) status("");
        else status(message, true);
    }
}

function injectBarcodeTool() {
    const rail = $(".tools-rail");
    if (!rail || $("#native-barcode-scan")) return;
    const tool = document.createElement("button");
    tool.type = "button";
    tool.id = "native-barcode-scan";
    tool.className = "native-rail-tool";
    tool.setAttribute("aria-label", "Scan barcode");
    tool.title = "Scan barcode";
    tool.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M4 7V5h3M20 7V5h-3M4 17v2h3M20 17v2h-3" />' +
        '<path d="M7 9v6M10 9v6M13 9v6M16 9v6" /></svg>';
    tool.addEventListener("click", scanBarcode);
    const receiptTool = rail.querySelector('[data-open-sheet="sheet-receipt"]');
    if (receiptTool) receiptTool.after(tool);
    else rail.append(tool);
}

injectBarcodeTool();
