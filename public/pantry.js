import { installOfflineBanner, requestJson as api } from "./app-api.js";
import { installPhotoCapture } from "./photo-capture.js";
import { formatRecipeQuantity } from "./quantity-format.js";
import {
    applyFeatureNav,
    normalizeFeatureFlags,
    queueModuleOffNotice,
} from "./feature-nav.js";

installOfflineBanner();
installPhotoCapture();

// Feature toggles (T3/T6): this page is the Pantry module's home, so
// it answers to the account's flags like every other surface. With
// Pantry off, the page lands on Today with the one-line notice —
// the inventory itself is never touched (T4). With Pantry on, the
// mirrored bottom nav renders from the same flags as the shell's.
async function applyFeatureFlags() {
    try {
        const bootstrap = await api("/api/app/bootstrap");
        const features = normalizeFeatureFlags(bootstrap?.features);
        if (!features.pantry) {
            queueModuleOffNotice("pantry");
            location.replace(
                location.pathname.endsWith("pantry.html")
                    ? "/index.html?route=%2Fapp"
                    : "/app",
            );
            return false;
        }
        applyFeatureNav(features);
    } catch {
        // A bootstrap that cannot load leaves the page as shipped;
        // the settings fetch below surfaces any real failure.
    }
    return true;
}

const $ = (selector) => document.querySelector(selector);
const workspace = $("#workspace");
const statusEl = $("#status");
const inventoryEl = $("#inventory");
const emptyEl = $("#empty");
const itemCountEl = $("#item-count");
const scopeEl = $("#scope");
const searchEl = $("#search");
const locationChipsEl = $("#location-chips");
const lowstockEl = $("#lowstock");
let locationFilter = "";
const reviewEl = $("#review");
const reviewLinesEl = $("#review-lines");
const reviewTitleEl = $("#review-title");
const applyReviewEl = $("#apply-review");
const dismissReviewEl = $("#dismiss-review");
const mealIdeaForm = $("#meal-idea-form");
const mealIdeaStatusEl = $("#meal-idea-status");
const mealIdeasEl = $("#meal-ideas");

let reviewState = null;

function activeSheetStatusEl() {
    const openSheetEl = document.querySelector("dialog.sheet[open]");
    return openSheetEl?.querySelector(".sheet-status") || null;
}

function status(message, error = false) {
    const sheetStatus = activeSheetStatusEl();
    if (sheetStatus) {
        sheetStatus.textContent = message || "";
        sheetStatus.classList.toggle("is-error", Boolean(error && message));
        return;
    }
    statusEl.replaceChildren();
    statusEl.classList.toggle("is-error", Boolean(error && message));
    if (message) {
        const text = document.createElement("span");
        text.textContent = message;
        statusEl.append(text);
    }
}

function showUndoStatus(message, onUndo) {
    statusEl.replaceChildren();
    statusEl.classList.remove("is-error");
    const text = document.createElement("span");
    text.textContent = message;
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "status-undo";
    undo.textContent = "Undo";
    undo.addEventListener("click", async () => {
        undo.disabled = true;
        await onUndo();
    });
    statusEl.append(text, undo);
}

function mealStatus(message, error = false) {
    mealIdeaStatusEl.textContent = message || "";
    mealIdeaStatusEl.classList.toggle("is-error", Boolean(error && message));
}

function currentScope() {
    return scopeEl.value || "personal";
}

function syncScopeVisibility() {
    scopeEl.classList.toggle("hidden", scopeEl.options.length <= 1);
}
syncScopeVisibility();

// Pantry enablement is the Settings feature-module flag and nothing
// else (Nov 11): the page's old "Use Pantry" switch is gone, and
// applyFeatureFlags above has already redirected to Today if the
// module is off. `settings.enabled` reports that same module flag;
// the workspace simply renders when it is on.
let pantryEnabled = false;

async function loadSettings() {
    try {
        const settings = await api("/api/app/pantry/settings");
        pantryEnabled = settings.enabled === true;
        if (
            settings.household_available &&
            !scopeEl.querySelector('option[value="household"]')
        ) {
            const option = document.createElement("option");
            option.value = "household";
            option.textContent = "Household Pantry";
            scopeEl.append(option);
        }
        syncScopeVisibility();
        workspace.classList.toggle("hidden", !pantryEnabled);
        if (pantryEnabled) await loadPantry();
    } catch (error) {
        status(error.message, true);
    }
}

