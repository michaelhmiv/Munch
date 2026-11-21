import { requestJson } from "./app-api.js";
import { savedWeightUnit } from "./weight-display.js";

const patchDialog = document.getElementById("app-dialog");
const patchToastRegion = document.getElementById("toast-region");
const patchMealEditor = {
    mealId: null,
    options: new Map(),
    searchTimer: null,
};

const patchPrimaryNutrientFields = [
    ["calories", "Calories"],
    ["protein_g", "Protein (g)"],
    ["carbs_g", "Carbs (g)"],
    ["fat_g", "Fat (g)"],
];

const patchSecondaryNutrientFields = [
    ["fiber_g", "Fiber (g)"],
    ["sugar_g", "Sugar (g)"],
    ["alcohol_g", "Alcohol (g)"],
    ["sodium_mg", "Sodium (mg)"],
];

const patchNutrientFields = [
    ...patchPrimaryNutrientFields,
    ...patchSecondaryNutrientFields,
];

let lastPatchDialogTrigger = null;

function patchEscape(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function patchNumber(value, digits = 1) {
    if (value == null || Number.isNaN(Number(value))) return "";
    return Number(value).toFixed(digits).replace(/\.0+$/, "");
}

function patchToast(message, kind = "success") {
    if (!patchToastRegion) return;
    const element = document.createElement("div");
    element.className = "toast";
    element.textContent = message;
    if (kind === "error") element.style.borderColor = "var(--danger-700)";
    patchToastRegion.append(element);
    if (
        typeof patchToastRegion.showPopover === "function" &&
        !patchToastRegion.matches(":popover-open")
    ) {
        try {
            patchToastRegion.showPopover();
        } catch {}
    }
    window.setTimeout(() => {
        element.remove();
        if (
            patchToastRegion.childElementCount === 0 &&
            typeof patchToastRegion.hidePopover === "function" &&
            patchToastRegion.matches(":popover-open")
        ) {
            try {
                patchToastRegion.hidePopover();
            } catch {}
        }
    }, 4200);
}

// UX fix wave F1: the editor's data layer delegates to the shared
// platform transport (requestJson from app-api.js — the same import
// app.js uses, rewritten to the packaged runtime by
// scripts/build-mobile-web.ts). The previous raw relative fetch()
// resolved against the packaged origin (https://localhost), so every
// editor request 404'd against the local asset server and Edit /
// Duplicate were dead in the installed app for every meal; on the web
// it only worked because the page origin is the API origin.
async function patchApi(path, options = {}) {
    return requestJson(path, options);
}

async function fetchPatchedPreferredWeightUnit() {
    const cached = savedWeightUnit(
        document.documentElement.dataset.preferredWeightUnit,
    );
    if (cached) return cached;
    try {
        const data = await patchApi("/api/app/bootstrap", {
            cache: "no-store",
        });
        const unit = savedWeightUnit(data.profile?.preferred_weight_unit);
        if (unit) document.documentElement.dataset.preferredWeightUnit = unit;
        return unit;
    } catch {
        return null;
    }
}

async function fetchMealDetail(id) {
    return patchApi(`/api/app/meals/${encodeURIComponent(id)}`, {
        cache: "no-store",
    });
}

function showPatchedDialog(title, body) {
    if (!patchDialog.open && document.activeElement instanceof HTMLElement) {
        lastPatchDialogTrigger = document.activeElement;
    }
    patchDialog.innerHTML = `<div class="auth-card"><div class="panel-title"><h2 id="app-dialog-title">${patchEscape(title)}</h2><button class="button button-quiet button-small dialog-close" type="button" data-patch-close aria-label="Close dialog">Close</button></div>${body}</div>`;
    patchDialog.setAttribute("aria-labelledby", "app-dialog-title");
    if (!patchDialog.open) patchDialog.showModal();
}

function closePatchedDialog() {
    if (patchDialog.open) patchDialog.close();
    const trigger = lastPatchDialogTrigger;
    lastPatchDialogTrigger = null;
    if (trigger && trigger.isConnected) {
        try {
            trigger.focus();
        } catch {}
    }
}

function sourceLabel(item) {
    if (item.sourceType === "usda") return "USDA FoodData Central";
    if (item.sourceType === "open_food_facts") return "Open Food Facts";
    if (item.sourceType === "published_restaurant")
        return "Published restaurant nutrition";
    if (item.sourceType === "saved_food") return "Saved food snapshot";
    if (item.sourceType === "past_meal") return "Past meal snapshot";
    if (item.sourceType === "model_estimate") return "Model estimate";
    if (
        item.sourceType === "user_supplied" &&
        item.sourceSnapshot?.resolution_layer === "external_web"
    ) {
        return item.provider
            ? `External web · ${item.provider.replaceAll("_", " ")}`
            : "External web";
    }
    if (item.sourceType === "user_supplied") return "Provided nutrition";
    return item.provider || item.sourceType || "Source recorded";
}

function nutrientInput(name, label, value) {
    const serialized = value == null ? "" : String(value);
    return `<label class="field"><span>${patchEscape(label)}</span><input name="${patchEscape(name)}" type="number" min="0" step="0.1" inputmode="decimal" value="${patchEscape(serialized)}" data-original="${patchEscape(serialized)}" /></label>`;
}

function patchDateTimeValue(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function structuredItemEditor(meal) {
    if (!meal.items?.length) {
        return `<div class="meal-card spacer-top"><strong>Legacy aggregate entry</strong><p class="tiny">This meal predates item-level storage, so its original ingredient breakdown cannot be edited without inventing historical data.</p></div>`;
    }
    const targetOptions = meal.items
        .map(
            (item) =>
                `<option value="${patchEscape(item.id)}">Replace ${patchEscape(item.name)}</option>`,
        )
        .join("");
    const itemForms = meal.items
        .map((item) => {
            const n = item.nutrients || {};
            const confidence =
                item.confidence == null
                    ? ""
                    : ` · ${Math.round(item.confidence * 100)}% confidence`;
            const source = `${sourceLabel(item)}${confidence}`;
            const qtyPortion = [
                item.quantity == null ? "" : patchNumber(item.quantity, 2),
                item.portionLabel || "",
            ]
                .filter(Boolean)
                .join(" ");
            const summaryMeta = [qtyPortion, source]
                .filter(Boolean)
                .join(" · ");
            const primaryInputs = patchPrimaryNutrientFields
                .map(([key, label]) => nutrientInput(key, label, n[key]))
                .join("");
            const secondaryInputs = patchSecondaryNutrientFields
                .map(([key, label]) => nutrientInput(key, label, n[key]))
                .join("");
            return `<details class="editor-item-disclosure">
                <summary><span><strong>${patchEscape(item.name)}</strong><small>${patchEscape(summaryMeta)}</small></span><strong>${n.calories == null ? "—" : `${patchNumber(n.calories, 0)} kcal`}</strong></summary>
                <form class="auth-form spacer-top" data-patch-item-form data-meal-id="${patchEscape(meal.id)}" data-item-id="${patchEscape(item.id)}">
                    <label class="field"><span>Food name</span><input name="name" value="${patchEscape(item.name)}" data-original="${patchEscape(item.name)}" required /></label>
                    <div class="field-row-qty-unit">
                        <label class="field"><span>Quantity</span><input name="quantity" type="number" min="0.01" step="0.01" inputmode="decimal" value="${patchEscape(item.quantity ?? "")}" placeholder="—" /></label>
                        <label class="field"><span>Portion</span><input name="portion_label" value="${patchEscape(item.portionLabel ?? "")}" placeholder="e.g. 2 slices" /></label>
                    </div>
                    <div class="macro-grid-2x2">${primaryInputs}</div>
                    <details class="more-nutrients"><summary>More nutrients (Fiber, Sugar, Alcohol, Sodium)</summary><div class="form-grid">${secondaryInputs}</div></details>
                    ${item.sourceUrl ? `<a class="text-link tiny" href="${patchEscape(item.sourceUrl)}" target="_blank" rel="noreferrer">View nutrition source →</a>` : ""}
                    ${item.assumptions?.length ? `<p class="tiny">Assumptions: ${patchEscape(item.assumptions.join("; "))}</p>` : ""}
                    <div class="auth-actions"><button class="button button-secondary button-small" type="submit">Save food correction</button>${meal.items.length > 1 ? `<button class="button button-quiet button-small" type="button" data-patch-delete-item data-meal-id="${patchEscape(meal.id)}" data-item-id="${patchEscape(item.id)}" data-item-name="${patchEscape(item.name)}">Remove food</button>` : ""}</div>
                </form>
            </details>`;
        })
        .join("");
    const manualPrimaryFields = patchPrimaryNutrientFields
        .map(
            ([key, label]) =>
                `<label class="field"><span>${patchEscape(label)}</span><input name="${patchEscape(key)}" type="number" min="0" step="0.1" inputmode="decimal" /></label>`,
        )
        .join("");
    const manualSecondaryFields = patchSecondaryNutrientFields
        .map(
            ([key, label]) =>
                `<label class="field"><span>${patchEscape(label)}</span><input name="${patchEscape(key)}" type="number" min="0" step="0.1" inputmode="decimal" /></label>`,
        )
        .join("");
    return `<div class="panel-title spacer-top"><div><h3>Foods</h3><p>Tap a food to edit, or replace/add from search.</p></div><span>${meal.items.length}</span></div><details class="editor-item-disclosure spacer-top" data-patch-food-picker data-meal-id="${patchEscape(meal.id)}"><summary><span><strong>Replace or add food</strong><small>Search verified, saved, or recent foods</small></span></summary><div class="auth-form spacer-top"><label class="field"><span>Apply selection to</span><select id="patch-replace-target"><option value="">Add as a new food</option>${targetOptions}</select></label><form class="meal-composer-search-row meal-composer-search-row-slim" data-patch-food-search-form data-meal-id="${patchEscape(meal.id)}"><input class="input" name="query" id="patch-food-search" type="search" aria-label="Search foods" placeholder="Search oats, yogurt, chicken…" autocomplete="off" /><button class="button button-secondary button-small" type="submit">Search</button></form><div id="patch-food-results" class="meal-food-results"><p class="tiny">Loading personal and verified foods…</p></div></div></details><div class="meal-groups spacer-top">${itemForms}</div><details class="editor-item-disclosure spacer-top"><summary><strong>Add manual food</strong></summary><form class="auth-form spacer-top" data-patch-new-item-form data-meal-id="${patchEscape(meal.id)}"><label class="field"><span>Food name</span><input name="name" required /></label><div class="field-row-qty-unit"><label class="field"><span>Quantity</span><input name="quantity" type="number" min="0.01" step="0.01" inputmode="decimal" /></label><label class="field"><span>Portion</span><input name="portion_label" placeholder="e.g. 1 cup" /></label></div><div class="macro-grid-2x2">${manualPrimaryFields}</div><details class="more-nutrients"><summary>More nutrients (Fiber, Sugar, Alcohol, Sodium)</summary><div class="form-grid">${manualSecondaryFields}</div></details><div class="field-row-2up"><label class="field"><span>Source</span><select name="source_type"><option value="user_supplied">Label / manual value</option><option value="model_estimate">Estimate</option></select></label><label class="field"><span>Assumption or note</span><input name="assumption" placeholder="Optional" /></label></div><button class="button button-secondary button-small" type="submit">Add food</button></form></details>`;
}

function renderPatchFoodResults(data) {
    const root = document.getElementById("patch-food-results");
    if (!root) return;
    patchMealEditor.options.clear();
    const sections = [];
    if (data.candidates?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Verified foods</h4>${data.candidates
                .map((candidate, index) => {
                    const key = `candidate:${index}`;
                    patchMealEditor.options.set(key, {
                        kind: "candidate",
                        candidateId: candidate.candidate_id,
                        portionId: candidate.default_portion?.id,
                        label:
                            [candidate.brand, candidate.name]
                                .filter(Boolean)
                                .join(" — ") || candidate.name,
                        provider: candidate.provider,
                        calories: candidate.default_portion?.calories,
                    });
                    return `<button class="meal-search-result" type="button" data-patch-food-option data-key="${patchEscape(key)}"><span><strong>${patchEscape([candidate.brand, candidate.name].filter(Boolean).join(" — ") || candidate.name)}</strong><small>${patchEscape(candidate.provider || "Verified food")} · ${patchEscape(candidate.default_portion?.label || "Choose a portion in details")}</small></span><span>${candidate.default_portion?.calories == null ? "" : `${patchNumber(candidate.default_portion.calories, 0)} kcal`}</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    if (data.savedFoods?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Saved foods</h4>${data.savedFoods
                .map((saved, index) => {
                    const key = `saved:${index}`;
                    const portion =
                        saved.food?.portions?.find(
                            (item) => item.id === saved.defaultPortionId,
                        ) || saved.food?.portions?.[0];
                    patchMealEditor.options.set(key, {
                        kind: "saved",
                        savedFoodId: saved.id,
                        portionId: saved.defaultPortionId || portion?.id,
                        label: saved.label,
                        provider: saved.food?.provider,
                        calories: portion?.nutrients?.calories,
                    });
                    return `<button class="meal-search-result" type="button" data-patch-food-option data-key="${patchEscape(key)}"><span><strong>${patchEscape(saved.label)}</strong><small>Saved food · ${patchEscape(saved.food?.name || "Food snapshot")}</small></span><span>${portion?.nutrients?.calories == null ? "" : `${patchNumber(portion.nutrients.calories, 0)} kcal`}</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    if (data.recentMealItems?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Recent foods</h4>${data.recentMealItems
                .map((recent, index) => {
                    const key = `recent:${index}`;
                    patchMealEditor.options.set(key, {
                        kind: "recent",
                        recent,
                    });
                    return `<button class="meal-search-result" type="button" data-patch-food-option data-key="${patchEscape(key)}"><span><strong>${patchEscape(recent.name)}</strong><small>Recent meal · ${patchEscape(recent.portionLabel || "Portion not recorded")}</small></span><span>${recent.nutrients?.calories == null ? "" : `${patchNumber(recent.nutrients.calories, 0)} kcal`}</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    root.innerHTML =
        sections.join("") ||
        `<p class="tiny">No foods found. Try another search or add a manual food.</p>`;
}

async function searchPatchFoods(query) {
    const root = document.getElementById("patch-food-results");
    if (!root) return;
    root.innerHTML = `<p class="tiny">Searching personal and verified foods…</p>`;
    try {
        const data = await patchApi(
            `/api/app/food-search?query=${encodeURIComponent(query)}&limit=8`,
            { cache: "no-store" },
        );
        renderPatchFoodResults(data);
    } catch (error) {
        root.innerHTML = `<p class="tiny">${patchEscape(error.message || "Food search failed")}</p>`;
    }
}

function patchFoodBody(option, replacing) {
    if (option.kind === "candidate") {
        return {
            candidate_id: option.candidateId,
            portion_id: option.portionId,
            quantity: 1,
            ...(replacing ? { replace_item: true } : {}),
        };
    }
    if (option.kind === "saved") {
        return {
            saved_food_id: option.savedFoodId,
            portion_id: option.portionId,
            quantity: 1,
            ...(replacing ? { replace_item: true } : {}),
        };
    }
    const recent = option.recent;
    return {
        name: recent.name,
        quantity: 1,
        portion_label: recent.portionLabel || undefined,
        nutrients: recent.nutrients,
        source_type: "past_meal",
        provider: recent.provider || undefined,
        provider_food_id: recent.providerFoodId || undefined,
        source_snapshot: {
            resolution_layer: "personal_history",
            meal_id: recent.mealId,
            item_id: recent.itemId,
        },
        ...(replacing ? { replace_item: true } : {}),
    };
}

async function applyPatchFoodOption(key) {
    const option = patchMealEditor.options.get(key);
    const mealId = patchMealEditor.mealId;
    const target = document.getElementById("patch-replace-target")?.value || "";
    if (!option || !mealId) return;
    const replacing = Boolean(target);
    const path = replacing
        ? `/api/app/meals/${encodeURIComponent(mealId)}/items/${encodeURIComponent(target)}`
        : `/api/app/meals/${encodeURIComponent(mealId)}/items`;
    await patchApi(path, {
        method: replacing ? "PATCH" : "POST",
        body: JSON.stringify(patchFoodBody(option, replacing)),
    });
    patchToast(
        replacing
            ? "Food replaced and totals recalculated."
            : "Food added and totals recalculated.",
    );
    await showMealEditor(mealId);
    refreshCurrentView();
}

async function showMealEditor(id) {
    const { meal } = await fetchMealDetail(id);
    patchMealEditor.mealId = id;
    patchMealEditor.options.clear();
    const type = ["breakfast", "lunch", "dinner", "snack"].includes(
        meal.mealType,
    )
        ? meal.mealType
        : "snack";
    showPatchedDialog(
        "Edit meal",
        `<form id="edit-meal-form" class="auth-form" data-id="${patchEscape(id)}"><label class="field"><span>Description</span><textarea name="description" rows="2" required>${patchEscape(meal.description || "")}</textarea></label><div class="field-row-2up"><label class="field"><span>Meal type</span><select name="meal_type">${["breakfast", "lunch", "dinner", "snack"].map((value) => `<option value="${value}" ${value === type ? "selected" : ""}>${value}</option>`).join("")}</select></label><label class="field"><span>Logged at</span><input name="logged_at" type="datetime-local" value="${patchEscape(patchDateTimeValue(meal.loggedAt))}" required /></label></div><label class="field"><span>Notes</span><textarea name="notes" rows="2" maxlength="4000">${patchEscape(meal.notes || "")}</textarea></label><button class="button button-primary" type="submit">Save meal details</button></form>${structuredItemEditor(meal)}`,
    );
    void searchPatchFoods("");
}

function refreshCurrentView() {
    // The header band's Refresh button is gone; app.js re-renders the
    // current view when it receives this event (see the `app:refresh`
    // listener in app.js).
    document.dispatchEvent(new CustomEvent("app:refresh"));
}

document.addEventListener(
    "click",
    async (event) => {
        const close = event.target.closest("[data-patch-close]");
        if (close) {
            event.preventDefault();
            event.stopImmediatePropagation();
            closePatchedDialog();
            return;
        }

        // UX fix wave F4: removing a food from the editor uses the
        // same inline-confirmation pattern as the rest of the app
        // (app.js's showInlineConfirm markup/classes) instead of the
        // native window.confirm() — the native dialog silently reads
        // as "no" in WebViews without a JS-dialog handler, which made
        // this button a dead end in the installed app. First click
        // only asks, in place; the confirm click sends the DELETE;
        // dismiss re-renders the editor from server data, restoring
        // the item forms exactly (nothing was sent).
        const removeConfirm = event.target.closest(
            "[data-patch-delete-item-confirm]",
        );
        if (removeConfirm) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const mealId = removeConfirm.dataset.mealId || "";
            const itemId = removeConfirm.dataset.itemId || "";
            removeConfirm.disabled = true;
            try {
                await patchApi(
                    `/api/app/meals/${encodeURIComponent(mealId)}/items/${encodeURIComponent(itemId)}`,
                    { method: "DELETE" },
                );
                patchToast("Food removed and meal totals recalculated.");
                await showMealEditor(mealId);
                refreshCurrentView();
            } catch (error) {
                patchToast(error.message || "Could not remove food", "error");
                await showMealEditor(mealId);
            }
            return;
        }

        const removeDismiss = event.target.closest(
            "[data-patch-delete-item-dismiss]",
        );
        if (removeDismiss) {
            event.preventDefault();
            event.stopImmediatePropagation();
            await showMealEditor(removeDismiss.dataset.mealId || "");
            return;
        }

        const removeItem = event.target.closest("[data-patch-delete-item]");
        if (removeItem) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (removeItem.dataset.confirmPending) return;
            removeItem.dataset.confirmPending = "true";
            removeItem.style.display = "none";
            const mealId = removeItem.dataset.mealId || "";
            const itemId = removeItem.dataset.itemId || "";
            const itemName = removeItem.dataset.itemName || "this food";
            const box = document.createElement("div");
            box.className = "plan-inline-confirm";
            const note = document.createElement("p");
            note.className = "plan-inline-note is-destructive";
            note.setAttribute("role", "alert");
            note.textContent = `Remove ${itemName} from this meal?`;
            const confirmButton = document.createElement("button");
            confirmButton.type = "button";
            confirmButton.className =
                "button button-primary plan-inline-confirm-danger";
            confirmButton.dataset.patchDeleteItemConfirm = "";
            confirmButton.dataset.mealId = mealId;
            confirmButton.dataset.itemId = itemId;
            confirmButton.textContent = "Yes, remove food";
            const dismissButton = document.createElement("button");
            dismissButton.type = "button";
            dismissButton.className = "button button-secondary";
            dismissButton.dataset.patchDeleteItemDismiss = "";
            dismissButton.dataset.mealId = mealId;
            dismissButton.textContent = "Keep food";
            box.append(note, confirmButton, dismissButton);
            removeItem.insertAdjacentElement("afterend", box);
            confirmButton.focus();
            return;
        }

        const foodOption = event.target.closest("[data-patch-food-option]");
        if (foodOption) {
            event.preventDefault();
            event.stopImmediatePropagation();
            try {
                await applyPatchFoodOption(foodOption.dataset.key || "");
            } catch (error) {
                patchToast(
                    error.message || "Could not apply food selection",
                    "error",
                );
            }
            return;
        }

        const button = event.target.closest("[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        if (!action || !["edit-meal", "add-weight"].includes(action)) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        if (action === "edit-meal") {
            try {
                await showMealEditor(button.dataset.id || "");
            } catch (error) {
                patchToast(error.message || "Could not load meal", "error");
            }
            return;
        }

        const preferredUnit = await fetchPatchedPreferredWeightUnit();
        showPatchedDialog(
            "Add weight",
            `<form id="weight-form" class="auth-form"><div class="field-row-qty-unit"><label class="field"><span>Weight</span><input name="weight" type="number" min="1" step="0.1" inputmode="decimal" required /></label><label class="field"><span>Unit</span><select name="unit" required><option value="" disabled ${preferredUnit ? "" : "selected"}>Select unit</option><option value="lb" ${preferredUnit === "lb" ? "selected" : ""}>lb</option><option value="kg" ${preferredUnit === "kg" ? "selected" : ""}>kg</option></select></label></div><label class="field"><span>Notes</span><input name="notes" placeholder="Optional" /></label><button class="button button-primary" type="submit">Add weight</button></form>`,
        );
    },
    true,
);

document.addEventListener(
    "submit",
    async (event) => {
        const form = event.target;

        if (!(form instanceof HTMLFormElement)) return;
        if (form.matches("[data-patch-food-search-form]")) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const query = new FormData(form).get("query");
            await searchPatchFoods(String(query || ""));
            return;
        }
        if (form.matches("[data-patch-new-item-form]")) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const mealId = form.dataset.mealId || "";
            const values = Object.fromEntries(new FormData(form));
            const nutrients = {};
            for (const [field] of patchNutrientFields) {
                if (values[field] !== "") nutrients[field] = values[field];
            }
            const body = {
                name: values.name,
                ...(values.quantity !== ""
                    ? { quantity: values.quantity }
                    : {}),
                ...(values.portion_label !== ""
                    ? { portion_label: values.portion_label }
                    : {}),
                nutrients,
                source_type: values.source_type || "user_supplied",
                provider:
                    values.source_type === "model_estimate"
                        ? "manual_estimate"
                        : "user_correction",
                assumptions:
                    values.assumption === "" ? [] : [String(values.assumption)],
                source_snapshot: { resolution_layer: "website_manual_add" },
            };
            const submit = form.querySelector("button[type='submit']");
            if (submit) submit.disabled = true;
            try {
                await patchApi(
                    `/api/app/meals/${encodeURIComponent(mealId)}/items`,
                    { method: "POST", body: JSON.stringify(body) },
                );
                patchToast("Food added and meal totals recalculated.");
                await showMealEditor(mealId);
                refreshCurrentView();
            } catch (error) {
                patchToast(error.message || "Could not add food", "error");
            } finally {
                if (submit) submit.disabled = false;
            }
            return;
        }
        if (!form.matches("[data-patch-item-form]")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const mealId = form.dataset.mealId || "";
        const itemId = form.dataset.itemId || "";
        const values = Object.fromEntries(new FormData(form));
        const nutrients = {};
        for (const [field] of patchNutrientFields) {
            const input = form.elements.namedItem(field);
            if (
                input instanceof HTMLInputElement &&
                input.value !== "" &&
                input.value !== input.dataset.original
            ) {
                nutrients[field] = input.value;
            }
        }
        const nameInput = form.elements.namedItem("name");
        const body = {
            ...(nameInput instanceof HTMLInputElement &&
            nameInput.value !== nameInput.dataset.original
                ? { name: nameInput.value }
                : {}),
            ...(values.quantity !== "" ? { quantity: values.quantity } : {}),
            ...(values.portion_label !== ""
                ? { portion_label: values.portion_label }
                : {}),
            ...(Object.keys(nutrients).length ? { nutrients } : {}),
        };
        const submit = form.querySelector("button[type='submit']");
        if (submit) submit.disabled = true;
        try {
            await patchApi(
                `/api/app/meals/${encodeURIComponent(mealId)}/items/${encodeURIComponent(itemId)}`,
                {
                    method: "PATCH",
                    body: JSON.stringify(body),
                },
            );
            patchToast("Food updated and meal totals recalculated.");
            await showMealEditor(mealId);
            refreshCurrentView();
        } catch (error) {
            patchToast(error.message || "Could not update food", "error");
        } finally {
            if (submit) submit.disabled = false;
        }
    },
    true,
);

patchDialog.addEventListener("click", (event) => {
    if (
        event.target === patchDialog &&
        patchDialog.querySelector("[data-patch-close]")
    ) {
        closePatchedDialog();
    }
});
