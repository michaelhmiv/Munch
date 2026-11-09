import { requestJson as api } from "./app-api.js";

const $ = (selector) => document.querySelector(selector);
const enabledToggle = $("#pantry-enabled");
const workspace = $("#workspace");
const premiumMessage = $("#premium-message");
const statusEl = $("#status");
const inventoryEl = $("#inventory");
const emptyEl = $("#empty");
const itemCountEl = $("#item-count");
const scopeEl = $("#scope");
const searchEl = $("#search");
const locationEl = $("#location-filter");

let premium = false;

function status(message, error = false) {
    statusEl.textContent = message || "";
    statusEl.style.color = error ? "#9b2c2c" : "#555";
}

function currentScope() {
    return scopeEl.value || "personal";
}

async function loadSettings() {
    try {
        const settings = await api("/api/app/pantry/settings");
        premium = settings.premium === true;
        enabledToggle.checked = settings.enabled === true;
        if (
            settings.household_available &&
            !scopeEl.querySelector('option[value="household"]')
        ) {
            const option = document.createElement("option");
            option.value = "household";
            option.textContent = "Household Pantry";
            scopeEl.append(option);
        }
        premiumMessage.classList.toggle("hidden", premium);
        workspace.classList.toggle("hidden", !premium || !settings.enabled);
        if (settings.enabled) await loadPantry();
    } catch (error) {
        if (error.status === 403) {
            premium = false;
            premiumMessage.classList.remove("hidden");
            enabledToggle.disabled = true;
            workspace.classList.add("hidden");
            return;
        }
        status(error.message, true);
    }
}

async function setEnabled(enabled) {
    try {
        status(enabled ? "Enabling Pantry…" : "Disabling Pantry…");
        const result = await api("/api/app/pantry/settings", {
            method: "PATCH",
            body: JSON.stringify({ enabled }),
        });
        enabledToggle.checked = result.enabled;
        workspace.classList.toggle("hidden", !result.enabled);
        status(
            result.enabled
                ? "Pantry enabled. ChatGPT will expose Pantry tools on the next app refresh."
                : "Pantry disabled. Existing inventory is preserved.",
        );
        if (result.enabled) await loadPantry();
    } catch (error) {
        enabledToggle.checked = !enabled;
        status(error.message, true);
    }
}

enabledToggle.addEventListener("change", () =>
    setEnabled(enabledToggle.checked),
);

function quantityLabel(item) {
    if (item.quantity == null)
        return item.stock_state === "low" ? "Low" : "On hand";
    const prefix = item.quantity_mode === "approximate" ? "≈ " : "";
    return `${prefix}${Number(item.quantity).toLocaleString()}${item.unit ? ` ${item.unit}` : ""}`;
}

function renderInventory(items) {
    inventoryEl.replaceChildren();
    itemCountEl.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
    emptyEl.classList.toggle("hidden", items.length !== 0);
    for (const item of items) {
        const row = document.createElement("div");
        row.className = `inventory-row stock-${item.stock_state}`;
        const name = document.createElement("div");
        name.innerHTML = `<strong></strong><small></small>`;
        name.querySelector("strong").textContent = item.name;
        name.querySelector("small").textContent =
            item.food_provider && item.provider_food_id
                ? `${item.food_provider} · verified identity`
                : item.quantity_mode.replaceAll("_", " ");
        const quantity = document.createElement("div");
        quantity.textContent = quantityLabel(item);
        const unit = document.createElement("div");
        unit.className = "inventory-unit";
        unit.textContent = item.unit || "—";
        const location = document.createElement("div");
        location.className = "inventory-location";
        location.textContent = item.location;
        const actions = document.createElement("div");
        const finished = document.createElement("button");
        finished.type = "button";
        finished.className = "secondary";
        finished.textContent =
            item.stock_state === "depleted" ? "Depleted" : "Finished";
        finished.disabled = item.stock_state === "depleted";
        finished.addEventListener("click", () =>
            reconcileOperations(
                [{ action: "consume_all", inventory_item_id: item.id }],
                "correction",
            ),
        );
        actions.append(finished);
        row.append(name, quantity, unit, location, actions);
        inventoryEl.append(row);
    }
}

async function loadPantry() {
    if (!premium || !enabledToggle.checked) return;
    try {
        status("Loading Pantry…");
        const query = new URLSearchParams({ scope: currentScope() });
        if (searchEl.value.trim()) query.set("q", searchEl.value.trim());
        if (locationEl.value) query.set("location", locationEl.value);
        const pantry = await api(`/api/app/pantry?${query}`);
        renderInventory(pantry.items || []);
        status("");
    } catch (error) {
        status(error.message, true);
    }
}

$("#refresh").addEventListener("click", loadPantry);
scopeEl.addEventListener("change", loadPantry);
locationEl.addEventListener("change", loadPantry);
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
    } catch (error) {
        status(error.message, true);
    }
}

$("#manual-add").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const quantity = form.get("quantity");
    const operation = {
        action: "acquire",
        name: String(form.get("name") || "").trim(),
        location: String(form.get("location") || "unspecified"),
    };
    if (quantity !== "") operation.quantity = Number(quantity);
    if (form.get("unit")) operation.unit = String(form.get("unit"));
    await reconcileOperations([operation]);
    event.currentTarget.reset();
});

loadSettings();