function quantityLabel(item) {
    if (item.quantity == null)
        return item.stock_state === "low" ? "Low" : "On hand";
    const prefix = item.quantity_mode === "approximate" ? "≈ " : "";
    const quantity =
        formatRecipeQuantity(item.quantity, item.unit) ??
        Number(item.quantity).toLocaleString();
    return `${prefix}${quantity}${item.unit ? ` ${item.unit}` : ""}`;
}

const LOCATION_LABELS = {
    pantry: "Pantry",
    fridge: "Fridge",
    freezer: "Freezer",
    unspecified: "Unsorted",
};

const sheetTriggers = new WeakMap();

function clearSheetStatus(sheet) {
    const sheetStatus = sheet?.querySelector(".sheet-status");
    if (sheetStatus) {
        sheetStatus.textContent = "";
        sheetStatus.classList.remove("is-error");
    }
}

function openSheet(sheet, trigger = null) {
    if (!sheet) return;
    clearSheetStatus(sheet);
    sheetTriggers.set(
        sheet,
        trigger ||
            (document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null),
    );
    if (!sheet.open) sheet.showModal();
    const firstField = sheet.querySelector(
        'input:not([type="hidden"]):not([hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled)',
    );
    if (firstField instanceof HTMLElement) {
        firstField.focus({ preventScroll: true });
    }
}

function closeSheet(sheet) {
    if (sheet?.open) sheet.close();
}

let editingItem = null;
const itemEditorEl = $("#item-editor");
const itemEditorForm = $("#item-editor-form");
const itemEditorNameEl = $("#item-editor-name");

function closeItemEditor() {
    editingItem = null;
    closeSheet(itemEditorEl);
}

// UX fix wave F6: a row tap opens the item's detail/edit modal sheet.
// The name is read-only (it comes from the food's source record; no
// endpoint renames an inventory item) — quantity, unit, quantity
// mode, location, status and note are editable and save through the
// reconcile API's correct/move operations below.
function openItemEditor(item, trigger = null) {
    editingItem = item;
    itemEditorNameEl.textContent = item.name;
    const form = itemEditorForm;
    form.elements.quantity.value = item.quantity ?? "";
    form.elements.unit.value = item.unit ?? "";
    form.elements.quantity_mode.value = item.quantity_mode || "exact";
    form.elements.location.value = item.location || "unspecified";
    form.elements.stock_state.value = item.stock_state || "available";
    form.elements.note.value = item.note ?? "";
    openSheet(itemEditorEl, trigger);
}

itemEditorForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const item = editingItem;
    if (!item) return;
    const form = new FormData(itemEditorForm);
    const mode = String(form.get("quantity_mode") || "exact");
    const quantityRaw = String(form.get("quantity") ?? "").trim();
    const correct = {
        action: "correct",
        inventory_item_id: item.id,
        unit: String(form.get("unit") || "").trim() || null,
        quantity_mode: mode,
        stock_state: String(form.get("stock_state") || "available"),
        note: String(form.get("note") || "").trim() || null,
    };
    // presence_only items carry no amount; a blank quantity in the
    // other modes means "leave it as recorded", so the field is
    // omitted rather than sent as a destructive null.
    if (mode === "presence_only") correct.quantity = null;
    else if (quantityRaw !== "") correct.quantity = Number(quantityRaw);
    const operations = [correct];
    const location = String(form.get("location") || "unspecified");
    if (location !== item.location) {
        operations.push({
            action: "move",
            inventory_item_id: item.id,
            location,
        });
    }
    const submitter = event.submitter;
    if (submitter) submitter.disabled = true;
    try {
        status("Saving item…");
        await api("/api/app/pantry/reconcile", {
            method: "POST",
            body: JSON.stringify({
                scope: currentScope(),
                source_type: "correction",
                idempotency_key: `web-pantry:${crypto.randomUUID()}`,
                operations,
            }),
        });
        closeItemEditor();
        await loadPantry();
        // After the reload: loadPantry clears the status line when it
        // finishes, so the confirmation is posted last to survive it.
        status(`${item.name} updated.`);
    } catch (error) {
        status(error.message, true);
    } finally {
        if (submitter) submitter.disabled = false;
    }
});

