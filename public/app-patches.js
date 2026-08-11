import { savedWeightUnit } from "./weight-display.js";

const patchDialog = document.getElementById("app-dialog");
const patchToastRegion = document.getElementById("toast-region");

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
    window.setTimeout(() => element.remove(), 4200);
}

async function patchApi(path, options = {}) {
    const response = await fetch(path, {
        credentials: "same-origin",
        headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
        },
        ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(data.message || data.error || "Request failed");
    return data;
}

async function fetchPatchedPreferredWeightUnit() {
    try {
        const data = await patchApi("/api/app/bootstrap", { cache: "no-store" });
        return savedWeightUnit(data.profile?.preferred_weight_unit);
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
    patchDialog.innerHTML = `<div class="auth-card"><div class="panel-title"><h2 style="font-size:1.6rem">${patchEscape(title)}</h2><button class="button button-quiet button-small" type="button" data-patch-close aria-label="Close dialog">Close</button></div>${body}</div>`;
    patchDialog.showModal();
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
    return `<label class="field"><span>${patchEscape(label)}</span><input name="${patchEscape(name)}" type="number" min="0" step="0.1" value="${patchEscape(serialized)}" data-original="${patchEscape(serialized)}" /></label>`;
}

function structuredItemEditor(meal) {
    if (!meal.items?.length) {
        return `<div class="meal-card spacer-top"><strong>Legacy aggregate entry</strong><p class="tiny">This meal predates item-level storage, so its original ingredient breakdown cannot be edited without inventing historical data.</p></div>`;
    }
    return `<div class="panel-title spacer-top"><div><h3>Foods</h3><p>Edit a food and Munch will recalculate the meal total from its items.</p></div><span>${meal.items.length}</span></div><div class="meal-groups">${meal.items
        .map((item) => {
            const n = item.nutrients || {};
            const confidence =
                item.confidence == null
                    ? ""
                    : ` · ${Math.round(item.confidence * 100)}% confidence`;
            const source = `${sourceLabel(item)}${confidence}`;
            return `<form class="meal-card auth-form" data-patch-item-form data-meal-id="${patchEscape(meal.id)}" data-item-id="${patchEscape(item.id)}">
                <div class="meal-card-head"><div><h4>${patchEscape(item.name)}</h4><small>${patchEscape(source)}</small></div><strong>${n.calories == null ? "—" : `${patchNumber(n.calories, 0)} kcal`}</strong></div>
                <div class="summary-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
                    <label class="field"><span>Quantity</span><input name="quantity" type="number" min="0.01" step="0.01" value="${patchEscape(item.quantity ?? "")}" placeholder="Not recorded" /></label>
                    <label class="field"><span>Portion</span><input name="portion_label" value="${patchEscape(item.portionLabel ?? "")}" placeholder="e.g. 2 slices" /></label>
                    ${nutrientInput("calories", "Calories", n.calories)}
                    ${nutrientInput("protein_g", "Protein (g)", n.protein_g)}
                    ${nutrientInput("carbs_g", "Carbs (g)", n.carbs_g)}
                    ${nutrientInput("fat_g", "Fat (g)", n.fat_g)}
                </div>
                ${item.sourceUrl ? `<a class="text-link tiny" href="${patchEscape(item.sourceUrl)}" target="_blank" rel="noreferrer">View nutrition source →</a>` : ""}
                ${item.assumptions?.length ? `<p class="tiny">Assumptions: ${patchEscape(item.assumptions.join("; "))}</p>` : ""}
                <div class="auth-actions"><button class="button button-secondary button-small" type="submit">Save food</button>${meal.items.length > 1 ? `<button class="button button-quiet button-small" type="button" data-patch-delete-item data-meal-id="${patchEscape(meal.id)}" data-item-id="${patchEscape(item.id)}" data-item-name="${patchEscape(item.name)}">Remove food</button>` : ""}</div>
            </form>`;
        })
        .join("")}</div>`;
}

async function showMealEditor(id) {
    const { meal } = await fetchMealDetail(id);
    const type = ["breakfast", "lunch", "dinner", "snack"].includes(
        meal.mealType,
    )
        ? meal.mealType
        : "snack";
    showPatchedDialog(
        "Edit meal",
        `<form id="edit-meal-form" class="auth-form" data-id="${patchEscape(id)}"><label class="field"><span>Description</span><textarea name="description" rows="3" required>${patchEscape(meal.description || "")}</textarea></label><label class="field"><span>Meal type</span><select name="meal_type">${["breakfast", "lunch", "dinner", "snack"].map((value) => `<option value="${value}" ${value === type ? "selected" : ""}>${value}</option>`).join("")}</select></label><button class="button button-primary" type="submit">Save meal details</button></form>${structuredItemEditor(meal)}`,
    );
}

function refreshCurrentView() {
    document.getElementById("refresh-button")?.click();
}

document.addEventListener(
    "click",
    async (event) => {
        const close = event.target.closest("[data-patch-close]");
        if (close) {
            event.preventDefault();
            event.stopImmediatePropagation();
            patchDialog.close();
            return;
        }

        const removeItem = event.target.closest("[data-patch-delete-item]");
        if (removeItem) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const mealId = removeItem.dataset.mealId || "";
            const itemId = removeItem.dataset.itemId || "";
            const itemName = removeItem.dataset.itemName || "this food";
            if (!confirm(`Remove ${itemName} from this meal?`)) return;
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
            }
            return;
        }

        const button = event.target.closest("[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        if (
            !action ||
            !["edit-meal", "duplicate-meal", "add-water", "add-weight"].includes(
                action,
            )
        ) {
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

        if (action === "duplicate-meal") {
            const id = button.dataset.id || "";
            try {
                await patchApi(`/api/app/meals/${encodeURIComponent(id)}/copy`, {
                    method: "POST",
                    body: "{}",
                });
                patchToast("Meal duplicated with its original food sources.");
                refreshCurrentView();
            } catch (error) {
                patchToast(error.message || "Could not duplicate meal", "error");
            }
            return;
        }

        if (action === "add-water") {
            showPatchedDialog(
                "Add water",
                `<form id="water-form" class="auth-form"><label class="field"><span>Amount (milliliters)</span><input name="amount_ml" type="number" min="1" max="20000" value="350" inputmode="numeric" required /></label><label class="field"><span>Notes</span><input name="notes" placeholder="Optional" /></label><button class="button button-primary" type="submit">Add water</button></form>`,
            );
            return;
        }

        const preferredUnit = await fetchPatchedPreferredWeightUnit();
        showPatchedDialog(
            "Add weight",
            `<form id="weight-form" class="auth-form"><label class="field"><span>Weight</span><input name="weight" type="number" min="1" step="0.1" inputmode="decimal" required /></label><label class="field"><span>Unit</span><select name="unit" required><option value="" disabled ${preferredUnit ? "" : "selected"}>Select unit</option><option value="lb" ${preferredUnit === "lb" ? "selected" : ""}>lb</option><option value="kg" ${preferredUnit === "kg" ? "selected" : ""}>kg</option></select></label><label class="field"><span>Notes</span><input name="notes" placeholder="Optional" /></label><button class="button button-primary" type="submit">Add weight</button></form>`,
        );
    },
    true,
);

document.addEventListener(
    "submit",
    async (event) => {
        const form = event.target;
        if (
            !(form instanceof HTMLFormElement) ||
            !form.matches("[data-patch-item-form]")
        )
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const mealId = form.dataset.mealId || "";
        const itemId = form.dataset.itemId || "";
        const values = Object.fromEntries(new FormData(form));
        const nutrients = {};
        for (const field of ["calories", "protein_g", "carbs_g", "fat_g"]) {
            const input = form.elements.namedItem(field);
            if (
                input instanceof HTMLInputElement &&
                input.value !== "" &&
                input.value !== input.dataset.original
            ) {
                nutrients[field] = input.value;
            }
        }
        const body = {
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
    if (event.target === patchDialog) patchDialog.close();
});
