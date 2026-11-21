import { requestJson as api, scanInstalledBarcode } from "./mobile-runtime.js";
// Photo-flow P8: pantry/receipt capture is the shared capture
// control's job now (public/photo-capture.js on the web,
// mobile/capture-native.js packaged). This module keeps only the
// barcode lane that is genuinely pantry-specific.
import "./capture-native.js";

const $ = (selector) => document.querySelector(selector);

function status(message, error = false) {
    const target = $("#status");
    if (!target) return;
    target.textContent = message || "";
    target.style.color = error ? "#8c2f22" : "#5d5344";
}

function currentScope() {
    return $("#scope")?.value || "personal";
}

function locationValue() {
    return $("#native-barcode-location")?.value || "unspecified";
}

function createButton(text, onClick, className = "secondary") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
}

function clearBarcodeReview() {
    $("#native-barcode-review")?.remove();
}

function renderBarcodeReview(barcode, candidate) {
    clearBarcodeReview();
    const card = document.createElement("section");
    card.id = "native-barcode-review";
    card.className = "card stack";

    const heading = document.createElement("div");
    heading.innerHTML = '<p class="eyebrow">Barcode match</p><h2></h2>';
    heading.querySelector("h2").textContent = candidate.name;

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
    location.textContent = "Store in ";
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
    actions.style.display = "grid";
    actions.style.gridTemplateColumns = "1fr 1fr";
    actions.style.gap = "8px";
    const add = createButton(
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
                status(`${candidate.name} added to Pantry.`);
                clearBarcodeReview();
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
    const cancel = createButton("Cancel", () => {
        clearBarcodeReview();
        status("");
    });
    actions.append(add, cancel);
    card.append(heading, details, location, actions);

    const workspace = $("#workspace");
    const inventory = $(".inventory-section");
    if (workspace && inventory) workspace.insertBefore(card, inventory);
    else workspace?.append(card);
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
                `No verified food match was found for barcode ${barcode}. Use Quick add instead.`,
                true,
            );
            return;
        }
        renderBarcodeReview(barcode, candidate);
        status("Review the product before adding it to Pantry.");
    } catch (error) {
        const message = String(
            error?.message || error || "Barcode scan failed.",
        );
        if (/cancel/i.test(message)) status("");
        else status(message, true);
    }
}

// The scan control rides the tools rail (the icon-only bar the
// pantry page actually renders). The previous injector targeted the
// retired two-column card grid, which no longer exists in
// pantry.html, so it silently returned and barcode scanning never
// appeared in the packaged app. Adapted from closed PR #342 to the
// rail's shipped .rail-tool class instead of its parallel class.
function injectBarcodeTool() {
    const rail = $(".tools-rail");
    if (!rail || $("#native-barcode-scan")) return;
    const tool = document.createElement("button");
    tool.type = "button";
    tool.id = "native-barcode-scan";
    tool.className = "rail-tool";
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