$("#item-editor-cancel").addEventListener("click", closeItemEditor);

// Tools rail (tools-to-top ruling, Nov 11): the rail buttons and the
// planner row open their forms as sheets (native <dialog>, modal).
// A scan sheet closes itself when its preview lands, so the review
// section shows in context on the page (renderReview scrolls to it).
for (const opener of document.querySelectorAll("[data-open-sheet]")) {
    opener.addEventListener("click", () => {
        const sheet = document.getElementById(opener.dataset.openSheet);
        openSheet(sheet, opener);
    });
}
for (const sheet of document.querySelectorAll("dialog.sheet")) {
    sheet.addEventListener("click", (event) => {
        if (event.target !== sheet) return;
        const rect = sheet.getBoundingClientRect();
        const outside =
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom;
        if (outside) closeSheet(sheet);
    });
    sheet.addEventListener("close", () => {
        clearSheetStatus(sheet);
        if (sheet === itemEditorEl) editingItem = null;
        const trigger = sheetTriggers.get(sheet);
        if (
            trigger &&
            trigger.isConnected &&
            typeof trigger.focus === "function"
        ) {
            trigger.focus({ preventScroll: true });
        }
    });
    for (const closer of sheet.querySelectorAll("[data-close-sheet]")) {
        closer.addEventListener("click", () => closeSheet(sheet));
    }
}

function renderInventory(items) {
    inventoryEl.replaceChildren();
    itemCountEl.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
    emptyEl.classList.toggle("hidden", items.length !== 0);
    // Low-stock summary (tightened mock's warn panel, from real data):
    // one merged line naming every low item, inside the inventory section.
    const lowItems = items.filter((item) => item.stock_state === "low");
    lowstockEl.replaceChildren();
    lowstockEl.classList.toggle("hidden", lowItems.length === 0);
    if (lowItems.length) {
        const lead = document.createElement("strong");
        lead.textContent = "Low stock: ";
        const names = document.createElement("span");
        names.textContent = lowItems
            .map(
                (item) => `${item.name} (${quantityLabel(item).toLowerCase()})`,
            )
            .join(", ");
        lowstockEl.append(lead, names);
    }
    for (const item of items) {
        const row = document.createElement("div");
        row.className = `inventory-row stock-${item.stock_state}`;
        row.setAttribute("role", "listitem");

        // M3 2-line row: Line 1 = name + optional low/depleted badge;
        // Line 2 = compact muted quantity · location · note/detail.
        const main = document.createElement("div");
        main.className = "inventory-main inventory-main-edit";

        const line1 = document.createElement("div");
        line1.className = "inventory-line-1";
        const name = document.createElement("strong");
        name.textContent = item.name;
        line1.append(name);

        if (item.stock_state === "low") {
            const tag = document.createElement("span");
            tag.className = "tag low";
            tag.textContent = "Low stock";
            line1.append(tag);
        } else if (item.stock_state === "depleted") {
            const tag = document.createElement("span");
            tag.className = "tag depleted";
            tag.textContent = "Depleted";
            line1.append(tag);
        }

        const qtyText = quantityLabel(item);
        const locText = LOCATION_LABELS[item.location] || item.location;
        const metaParts = [qtyText, locText];
        if (item.food_provider && item.provider_food_id) {
            metaParts.push(`${item.food_provider} verified`);
        } else if (
            item.quantity_mode &&
            item.quantity_mode !== "exact" &&
            !(item.quantity == null && item.quantity_mode === "presence_only")
        ) {
            metaParts.push(item.quantity_mode.replaceAll("_", " "));
        }
        if (item.note) {
            metaParts.push(item.note);
        }

        const line2 = document.createElement("div");
        line2.className = "inventory-line-2";
        line2.textContent = metaParts.join(" · ");

        main.append(line1, line2);
        main.tabIndex = 0;
        main.setAttribute("role", "button");
        const statusHint =
            item.stock_state === "low"
                ? ", low stock"
                : item.stock_state === "depleted"
                  ? ", depleted"
                  : "";
        const noteHint = item.note ? `, ${item.note}` : "";
        main.setAttribute(
            "aria-label",
            `${item.name}, ${qtyText}, ${locText}${statusHint}${noteHint} — edit`,
        );
        main.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openItemEditor(item, main);
            }
        });
        row.addEventListener("click", (event) => {
            if (event.target.closest("button")) return;
            openItemEditor(item, main);
        });

        const trailing = document.createElement("div");
        trailing.className = "inventory-trailing";

        if (item.quantity != null) {
            const stepper = document.createElement("div");
            stepper.className = "qty-stepper";
            const currentQty = Number(item.quantity);

            const minus = document.createElement("button");
            minus.type = "button";
            minus.className = "stepper-control";
            minus.setAttribute("aria-label", `Decrease ${item.name} quantity`);
            minus.disabled = currentQty <= 0;
            const minusGlyph = document.createElement("span");
            minusGlyph.className = "stepper-glyph";
            minusGlyph.setAttribute("aria-hidden", "true");
            minusGlyph.textContent = "−";
            minus.append(minusGlyph);

            const plus = document.createElement("button");
            plus.type = "button";
            plus.className = "stepper-control";
            plus.setAttribute("aria-label", `Increase ${item.name} quantity`);
            const plusGlyph = document.createElement("span");
            plusGlyph.className = "stepper-glyph";
            plusGlyph.setAttribute("aria-hidden", "true");
            plusGlyph.textContent = "+";
            plus.append(plusGlyph);

            minus.addEventListener("click", async () => {
                if (currentQty <= 0) return;
                minus.disabled = true;
                plus.disabled = true;
                const delta =
                    currentQty > 1
                        ? 1
                        : Math.round(currentQty * 1000) / 1000 || currentQty;
                await reconcileOperations(
                    [
                        {
                            action: "consume",
                            inventory_item_id: item.id,
                            quantity: delta,
                        },
                    ],
                    "correction",
                );
            });

            plus.addEventListener("click", async () => {
                minus.disabled = true;
                plus.disabled = true;
                const nextQty = Math.round((currentQty + 1) * 1000) / 1000;
                const op = {
                    action: "correct",
                    inventory_item_id: item.id,
                    quantity: nextQty,
                };
                if (item.stock_state === "depleted") {
                    op.stock_state = "available";
                }
                await reconcileOperations([op], "correction");
            });

            stepper.append(minus, plus);
            trailing.append(stepper);
        }

        if (item.stock_state === "depleted") {
            const restock = document.createElement("button");
            restock.type = "button";
            restock.className = "row-action";
            restock.textContent = "Restock";
            restock.setAttribute("aria-label", `Restock ${item.name}`);
            restock.addEventListener("click", async () => {
                restock.disabled = true;
                const op = {
                    action: "correct",
                    inventory_item_id: item.id,
                    stock_state: "available",
                };
                if (item.quantity === 0) op.quantity = 1;
                const ok = await reconcileOperations([op], "correction");
                if (ok) status(`${item.name} restocked.`);
            });
            trailing.append(restock);
        } else {
            const finished = document.createElement("button");
            finished.type = "button";
            finished.className = "row-action";
            finished.textContent = "Finished";
            finished.setAttribute(
                "aria-label",
                `Mark ${item.name} as finished`,
            );
            finished.addEventListener("click", async () => {
                finished.disabled = true;
                const snapshot = {
                    id: item.id,
                    name: item.name,
                    quantity: item.quantity,
                    stock_state: item.stock_state || "available",
                    quantity_mode: item.quantity_mode,
                };
                const ok = await reconcileOperations(
                    [{ action: "consume_all", inventory_item_id: item.id }],
                    "correction",
                );
                if (ok) {
                    showUndoStatus(
                        `Marked ${snapshot.name} as finished.`,
                        async () => {
                            const restored = await reconcileOperations(
                                [
                                    {
                                        action: "correct",
                                        inventory_item_id: snapshot.id,
                                        quantity: snapshot.quantity,
                                        stock_state: snapshot.stock_state,
                                        quantity_mode: snapshot.quantity_mode,
                                    },
                                ],
                                "correction",
                            );
                            if (restored) status(`${snapshot.name} restored.`);
                        },
                    );
                }
            });
            trailing.append(finished);
        }

        row.append(main, trailing);
        inventoryEl.append(row);
    }
}

// Motion pass (design-authority-addendum-motion rule 2): the first
// load holds the inventory layout with skeleton rows instead of a
// "Loading Pantry…" text announcement; later reloads keep the current
// rows on screen until the new data lands. Errors still surface
// through status() exactly as before.
let pantryLoadedOnce = false;
function renderInventorySkeleton() {
    inventoryEl.replaceChildren();
    const holder = document.createElement("div");
    holder.setAttribute("role", "status");
    holder.setAttribute("aria-label", "Loading Pantry");
    for (let i = 0; i < 4; i += 1) {
        const row = document.createElement("div");
        row.className = "inventory-skeleton";
        row.setAttribute("aria-hidden", "true");
        holder.append(row);
    }
    inventoryEl.append(holder);
}

async function loadPantry() {
    if (!pantryEnabled) return;
    try {
        if (!pantryLoadedOnce) renderInventorySkeleton();
        const query = new URLSearchParams({ scope: currentScope() });
        if (searchEl.value.trim()) query.set("q", searchEl.value.trim());
        if (locationFilter) query.set("location", locationFilter);
        const pantry = await api(`/api/app/pantry?${query}`);
        renderInventory(pantry.items || []);
        pantryLoadedOnce = true;
        status("");
    } catch (error) {
        status(error.message, true);
    }
}

$("#refresh").addEventListener("click", loadPantry);
scopeEl.addEventListener("change", loadPantry);
for (const chip of locationChipsEl.querySelectorAll(".fchip")) {
    chip.addEventListener("click", () => {
        locationFilter = chip.dataset.location || "";
        for (const other of locationChipsEl.querySelectorAll(".fchip")) {
            const active = other === chip;
            other.classList.toggle("on", active);
            other.setAttribute("aria-pressed", String(active));
        }
        loadPantry();
    });
}
let searchTimer;
searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadPantry, 250);
});

async function reconcileOperations(operations, sourceType = "manual") {
    try {
        status("Updating Pantry…");
        await api("/api/app/pantry/reconcile", {
            method: "POST",
            body: JSON.stringify({
                scope: currentScope(),
                source_type: sourceType,
                idempotency_key: `web-pantry:${crypto.randomUUID()}`,
                operations,
            }),
        });
        await loadPantry();
        return true;
    } catch (error) {
        status(error.message, true);
        return false;
    }
}

$("#manual-add").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const keepOpen = event.submitter?.value === "another";
    const quantity = String(form.get("quantity") ?? "").trim();
    const location = String(form.get("location") || "unspecified");
    const note = String(form.get("note") || "").trim();
    const operation = {
        action: "acquire",
        name: String(form.get("name") || "").trim(),
        location,
    };
    if (quantity !== "") operation.quantity = Number(quantity);
    const unit = String(form.get("unit") || "").trim();
    if (unit) operation.unit = unit;
    if (note) operation.note = note;
    const buttons = [...formEl.querySelectorAll('button[type="submit"]')];
    for (const b of buttons) b.disabled = true;
    try {
        const ok = await reconcileOperations([operation]);
        if (!ok) return;
        formEl.reset();
        if (keepOpen) {
            formEl.elements.location.value = location;
            formEl.elements.name.focus({ preventScroll: true });
            status(`Added ${operation.name}. Ready for another.`);
        } else {
            closeSheet($("#sheet-add"));
            status(`Added ${operation.name} to Pantry.`);
        }
    } finally {
        for (const b of buttons) b.disabled = false;
    }
});

function renderReview(mode, preview, sourceLabel) {
    reviewState = {
        mode,
        lines: preview.lines || [],
        sourceLabel,
        idempotencyKey: `${mode}:${crypto.randomUUID()}`,
    };
    reviewTitleEl.textContent =
        mode === "receipt" ? "Receipt items" : "Detected Pantry items";
    reviewLinesEl.replaceChildren();
    reviewState.lines.forEach((line, index) => {
        const row = document.createElement("label");
        row.className = "review-row";
        const check = document.createElement("input");
        check.type = "checkbox";
        check.dataset.index = String(index);
        check.checked = line.is_food && line.confidence >= 0.85;
        check.disabled = !line.is_food;

        const body = document.createElement("div");
        body.className = "review-body";

        const name = document.createElement("span");
        name.className = "review-name";
        name.textContent = line.name;

        const meta = document.createElement("span");
        meta.className = "review-meta";

        const quantity = document.createElement("span");
        quantity.className = "review-qty";
        quantity.textContent =
            line.quantity == null ? "—" : String(line.quantity);
        meta.append(quantity);

        if (line.unit) {
            const unit = document.createElement("span");
            unit.className = "review-unit";
            unit.textContent = line.unit;
            meta.append(unit);
        }

        const confidence = document.createElement("span");
        confidence.className = "confidence";
        confidence.textContent = line.is_food
            ? `${Math.round(line.confidence * 100)}% confidence`
            : "non-food";
        meta.append(confidence);

        body.append(name, meta);
        row.append(check, body);
        reviewLinesEl.append(row);
    });
    reviewEl.classList.remove("hidden");
    reviewEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

dismissReviewEl?.addEventListener("click", () => {
    reviewState = null;
    reviewEl.classList.add("hidden");
    status("");
});

async function previewImage(input, endpoint, mode) {
    const file = input.files?.[0];
    if (!file) return status("Choose an image first.", true);
    if (file.size > 8 * 1024 * 1024)
        return status("Image exceeds the 8 MB Pantry limit.", true);
    const form = new FormData();
    form.append("file", file);
    try {
        status("Analyzing image…");
        const result = await api(endpoint, { method: "POST", body: form });
        renderReview(mode, result.preview, file.name);
        closeSheet(input.closest("dialog.sheet"));
        status("Review the detected items before applying them.");
    } catch (error) {
        status(error.message, true);
    }
}

$("#scan-pantry").addEventListener("click", () =>
    previewImage($("#pantry-photo"), "/api/app/pantry/scan-preview", "pantry"),
);
$("#scan-receipt").addEventListener("click", () =>
    previewImage(
        $("#receipt-photo"),
        "/api/app/purchases/receipt-preview",
        "receipt",
    ),
);

applyReviewEl.addEventListener("click", async () => {
    if (!reviewState) return;
    const checked = new Set(
        [
            ...reviewLinesEl.querySelectorAll('input[type="checkbox"]:checked'),
        ].map((input) => Number(input.dataset.index)),
    );
    try {
        let confirmation = "";
        if (reviewState.mode === "pantry") {
            const operations = reviewState.lines
                .map((line, index) => ({ line, index }))
                .filter(({ line, index }) => line.is_food && checked.has(index))
                .map(({ line }) => ({
                    action: "acquire",
                    name: line.name,
                    ...(line.quantity == null
                        ? {}
                        : { quantity: line.quantity }),
                    ...(line.unit ? { unit: line.unit } : {}),
                    location: line.location,
                    confidence: line.confidence,
                    quantity_mode:
                        line.quantity == null
                            ? "presence_only"
                            : line.confidence >= 0.95
                              ? "exact"
                              : "approximate",
                }));
            if (!operations.length)
                return status("Select at least one detected food.", true);
            await api("/api/app/pantry/reconcile", {
                method: "POST",
                body: JSON.stringify({
                    scope: currentScope(),
                    source_type: "pantry_scan",
                    idempotency_key: reviewState.idempotencyKey,
                    operations,
                }),
            });
            confirmation = `${operations.length} detected item${operations.length === 1 ? "" : "s"} added to Pantry.`;
        } else {
            const lines = reviewState.lines.map((line, index) => ({
                raw_label: line.raw_label,
                name: line.name,
                quantity: line.quantity,
                unit: line.unit,
                confidence: line.confidence,
                is_food: line.is_food,
                confirmed: checked.has(index),
                location: line.location,
            }));
            const result = await api("/api/app/purchases/reconcile", {
                method: "POST",
                body: JSON.stringify({
                    scope: currentScope(),
                    idempotency_key: reviewState.idempotencyKey,
                    source_label: reviewState.sourceLabel,
                    lines,
                }),
            });
            confirmation = `Receipt reconciled: ${result.summary.groceryMatched} Grocery match${result.summary.groceryMatched === 1 ? "" : "es"}, ${result.summary.inventoryAdded} new Pantry acquisition${result.summary.inventoryAdded === 1 ? "" : "s"}${result.summary.needsReview ? `, ${result.summary.needsReview} left unresolved` : ""}.`;
        }
        reviewState = null;
        reviewEl.classList.add("hidden");
        await loadPantry();
        status(confirmation);
    } catch (error) {
        status(error.message, true);
    }
});

function addTextList(parent, label, values) {
    if (!Array.isArray(values) || values.length === 0) return;
    const block = document.createElement("div");
    block.className = "idea-detail";
    const title = document.createElement("strong");
    title.textContent = label;
    const text = document.createElement("span");
    text.textContent = values.join(", ");
    block.append(title, text);
    parent.append(block);
}

function renderMealIdeas(result) {
    mealIdeasEl.replaceChildren();
    const candidates = result?.candidates || [];
    for (const candidate of candidates) {
        const card = document.createElement("article");
        card.className = "meal-idea-card";

        const head = document.createElement("div");
        head.className = "meal-idea-head";
        const titleWrap = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = candidate.name;
        const description = document.createElement("p");
        description.className = "muted";
        description.textContent = candidate.description;
        titleWrap.append(title, description);
        const badge = document.createElement("span");
        badge.className = "pill";
        badge.textContent =
            candidate.source === "saved_recipe"
                ? "Saved recipe"
                : candidate.readiness.replaceAll("_", " ");
        head.append(titleWrap, badge);
        card.append(head);

        const metrics = document.createElement("div");
        metrics.className = "idea-metrics";
        const nutrition = candidate.estimated_nutrition || {};
        const metricValues = [
            nutrition.protein_g == null
                ? null
                : `${Math.round(nutrition.protein_g)} g protein`,
            nutrition.calories == null
                ? null
                : `~${Math.round(nutrition.calories)} kcal`,
            candidate.total_minutes == null
                ? null
                : `${candidate.total_minutes} min`,
        ].filter(Boolean);
        for (const value of metricValues) {
            const metric = document.createElement("span");
            metric.textContent = value;
            metrics.append(metric);
        }
        if (metricValues.length) card.append(metrics);

        addTextList(card, "Flavor system", candidate.flavor_system);
        addTextList(card, "On hand", candidate.on_hand_ingredients);
        addTextList(card, "Assumed staples", candidate.assumed_staples);
        addTextList(card, "Missing", candidate.missing_required);
        addTextList(card, "Optional", candidate.missing_optional);
        addTextList(card, "Why it fits", candidate.why_it_fits);
        mealIdeasEl.append(card);
    }
    if (!candidates.length) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent =
            "No grounded meal ideas were returned for this Pantry.";
        mealIdeasEl.append(empty);
    }
}

mealIdeaForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(mealIdeaForm);
    const staples = String(form.get("assumed_staples") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 20);
    const maxMinutes = String(form.get("max_minutes") || "").trim();
    const button = $("#plan-meal");
    button.disabled = true;
    mealIdeasEl.replaceChildren();
    mealStatus(
        "Looking across your Pantry, fridge, freezer, seasonings, sauces, and saved recipes…",
    );
    try {
        const payload = await api("/api/app/pantry/meal-ideas", {
            method: "POST",
            body: JSON.stringify({
                scope: currentScope(),
                goal: String(form.get("goal") || "balanced"),
                meal_type: String(form.get("meal_type") || "dinner"),
                servings: Number(form.get("servings") || 2),
                ...(maxMinutes ? { max_minutes: Number(maxMinutes) } : {}),
                allow_missing_items: Number(
                    form.get("allow_missing_items") || 0,
                ),
                assumed_staples: staples,
            }),
        });
        renderMealIdeas(payload.result);
        const count = payload.result?.candidates?.length || 0;
        mealStatus(
            `Considered ${payload.context_summary?.pantry_items ?? "your"} Pantry items and ${payload.context_summary?.saved_recipe_candidates ?? 0} saved-recipe candidates; returned ${count} grounded meal idea${count === 1 ? "" : "s"}.`,
        );
    } catch (error) {
        const message =
            error.status === 503
                ? "Kitchen planning is not enabled on this Munch deployment yet."
                : error.message;
        mealStatus(message, true);
    } finally {
        button.disabled = false;
    }
});

// The feature-flag check runs first: on a Pantry-off account it has
// already redirected to Today, and the workspace never loads.
void applyFeatureFlags().then((pantryOn) => {
    if (pantryOn) loadSettings();
});
