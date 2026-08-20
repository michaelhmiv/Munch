import {
    displayWeightUnit,
    savedWeightUnit,
    weightFromGrams,
} from "./weight-display.js";
import {
    accountRoutes,
    accountTitles,
    handleAccountAction,
    handleAccountSubmit,
    isAccountRoute,
    renderAccountRoute,
} from "./app-account.js";

const state = {
    bootstrap: null,
    route: "today",
    date: null,
    insightsDays: 30,
    controller: null,
};

const mealComposer = {
    items: [],
    options: new Map(),
    searchTimer: null,
};

const mealDraftReview = {
    draft: null,
    options: new Map(),
    pendingManual: [],
    searchTimer: null,
};

const recipeComposer = {
    ingredients: [],
    options: new Map(),
    searchTimer: null,
};

const recipeNutrientFields = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "sodium_mg",
];

const content = document.getElementById("app-content");
const pageTitle = document.getElementById("page-title");
const pageKicker = document.getElementById("page-kicker");
const refreshButton = document.getElementById("refresh-button");
const quickAction = document.getElementById("quick-action");
const toastRegion = document.getElementById("toast-region");
const dialog = document.getElementById("app-dialog");

const routes = {
    "/app": "today",
    "/app/": "today",
    "/app/log": "log",
    "/app/insights": "insights",
    "/app/foods": "foods",
    "/app/recipes": "recipes",
    "/app/plan": "plan",
    "/app/groceries": "groceries",
    ...accountRoutes,
};

const titles = {
    today: ["Daily workspace", "Today"],
    log: ["Nutrition history", "Food Log"],
    insights: ["Patterns and progress", "Insights"],
    foods: ["Reusable nutrition data", "Foods"],
    recipes: ["Structured cooking memory", "Recipes"],
    plan: ["Personal and household", "Meal Plan"],
    groceries: ["Shopping workspace", "Groceries"],
    ...accountTitles,
};

const sourceLabels = {
    usda: "USDA",
    open_food_facts: "Open Food Facts",
    published_restaurant: "Published restaurant",
    saved_food: "Saved food",
    past_meal: "Past meal",
    user_supplied: "User supplied",
    model_estimate: "Estimated",
    legacy_aggregate: "Legacy entry",
};

const sourceClasses = {
    usda: "source-usda",
    open_food_facts: "source-off",
    published_restaurant: "source-restaurant",
    saved_food: "source-saved",
    past_meal: "source-saved",
    user_supplied: "confidence-chip",
    model_estimate: "source-estimate",
    legacy_aggregate: "confidence-chip",
};

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function dateInTimezone(timeZone) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timeZone || "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const parts = Object.fromEntries(
        formatter
            .formatToParts(new Date())
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDate(date, days) {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function formatDate(date, options = {}) {
    return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: options.year ? "numeric" : undefined,
        weekday: options.weekday ? "long" : undefined,
        timeZone: "UTC",
    }).format(new Date(`${date}T12:00:00Z`));
}

function formatTime(value) {
    if (!value) return "Time not recorded";
    return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: state.bootstrap?.profile?.timezone || "UTC",
    }).format(new Date(value));
}

function number(value, digits = 0) {
    if (value == null || Number.isNaN(Number(value))) return "—";
    return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: digits,
    }).format(Number(value));
}

function percent(value, target) {
    if (!target || target <= 0) return null;
    return Math.max(
        0,
        Math.min(100, Math.round((Number(value || 0) / target) * 100)),
    );
}

function sourceBadge(type) {
    const label = sourceLabels[type] || type || "Source unavailable";
    const className = sourceClasses[type] || "confidence-chip";
    return `<span class="source-chip ${className}">${escapeHtml(label)}</span>`;
}

function confidenceBadge(value) {
    if (value == null) return "";
    const label =
        value >= 0.85
            ? "High confidence"
            : value >= 0.6
              ? "Medium confidence"
              : "Low confidence";
    return `<span class="confidence-chip">${label}</span>`;
}

function toast(message, kind = "success") {
    const element = document.createElement("div");
    element.className = "toast";
    element.textContent = message;
    if (kind === "error") element.style.borderColor = "var(--danger-700)";
    toastRegion.append(element);
    window.setTimeout(() => element.remove(), 4200);
}

async function api(path, options = {}) {
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    if (!options.keepPrevious) state.controller = controller;
    const response = await fetch(path, {
        credentials: "same-origin",
        headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
        },
        ...options,
        signal: options.signal || controller.signal,
    });
    if (response.status === 401) {
        location.href = `/connect/sign-in?return_to=${encodeURIComponent(location.pathname + location.search)}`;
        throw new Error("Authentication required");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(data.message || data.error || "Request failed");
    return data;
}

function setLoading(label = "Loading your Munch workspace…") {
    content.innerHTML = `<div class="loading-state"><div><div class="skeleton" style="width:180px;height:18px"></div><div class="skeleton spacer-top" style="width:min(70vw,360px);height:54px"></div><p class="spacer-top">${escapeHtml(label)}</p></div></div>`;
}

function errorState(error) {
    if (error?.name === "AbortError") return;
    content.innerHTML = `<div class="error-state"><div><h2>That view could not be loaded.</h2><p>${escapeHtml(error?.message || "An unexpected error occurred.")}</p><button class="button button-primary spacer-top" data-action="refresh">Try again</button></div></div>`;
}

function setActiveRoute(route) {
    const moreRoutes = new Set([
        "more",
        "household",
        "insights",
        "foods",
        "recipes",
        "settings",
        "settings-profile",
        "settings-goals",
        "settings-billing",
        "settings-connections",
        "settings-data",
        "settings-account",
    ]);
    const primaryRoute = route.startsWith("settings-") ? "settings" : route;
    document.querySelectorAll("[data-route]").forEach((link) => {
        const requested = link.dataset.route;
        const active =
            requested === primaryRoute ||
            (requested === "more" && moreRoutes.has(route));
        link.classList.toggle("is-active", active);
        if (active) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
    });
    const [kicker, title] = titles[route] || titles.today;
    pageKicker.textContent = kicker;
    pageTitle.textContent = title;
    document.title = `${title} — Munch`;
}

function metricCard(label, value, unit, target, primary = false) {
    const progress = percent(value, target);
    return `<article class="summary-card ${primary ? "primary" : ""}"><span>${escapeHtml(label)}</span><strong>${number(value, 1)}${unit ? `<small>${escapeHtml(unit)}</small>` : ""}</strong><small>${target ? `${number(target, 1)} ${escapeHtml(unit)} target` : "No target set"}</small>${progress == null ? "" : `<div class="progress" aria-label="${progress}% of target"><span style="width:${progress}%"></span></div>`}</article>`;
}

function mealItems(items) {
    if (!items?.length)
        return `<div class="food-items"><div class="food-row"><div><strong>Legacy aggregate entry</strong><small>Item-level details were not recorded for this meal.</small></div></div></div>`;
    return `<div class="food-items">${items
        .map(
            (item) =>
                `<div class="food-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.portionLabel || (item.quantity ? `${number(item.quantity, 2)} serving` : "Portion not recorded"))}</small><div class="demo-source-row">${sourceBadge(item.sourceType)}${confidenceBadge(item.confidence)}</div>${item.assumptions?.length ? `<small>Assumptions: ${escapeHtml(item.assumptions.join("; "))}</small>` : ""}</div><strong>${item.calories == null ? "—" : `${number(item.calories)} kcal`}</strong></div>`,
        )
        .join("")}</div>`;
}

function mealCard(meal) {
    const type = meal.meal_type || "snack";
    return `<article class="meal-card" data-meal-id="${escapeHtml(meal.id)}"><div class="meal-card-head"><div><h4>${escapeHtml(meal.description || "Untitled meal")}</h4><div class="meal-meta"><span>${escapeHtml(formatTime(meal.logged_at))}</span><span>${escapeHtml(type)}</span>${meal.notes ? `<span>${escapeHtml(meal.notes)}</span>` : ""}</div></div><strong>${meal.calories == null ? "—" : `${number(meal.calories)} kcal`}</strong></div><div class="meal-macros"><span class="macro-chip">Protein ${number(meal.protein_g, 1)}g</span><span class="macro-chip">Carbs ${number(meal.carbs_g, 1)}g</span><span class="macro-chip">Fat ${number(meal.fat_g, 1)}g</span>${meal.fiber_g == null ? "" : `<span class="macro-chip">Fiber ${number(meal.fiber_g, 1)}g</span>`}${meal.sugar_g == null ? "" : `<span class="macro-chip">Sugar ${number(meal.sugar_g, 1)}g</span>`}</div>${mealItems(meal.items)}<div class="auth-actions"><button class="button button-secondary button-small" data-action="edit-meal" data-id="${escapeHtml(meal.id)}">Edit</button><button class="button button-quiet button-small" data-action="duplicate-meal" data-id="${escapeHtml(meal.id)}">Duplicate</button><button class="button button-quiet button-small" data-action="delete-meal" data-id="${escapeHtml(meal.id)}">Delete</button></div></article>`;
}

function groupedMeals(meals) {
    const order = ["breakfast", "lunch", "dinner", "snack"];
    const groups = Object.groupBy(
        meals || [],
        (meal) => meal.meal_type || "snack",
    );
    return `<div class="meal-groups">${order
        .map((type) => {
            const entries = groups[type] || [];
            const total = entries.reduce(
                (sum, meal) => sum + (meal.calories || 0),
                0,
            );
            return `<section class="meal-group"><header class="meal-group-header"><div><span class="meal-dot ${type}"></span><strong>${type[0].toUpperCase() + type.slice(1)}</strong></div><span>${entries.length ? `${number(total)} kcal` : "No entries"}</span></header>${entries.length ? entries.map(mealCard).join("") : `<div class="meal-card"><p>No ${type} logged.</p></div>`}</section>`;
        })
        .join("")}</div>`;
}

function pendingDraftCard(draft) {
    const status =
        draft.openQuestionCount > 0
            ? `${draft.openQuestionCount} question${draft.openQuestionCount === 1 ? "" : "s"} remaining`
            : draft.status === "awaiting_confirmation"
              ? "Ready for confirmation"
              : "Needs review";
    return `<article class="meal-card"><strong>${escapeHtml(draft.description || `${draft.sourceMode} meal`)}</strong><p>${escapeHtml(status)} · ${draft.itemCount} item${draft.itemCount === 1 ? "" : "s"}</p><div class="auth-actions"><button class="button button-secondary button-small" type="button" data-action="open-meal-draft" data-id="${escapeHtml(draft.id)}">Review draft</button></div></article>`;
}

async function renderToday() {
    setLoading("Loading today’s meals and progress…");
    const data = await api(
        `/api/app/today?date=${encodeURIComponent(state.date)}`,
    );
    const goals = data.goals || {};
    const latestWeight = data.weight?.at(-1);
    const weightUnit = displayWeightUnit(
        state.bootstrap?.profile?.preferred_weight_unit,
    );
    const latestWeightValue = latestWeight
        ? weightFromGrams(latestWeight.weight_g, weightUnit)
        : null;
    content.innerHTML = `<div class="page-heading"><div><h2>${escapeHtml(formatDate(state.date, { weekday: true }))}</h2><p>Your structured nutrition record for this day.</p></div><div class="auth-actions"><button class="button button-secondary button-small" data-action="date-prev">Previous</button><button class="button button-secondary button-small" data-action="date-today">Today</button><button class="button button-secondary button-small" data-action="date-next">Next</button></div></div><div class="dashboard-grid"><section class="panel panel-span-12"><div class="summary-grid">${metricCard("Calories", data.totals.calories, " kcal", goals.daily_calories, true)}${metricCard("Protein", data.totals.proteinG, "g", goals.daily_protein_g)}${metricCard("Carbohydrates", data.totals.carbsG, "g", goals.daily_carbs_g)}${metricCard("Fat", data.totals.fatG, "g", goals.daily_fat_g)}</div></section><section class="panel panel-span-8"><div class="panel-title"><h3>Meals</h3><span>${data.meals.length} logged</span></div>${groupedMeals(data.meals)}</section><aside class="panel panel-span-4"><div class="panel-title"><h3>Daily details</h3></div><div class="summary-grid" style="grid-template-columns:1fr 1fr">${metricCard("Water", data.water.totalMl, " ml", goals.daily_water_ml)}${metricCard("Weight", latestWeightValue, ` ${weightUnit}`, null)}</div><div class="auth-actions"><button class="button button-secondary button-small" data-action="add-water">Add water</button><button class="button button-secondary button-small" data-action="add-weight">Add weight</button></div>${data.drafts?.length ? `<div class="panel-title spacer-top"><h3>Pending drafts</h3><span>${data.drafts.length}</span></div><div class="meal-groups">${data.drafts.map(pendingDraftCard).join("")}</div>` : ""}${data.plannedMeals?.length ? `<div class="panel-title spacer-top"><h3>Planned today</h3><span>${data.plannedMeals.length}</span></div>${data.plannedMeals.map((meal) => `<div class="food-row"><div><strong>${escapeHtml(meal.recipe_name)}</strong><small>${escapeHtml(meal.meal_slot || "Meal")} · ${number(meal.servings, 1)} servings</small></div><span>${meal.nutrition_per_serving?.calories ? `${number(meal.nutrition_per_serving.calories * meal.servings)} kcal` : ""}</span></div>`).join("")}` : ""}</aside></div>`;
}

async function renderLog() {
    setLoading("Loading your food history…");
    const data = await api(
        `/api/app/meals?start=${encodeURIComponent(state.date)}&end=${encodeURIComponent(state.date)}`,
    );
    content.innerHTML = `<div class="page-heading"><div><h2>${escapeHtml(formatDate(state.date, { weekday: true }))}</h2><p>Review meals, item-level provenance, notes, and totals.</p></div><div class="auth-actions"><button class="button button-secondary button-small" data-action="date-prev">Previous</button><button class="button button-secondary button-small" data-action="date-today">Today</button><button class="button button-secondary button-small" data-action="date-next">Next</button></div></div><section class="panel"><div class="summary-grid">${metricCard("Calories", data.totals.calories, " kcal", null, true)}${metricCard("Protein", data.totals.proteinG, "g", null)}${metricCard("Carbohydrates", data.totals.carbsG, "g", null)}${metricCard("Fat", data.totals.fatG, "g", null)}</div></section><div class="spacer-top">${groupedMeals(data.meals)}</div>`;
}

function barChart(days, key, label, unit = "") {
    const values = days.map((day) => Number(day.totals[key] || 0));
    const max = Math.max(1, ...values);
    return `<div role="img" aria-label="${escapeHtml(label)} by logged day" style="display:flex;align-items:flex-end;gap:5px;height:190px;padding-top:20px">${days
        .map((day, index) => {
            const height = Math.max(2, Math.round((values[index] / max) * 150));
            return `<div style="display:flex;min-width:0;flex:1;flex-direction:column;align-items:center;justify-content:flex-end;height:100%"><span class="tiny">${number(values[index])}</span><div style="width:100%;max-width:24px;height:${height}px;border-radius:7px 7px 2px 2px;background:var(--green-600)"></div><span class="tiny">${escapeHtml(day.date.slice(5))}</span></div>`;
        })
        .join(
            "",
        )}</div><p class="tiny">${escapeHtml(label)} is shown for logged days only${unit ? ` in ${escapeHtml(unit)}` : ""}.</p>`;
}

async function renderInsights() {
    setLoading("Calculating trends and patterns…");
    const end = state.date;
    const days = [7, 30, 90].includes(state.insightsDays)
        ? state.insightsDays
        : 30;
    const start = shiftDate(end, -(days - 1));
    const data = await api(`/api/app/insights?start=${start}&end=${end}`);
    const rangeButtons = [7, 30, 90]
        .map(
            (range) =>
                `<button class="button ${range === days ? "button-primary" : "button-secondary"} button-small" data-action="insight-range" data-days="${range}" aria-pressed="${range === days}">${range} days</button>`,
        )
        .join("");
    content.innerHTML = `<div class="page-heading"><div><h2>Last ${days} days</h2><p>${data.loggedDays} logged days and ${data.mealCount} meals from ${escapeHtml(formatDate(start))} through ${escapeHtml(formatDate(end))}.</p></div><div class="auth-actions">${rangeButtons}</div></div><div class="dashboard-grid"><section class="panel panel-span-12"><div class="summary-grid">${metricCard("Average calories", data.averages.calories, " kcal", null, true)}${metricCard("Average protein", data.averages.proteinG, "g", null)}${metricCard("Average carbs", data.averages.carbsG, "g", null)}${metricCard("Average fat", data.averages.fatG, "g", null)}</div></section><section class="panel panel-span-8"><div class="panel-title"><h3>Daily calories</h3><span>${data.loggedDays} days</span></div>${data.days.length ? barChart(data.days, "calories", "Daily calories", "kilocalories") : `<div class="empty-state"><div><h3>No logged days</h3><p>Log meals to build a trend.</p></div></div>`}</section><section class="panel panel-span-4"><div class="panel-title"><h3>Coverage</h3></div><div class="summary-grid" style="grid-template-columns:1fr 1fr">${metricCard("Logged days", data.loggedDays, "", null)}${metricCard("Calendar days", data.calendarDays, "", null)}${metricCard("Meals", data.mealCount, "", null)}${metricCard("Meals per logged day", data.loggedDays ? data.mealCount / data.loggedDays : 0, "", null)}</div><p class="tiny spacer-top">Averages exclude days with no meal records. Missing nutrients are not automatically treated as confirmed zero values in source-level records.</p></section></div>`;
}

async function renderFoods() {
    setLoading("Loading saved foods…");
    const data = await api("/api/app/foods");
    content.innerHTML = `<div class="page-heading"><div><h2>Saved foods</h2><p>${data.total} reusable food${data.total === 1 ? "" : "s"}${data.limit ? ` of ${data.limit}` : ""}.</p></div><div class="auth-actions"><input class="input" id="food-filter" type="search" placeholder="Filter saved foods" aria-label="Filter saved foods" /></div></div><section class="panel"><div id="food-list">${data.foods.length ? `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Food</th><th>Source</th><th>Default portion</th><th>Used</th><th>Last used</th></tr></thead><tbody>${data.foods.map((food) => `<tr data-food-label="${escapeHtml(food.label.toLowerCase())}"><td><strong>${escapeHtml(food.label)}</strong><br /><small>${escapeHtml(food.food?.brand || food.food?.name || "")}</small></td><td>${sourceBadge(food.provider)}</td><td>${escapeHtml(food.defaultPortionId || "Choose when logging")}</td><td>${number(food.useCount)}</td><td>${food.lastUsedAt ? escapeHtml(formatDate(food.lastUsedAt.slice(0, 10), { year: true })) : "Never"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><div><h3>No saved foods yet</h3><p>Confirm a provider food in ChatGPT, then save it for reuse.</p></div></div>`}</div></section>`;
}

function premiumUnavailable(title, description) {
    return `<div class="empty-state"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><a class="button button-primary spacer-top" href="/app/settings/billing">View website options</a></div></div>`;
}

async function planningData() {
    const start = shiftDate(
        state.date,
        -((new Date(`${state.date}T12:00:00Z`).getUTCDay() + 6) % 7),
    );
    return api(`/api/app/planning?start=${start}&end=${shiftDate(start, 6)}`);
}

async function renderRecipes() {
    setLoading("Loading recipes…");
    const data = await planningData();
    if (!data.available) {
        content.innerHTML = premiumUnavailable(
            "Recipe workspace is not available for this account",
            "Recipes are managed from the Munch website when the account has recipe capability.",
        );
        return;
    }
    const canCreate = Boolean(
        state.bootstrap?.capabilities?.recipeWrite ||
        state.bootstrap?.capabilities?.householdRecipeWrite,
    );
    const createButton = canCreate
        ? '<button class="button button-primary button-small" data-action="create-recipe">Create recipe</button>'
        : "";
    content.innerHTML = `<div class="page-heading"><div><h2>Recipe library</h2><p>${data.recipes.length} structured recipe${data.recipes.length === 1 ? "" : "s"}.</p></div><div class="auth-actions">${createButton}<input class="input" id="recipe-filter" type="search" placeholder="Filter recipes" aria-label="Filter recipes" /></div></div><div class="capability-grid" id="recipe-grid">${data.recipes.length ? data.recipes.map((recipe) => `<article class="capability-card" data-recipe-name="${escapeHtml(recipe.name.toLowerCase())}"><span class="source-chip ${recipe.ownership === "household" ? "source-saved" : "source-usda"}">${escapeHtml(recipe.ownership)}</span><h3 class="spacer-top">${escapeHtml(recipe.name)}</h3><p>${number(recipe.servings, 1)} servings · ${escapeHtml(recipe.nutrition_status)}</p><div class="meal-macros"><span class="macro-chip">${number(recipe.nutrition_per_serving?.calories)} kcal</span><span class="macro-chip">P ${number(recipe.nutrition_per_serving?.protein_g, 1)}g</span><span class="macro-chip">C ${number(recipe.nutrition_per_serving?.carbs_g, 1)}g</span><span class="macro-chip">F ${number(recipe.nutrition_per_serving?.fat_g, 1)}g</span></div><p class="tiny spacer-top">Scheduled ${number(recipe.times_scheduled)} times · logged ${number(recipe.times_logged)} times</p><button class="button button-secondary button-small spacer-top" type="button" data-action="view-recipe" data-id="${escapeHtml(recipe.recipe_id)}">View recipe</button></article>`).join("") : `<div class="empty-state"><div><h3>No recipes yet</h3><p>Start with a structured recipe here, or save one from ChatGPT.</p>${canCreate ? '<button class="button button-primary spacer-top" type="button" data-action="create-recipe">Create your first recipe</button>' : ""}</div></div>`}</div>`;
}

function recipeIngredientFromFood(food, portionId) {
    const portion = foodPortion(food, portionId);
    if (!portion) throw new Error("Food has no usable portion");
    const candidateId = food.candidate_id;
    return {
        name: foodTitle(food),
        quantity: 1,
        unit: portion.label,
        preparation: "",
        optional: false,
        gramWeight: portion.gram_weight ?? undefined,
        nutrients: portion.nutrients || {},
        provider: food.provider,
        providerFoodId: food.provider_food_id,
        sourceType: food.provider,
        sourceUrl: food.source_url || undefined,
        confidence: food.confidence,
        sourceSnapshot: {
            resolution_layer: "food_search",
            candidate_id: candidateId,
            provider: food.provider,
            provider_food_id: food.provider_food_id,
            selected_portion_id: portion.id,
            selected_portion_label: portion.label,
            selected_quantity: 1,
            nutrition_snapshot: portion.nutrients,
        },
    };
}

function recipeIngredientFromRecord(ingredient) {
    return {
        name: ingredient.name,
        quantity: ingredient.quantity ?? undefined,
        unit: ingredient.unit || "",
        preparation: ingredient.preparation || "",
        optional: Boolean(ingredient.optional),
        gramWeight: ingredient.gram_weight ?? undefined,
        nutrients: ingredient.nutrients || {},
        provider: ingredient.provider || undefined,
        providerFoodId: ingredient.provider_food_id || undefined,
        sourceType: ingredient.source_type || "user_supplied",
        sourceUrl: ingredient.source_url || undefined,
        confidence: ingredient.confidence ?? undefined,
        sourceSnapshot: ingredient.source_snapshot || {},
    };
}

function recipeIngredientFromRecent(recent) {
    return {
        name: recent.name,
        quantity: 1,
        unit: recent.portionLabel || "serving",
        preparation: "",
        optional: false,
        gramWeight: undefined,
        nutrients: recent.nutrients || {},
        provider: recent.provider || undefined,
        providerFoodId: recent.providerFoodId || undefined,
        sourceType: "past_meal",
        sourceUrl: undefined,
        confidence: recent.confidence ?? undefined,
        sourceSnapshot: {
            resolution_layer: "personal_history",
            meal_id: recent.mealId,
            item_id: recent.itemId,
        },
    };
}

function recipeFormMarkup(mode, recipe = null) {
    const editing = mode === "edit";
    const scopeOptions = editing
        ? '<input type="hidden" name="scope" value="personal" />'
        : `<label class="field"><span>Save to</span><select name="scope">${state.bootstrap?.capabilities?.recipeWrite !== false ? '<option value="personal">Personal recipes</option>' : ""}${state.bootstrap?.capabilities?.householdRecipeWrite ? '<option value="household">Household recipes</option>' : ""}</select></label>`;
    const sourceType = recipe?.source?.type || "user_entered";
    return `<form id="${editing ? "recipe-edit-form" : "recipe-create-form"}" class="auth-form"${editing ? ` data-id="${escapeHtml(recipe.id)}" data-version="${escapeHtml(recipe.version)}"` : ""}><div class="meal-composer-grid"><label class="field"><span>Recipe name</span><input name="name" value="${escapeHtml(recipe?.name || "")}" maxlength="200" required /></label><label class="field"><span>Servings</span><input name="servings" type="number" min="0.01" step="0.01" value="${escapeHtml(recipe?.servings ?? 2)}" required /></label></div>${scopeOptions}<label class="field"><span>Description</span><textarea name="description" rows="2" maxlength="2000" placeholder="What is this recipe for?">${escapeHtml(recipe?.description || "")}</textarea></label><div class="meal-composer-grid"><label class="field"><span>Prep time (minutes)</span><input name="preparation_minutes" type="number" min="0" step="1" value="${escapeHtml(recipe?.preparation_minutes ?? "")}" /></label><label class="field"><span>Cook time (minutes)</span><input name="cooking_minutes" type="number" min="0" step="1" value="${escapeHtml(recipe?.cooking_minutes ?? "")}" /></label></div><section class="recipe-editor-section"><div class="panel-title"><div><h3>Ingredients</h3><span>Search verified foods or add your own.</span></div><button class="button button-secondary button-small" type="button" data-action="add-recipe-ingredient">Add ingredient</button></div><div class="meal-composer-search"><div class="meal-composer-search-row"><input class="input" id="recipe-food-search" type="search" placeholder="Search oats, yogurt, chicken…" autocomplete="off" /><span class="tiny">Food search facts are stored with this revision.</span></div><div id="recipe-food-results" class="meal-food-results"></div></div><div id="recipe-ingredients" class="meal-selected-items"></div></section><label class="field"><span>Instructions</span><textarea name="instructions" rows="6" maxlength="20000" placeholder="One step per line" required>${escapeHtml(recipe?.instructions?.join("\n") || "")}</textarea><small class="tiny">Put each instruction on its own line.</small></label><div class="meal-composer-grid"><label class="field"><span>Source title</span><input name="source_title" maxlength="500" value="${escapeHtml(recipe?.source?.title || "")}" placeholder="Optional cookbook, site, or note" /></label><label class="field"><span>Source type</span><select name="source_type"><option value="user_entered" ${sourceType === "user_entered" ? "selected" : ""}>User entered</option><option value="chatgpt_generated" ${sourceType === "chatgpt_generated" ? "selected" : ""}>ChatGPT generated</option><option value="imported" ${sourceType === "imported" ? "selected" : ""}>Imported</option></select></label></div><label class="field"><span>Source URL</span><input name="source_url" type="url" maxlength="2000" value="${escapeHtml(recipe?.source?.url || "")}" placeholder="https://…" /></label><button class="button button-primary" type="submit">${editing ? "Save new revision" : "Create recipe"}</button></form>`;
}

function renderRecipeIngredients() {
    const root = document.getElementById("recipe-ingredients");
    if (!root) return;
    if (recipeComposer.ingredients.length === 0) {
        root.innerHTML = `<div class="empty-state"><div><strong>No ingredients yet.</strong><p>Search for a food or add a manual ingredient.</p></div></div>`;
        return;
    }
    root.innerHTML = recipeComposer.ingredients
        .map((ingredient, index) => {
            const nutrients = ingredient.nutrients || {};
            return `<article class="meal-composer-item recipe-ingredient-editor" data-recipe-ingredient-index="${index}"><div class="meal-composer-item-head"><div><strong>${escapeHtml(ingredient.name || "New ingredient")}</strong><small>${sourceBadge(ingredient.sourceType || "user_supplied")} ${ingredient.provider ? escapeHtml(ingredient.provider) : "Nutrition can be entered below"}</small></div><button class="button button-quiet button-small" type="button" data-action="remove-recipe-ingredient" data-index="${index}">Remove</button></div><div class="meal-composer-grid"><label class="field"><span>Name</span><input data-recipe-field="name" value="${escapeHtml(ingredient.name || "")}" maxlength="300" required /></label><label class="field"><span>Quantity</span><input data-recipe-field="quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(ingredient.quantity ?? "")}" /></label><label class="field"><span>Unit</span><input data-recipe-field="unit" maxlength="80" value="${escapeHtml(ingredient.unit || "")}" placeholder="cup, gram, serving…" /></label><label class="field"><span>Preparation</span><input data-recipe-field="preparation" maxlength="200" value="${escapeHtml(ingredient.preparation || "")}" placeholder="chopped, warmed…" /></label></div><label class="checkbox-row"><input data-recipe-field="optional" type="checkbox" ${ingredient.optional ? "checked" : ""} /> Optional ingredient</label><div class="meal-composer-nutrients">${recipeNutrientFields.map((key) => `<label class="field"><span>${escapeHtml(key.replace("_g", " (g)").replace("sodium_mg", "sodium (mg)"))}</span><input data-recipe-field="${key}" type="number" min="0" step="0.1" value="${escapeHtml(nutrients[key] ?? "")}" /></label>`).join("")}</div></article>`;
        })
        .join("");
}

function renderRecipeSearchResults(data) {
    const root = document.getElementById("recipe-food-results");
    if (!root) return;
    recipeComposer.options.clear();
    const sections = [];
    if (data.candidates?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Verified foods</h4>${data.candidates
                .map((candidate, index) => {
                    const key = `candidate:${index}`;
                    recipeComposer.options.set(key, {
                        kind: "candidate",
                        candidateId: candidate.candidate_id,
                    });
                    return `<button class="meal-search-result" type="button" data-action="select-recipe-food-option" data-key="${key}"><span><strong>${escapeHtml([candidate.brand, candidate.name].filter(Boolean).join(" — ") || candidate.name)}</strong><small>${sourceBadge(candidate.provider)} ${escapeHtml(candidate.default_portion?.label || "Details available after selection")}</small></span><span>${candidate.default_portion?.calories == null ? "" : `${number(candidate.default_portion.calories)} kcal`}</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    if (data.savedFoods?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Saved foods</h4>${data.savedFoods
                .map((saved, index) => {
                    const key = `saved:${index}`;
                    recipeComposer.options.set(key, {
                        kind: "food",
                        food: saved.food,
                        portionId: saved.defaultPortionId,
                    });
                    return `<button class="meal-search-result" type="button" data-action="select-recipe-food-option" data-key="${key}"><span><strong>${escapeHtml(saved.label)}</strong><small>${sourceBadge(saved.food.provider)} ${escapeHtml(saved.food.name || "Saved food")}</small></span><span>${number(foodPortion(saved.food, saved.defaultPortionId)?.nutrients?.calories)} kcal</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    if (data.recentMealItems?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Recent foods</h4>${data.recentMealItems
                .map((recent, index) => {
                    const key = `recent:${index}`;
                    recipeComposer.options.set(key, { kind: "recent", recent });
                    return `<button class="meal-search-result" type="button" data-action="select-recipe-food-option" data-key="${key}"><span><strong>${escapeHtml(recent.name)}</strong><small>${sourceBadge("past_meal")} ${escapeHtml(recent.portionLabel || "Portion not recorded")}</small></span><span>${number(recent.nutrients?.calories)} kcal</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    root.innerHTML =
        sections.join("") ||
        `<p class="tiny">No matches yet. Try a food name or add a manual ingredient.</p>`;
}

async function searchRecipeFoods(query) {
    const root = document.getElementById("recipe-food-results");
    if (!root) return;
    root.innerHTML = `<p class="tiny">Searching verified foods and personal history…</p>`;
    try {
        const data = await api(
            `/api/app/food-search?query=${encodeURIComponent(query)}&limit=8`,
            { keepPrevious: true },
        );
        renderRecipeSearchResults(data);
    } catch (error) {
        if (error?.name !== "AbortError")
            root.innerHTML = `<p class="tiny">${escapeHtml(error.message || "Food search failed")}</p>`;
    }
}

async function selectRecipeFoodOption(key) {
    syncRecipeComposerFromDom();
    const option = recipeComposer.options.get(key);
    if (!option) return;
    if (option.kind === "candidate") {
        const data = await api(
            `/api/app/food-details?candidate_id=${encodeURIComponent(option.candidateId)}`,
            { keepPrevious: true },
        );
        if (!data.food) throw new Error("Food details are no longer available");
        recipeComposer.ingredients.push(
            recipeIngredientFromFood(data.food, data.food.portions?.[0]?.id),
        );
    } else if (option.kind === "food") {
        recipeComposer.ingredients.push(
            recipeIngredientFromFood(option.food, option.portionId),
        );
    } else {
        recipeComposer.ingredients.push(
            recipeIngredientFromRecent(option.recent),
        );
    }
    renderRecipeIngredients();
}

function syncRecipeComposerFromDom() {
    const root = document.getElementById("recipe-ingredients");
    if (!root) return;
    root.querySelectorAll("[data-recipe-ingredient-index]").forEach((row) => {
        const index = Number(row.dataset.recipeIngredientIndex);
        const ingredient = recipeComposer.ingredients[index];
        if (!ingredient) return;
        const field = (name) =>
            row.querySelector(`[data-recipe-field="${name}"]`);
        const numeric = (name) => {
            const value = field(name)?.value;
            if (value === "" || value == null) return undefined;
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        };
        ingredient.name = field("name")?.value || "";
        ingredient.quantity = numeric("quantity");
        ingredient.unit = field("unit")?.value || "";
        ingredient.preparation = field("preparation")?.value || "";
        ingredient.optional = Boolean(field("optional")?.checked);
        ingredient.gramWeight = numeric("gram_weight");
        ingredient.nutrients = Object.fromEntries(
            recipeNutrientFields
                .map((key) => [key, numeric(key)])
                .filter(([, value]) => value !== undefined),
        );
    });
}

function recipePayloadFromForm(values) {
    syncRecipeComposerFromDom();
    const instructions = String(values.instructions || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return {
        name: values.name,
        servings: Number(values.servings),
        description: values.description || undefined,
        instructions,
        preparation_minutes:
            values.preparation_minutes === ""
                ? undefined
                : Number(values.preparation_minutes),
        cooking_minutes:
            values.cooking_minutes === ""
                ? undefined
                : Number(values.cooking_minutes),
        source_type: values.source_type,
        source_title: values.source_title || undefined,
        source_url: values.source_url || undefined,
        ingredients: recipeComposer.ingredients.map((ingredient) => ({
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit || undefined,
            preparation: ingredient.preparation || undefined,
            optional: ingredient.optional || undefined,
            gram_weight: ingredient.gramWeight,
            nutrients: ingredient.nutrients,
            provider: ingredient.provider,
            provider_food_id: ingredient.providerFoodId,
            source_type: ingredient.sourceType || "user_supplied",
            source_url: ingredient.sourceUrl,
            confidence: ingredient.confidence,
            source_snapshot: ingredient.sourceSnapshot,
        })),
    };
}

function openRecipeCreate() {
    recipeComposer.ingredients = [];
    recipeComposer.options.clear();
    openDialog("Create recipe", recipeFormMarkup("create"));
    renderRecipeIngredients();
    searchRecipeFoods("");
}

async function openRecipe(id) {
    const data = await api(`/api/app/recipes/${encodeURIComponent(id)}`);
    const recipe = data.recipe;
    const ingredients = recipe.ingredients
        .map(
            (ingredient) =>
                `<li><strong>${escapeHtml(ingredient.name)}</strong><span>${ingredient.quantity == null ? "" : `${number(ingredient.quantity, 3)} ${escapeHtml(ingredient.unit || "")}`} · ${number(ingredient.nutrients?.calories)} kcal</span>${sourceBadge(ingredient.source_type)}</li>`,
        )
        .join("");
    openDialog(
        recipe.name,
        `<div class="recipe-detail"><p>${number(recipe.servings, 3)} servings · revision ${number(recipe.revision_number)} · ${escapeHtml(recipe.nutrition_status)}</p><div class="meal-macros"><span class="macro-chip">${number(recipe.nutrition_per_serving?.calories)} kcal/serving</span><span class="macro-chip">P ${number(recipe.nutrition_per_serving?.protein_g, 1)}g</span><span class="macro-chip">C ${number(recipe.nutrition_per_serving?.carbs_g, 1)}g</span><span class="macro-chip">F ${number(recipe.nutrition_per_serving?.fat_g, 1)}g</span></div><h3 class="spacer-top">Ingredients</h3><ul class="food-items">${ingredients}</ul><h3 class="spacer-top">Instructions</h3><ol class="recipe-instructions">${recipe.instructions.map((instruction) => `<li>${escapeHtml(instruction)}</li>`).join("") || "<li>No instructions recorded.</li>"}</ol><p class="tiny spacer-top">Every ingredient includes the source snapshot used to calculate this revision. Editing creates a new revision; historical logs stay pinned.</p><div class="auth-actions spacer-top"><button class="button button-primary" type="button" data-action="log-recipe" data-id="${escapeHtml(recipe.id)}" data-revision="${escapeHtml(recipe.revision_id)}">Log recipe</button><button class="button button-secondary" type="button" data-action="plan-recipe" data-id="${escapeHtml(recipe.id)}" data-revision="${escapeHtml(recipe.revision_id)}">Add to plan</button><button class="button button-secondary" type="button" data-action="archive-recipe" data-id="${escapeHtml(recipe.id)}" data-version="${escapeHtml(recipe.version)}">Archive</button></div><details class="spacer-top"><summary>Edit recipe revision</summary>${recipeFormMarkup("edit", recipe)}</details></div>`,
    );
    recipeComposer.ingredients = recipe.ingredients.map(
        recipeIngredientFromRecord,
    );
    recipeComposer.options.clear();
    renderRecipeIngredients();
    searchRecipeFoods("");
}

function openRecipeLog(id, revisionId) {
    openDialog(
        "Log saved recipe",
        `<form id="recipe-log-form" class="auth-form" data-id="${escapeHtml(id)}" data-revision="${escapeHtml(revisionId || "")}"><p>Use the saved ingredients and nutrition exactly as stored. Choose how much you ate.</p><label class="field"><span>Servings consumed</span><input name="servings_consumed" type="number" min="0.01" step="0.01" value="1" required /></label><label class="field"><span>Meal type</span><select name="meal_type"><option value="breakfast">Breakfast</option><option value="lunch" selected>Lunch</option><option value="dinner">Dinner</option><option value="snack">Snack</option></select></label><label class="field"><span>Notes</span><input name="notes" maxlength="4000" placeholder="Optional" /></label><button class="button button-primary" type="submit">Log meal</button></form>`,
    );
}

function openRecipePlan(id) {
    openDialog(
        "Add recipe to meal plan",
        `<form id="recipe-plan-form" class="auth-form" data-id="${escapeHtml(id)}"><label class="field"><span>Date</span><input name="planned_date" type="date" value="${escapeHtml(state.date)}" required /></label><label class="field"><span>Meal slot</span><select name="meal_slot"><option value="breakfast">Breakfast</option><option value="lunch" selected>Lunch</option><option value="dinner">Dinner</option><option value="snack">Snack</option></select></label><label class="field"><span>Servings planned</span><input name="servings" type="number" min="0.01" step="0.01" value="1" required /></label><button class="button button-primary" type="submit">Add to plan</button></form>`,
    );
}

function weekDays(start) {
    return Array.from({ length: 7 }, (_, index) => shiftDate(start, index));
}

async function renderPlan() {
    setLoading("Loading the meal plan…");
    const data = await planningData();
    if (!data.available) {
        content.innerHTML = premiumUnavailable(
            "Meal planning is not available for this account",
            "The website meal calendar appears when the account has planning capability.",
        );
        return;
    }
    const start = shiftDate(
        state.date,
        -((new Date(`${state.date}T12:00:00Z`).getUTCDay() + 6) % 7),
    );
    const byDate = Object.groupBy(
        data.plannedMeals,
        (meal) => meal.planned_date,
    );
    content.innerHTML = `<div class="page-heading"><div><h2>Week of ${escapeHtml(formatDate(start))}</h2><p>Planned meals stay separate from foods you actually logged.</p></div><div class="auth-actions"><button class="button button-secondary button-small" data-action="date-week-prev">Previous week</button><button class="button button-secondary button-small" data-action="date-today">This week</button><button class="button button-secondary button-small" data-action="date-week-next">Next week</button></div></div><div class="meal-groups">${weekDays(
        start,
    )
        .map(
            (date) =>
                `<section class="meal-group"><header class="meal-group-header"><div><strong>${escapeHtml(formatDate(date, { weekday: true }))}</strong></div><span>${(byDate[date] || []).length} planned</span></header>${(byDate[date] || []).length ? (byDate[date] || []).map((meal) => `<article class="meal-card"><div class="meal-card-head"><div><h4>${escapeHtml(meal.recipe_name)}</h4><div class="meal-meta"><span>${escapeHtml(meal.meal_slot || "Meal")}</span><span>${escapeHtml(meal.ownership)}</span>${meal.created_by ? `<span>Added by ${escapeHtml(meal.created_by)}</span>` : ""}</div></div><strong>${number(meal.servings, 1)} servings</strong></div><div class="meal-macros"><span class="macro-chip">${number((meal.nutrition_per_serving?.calories || 0) * meal.servings)} kcal</span><span class="macro-chip">P ${number((meal.nutrition_per_serving?.protein_g || 0) * meal.servings, 1)}g</span></div></article>`).join("") : `<div class="meal-card"><p>No meals planned.</p></div>`}</section>`,
        )
        .join("")}</div>`;
}

async function renderGroceries() {
    setLoading("Loading grocery lists…");
    const data = await planningData();
    if (!data.available) {
        content.innerHTML = premiumUnavailable(
            "Grocery lists are not available for this account",
            "The shopping workspace appears when the account has planning capability.",
        );
        return;
    }
    const lists = (data.groceries || [])
        .map((list) => {
            const editable = Boolean(data.permissions?.[list.scope]);
            const purchasedCount = list.items.filter(
                (item) => item.purchased_at,
            ).length;
            const listAddButton = editable
                ? `<button class="button button-primary button-small" type="button" data-action="add-grocery" data-scope="${list.scope}">Add item</button>`
                : "";
            return `<section class="panel panel-span-6 grocery-list" data-grocery-scope="${list.scope}"><div class="panel-title"><div><h3>${list.scope === "household" ? "Household list" : "Personal list"}</h3><span>${list.scope === "household" && data.permissions?.householdRole ? `${escapeHtml(data.permissions.householdRole)} · ` : ""}${list.items.length} items</span></div><div class="auth-actions">${listAddButton}${editable && purchasedCount ? `<button class="button button-quiet button-small" type="button" data-action="clear-purchased" data-scope="${list.scope}">Clear purchased</button>` : ""}</div></div>${list.items.length ? `<div class="grocery-items">${list.items.map((item) => `<article class="grocery-item-row ${item.purchased_at ? "is-purchased" : ""}" data-grocery-item-id="${escapeHtml(item.grocery_item_id)}" data-quantity="${escapeHtml(item.quantity ?? "")}" data-unit="${escapeHtml(item.unit || "")}" data-note="${escapeHtml(item.note || "")}"><div class="grocery-item-main"><strong>${escapeHtml(item.name)}</strong><small>${item.quantity == null ? "" : `${number(item.quantity, 2)} ${escapeHtml(item.unit || "")}`}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</small><small class="grocery-provenance">${escapeHtml(grocerySourceLabel(item))}</small></div><div class="grocery-item-actions"><label class="grocery-check"><input type="checkbox" data-action="toggle-grocery-purchased" data-id="${escapeHtml(item.grocery_item_id)}" data-version="${escapeHtml(item.version)}" data-scope="${list.scope}" ${item.purchased_at ? "checked" : ""} ${editable ? "" : "disabled"} aria-label="${escapeHtml(item.name)} purchased" /><span>${item.purchased_at ? "Purchased" : "Mark purchased"}</span></label>${editable ? `<button class="button button-secondary button-small" type="button" data-action="edit-grocery" data-id="${escapeHtml(item.grocery_item_id)}" data-version="${escapeHtml(item.version)}" data-scope="${list.scope}">Edit</button><button class="button button-quiet button-small" type="button" data-action="remove-grocery" data-id="${escapeHtml(item.grocery_item_id)}" data-version="${escapeHtml(item.version)}" data-scope="${list.scope}">Remove</button>` : ""}</div></article>`).join("")}</div>` : `<div class="empty-state"><div><h3>The list is empty</h3><p>Add an item manually or ask ChatGPT to record an explicit shopping need.</p></div></div>`}</section>`;
        })
        .join("");
    content.innerHTML = `<div class="page-heading"><div><h2>Groceries</h2><p>Explicit shopping lists only. Munch does not infer pantry inventory.</p></div><div class="auth-actions"><button class="button button-secondary button-small" data-action="shopping-mode">Shopping mode</button></div></div><div class="dashboard-grid">${lists}</div>`;
}

function grocerySourceLabel(item) {
    const sources = [];
    if (item.source_recipe_id) sources.push("From recipe");
    if (item.source_planned_meal_id) sources.push("From meal plan");
    if (!sources.length) sources.push("Manual addition");
    if (item.added_by) sources.push(`Added by ${item.added_by}`);
    return sources.join(" · ");
}

function openGroceryAdd(scope) {
    openDialog(
        scope === "household"
            ? "Add household grocery"
            : "Add personal grocery",
        `<form id="grocery-add-form" class="auth-form" data-scope="${escapeHtml(scope)}"><label class="field"><span>Item</span><input name="name" maxlength="300" required placeholder="Onions, oat milk…" /></label><div class="meal-composer-grid"><label class="field"><span>Quantity</span><input name="quantity" type="number" min="0.01" step="0.01" placeholder="Optional" /></label><label class="field"><span>Unit</span><input name="unit" maxlength="80" placeholder="whole, lb, carton…" /></label></div><label class="field"><span>Note</span><textarea name="note" rows="2" maxlength="500" placeholder="Optional preparation or brand note"></textarea></label><button class="button button-primary" type="submit">Add to list</button></form>`,
    );
}

function openGroceryEdit(item, scope) {
    openDialog(
        "Edit grocery item",
        `<form id="grocery-edit-form" class="auth-form" data-id="${escapeHtml(item.grocery_item_id)}" data-version="${escapeHtml(item.version)}" data-scope="${escapeHtml(scope)}"><label class="field"><span>Item</span><input name="name" maxlength="300" required value="${escapeHtml(item.name)}" /></label><div class="meal-composer-grid"><label class="field"><span>Quantity</span><input name="quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(item.quantity ?? "")}" placeholder="Optional" /></label><label class="field"><span>Unit</span><input name="unit" maxlength="80" value="${escapeHtml(item.unit || "")}" placeholder="whole, lb, carton…" /></label></div><label class="field"><span>Note</span><textarea name="note" rows="2" maxlength="500">${escapeHtml(item.note || "")}</textarea></label><button class="button button-primary" type="submit">Save item</button></form>`,
    );
}

function accountContext() {
    return {
        content,
        api,
        state,
        toast,
        setLoading,
        renderRoute,
        navigate,
    };
}

async function renderRoute() {
    state.route = routes[location.pathname] || "today";
    setActiveRoute(state.route);
    try {
        if (!state.bootstrap) {
            state.bootstrap = await api("/api/app/bootstrap");
            state.date = dateInTimezone(
                state.bootstrap.profile?.timezone || "UTC",
            );
        }
        if (isAccountRoute(state.route) && !accountTitles[state.route]) {
            throw new Error("Unknown account route");
        }
        const renderers = {
            today: renderToday,
            log: renderLog,
            insights: renderInsights,
            foods: renderFoods,
            recipes: renderRecipes,
            plan: renderPlan,
            groceries: renderGroceries,
            more: () => renderAccountRoute("more", accountContext()),
            household: () => renderAccountRoute("household", accountContext()),
            settings: () => renderAccountRoute("settings", accountContext()),
            "settings-profile": () =>
                renderAccountRoute("settings-profile", accountContext()),
            "settings-goals": () =>
                renderAccountRoute("settings-goals", accountContext()),
            "settings-billing": () =>
                renderAccountRoute("settings-billing", accountContext()),
            "settings-connections": () =>
                renderAccountRoute("settings-connections", accountContext()),
            "settings-data": () =>
                renderAccountRoute("settings-data", accountContext()),
            "settings-account": () =>
                renderAccountRoute("settings-account", accountContext()),
        };
        await (renderers[state.route] || renderToday)();
        if (state.route === "today" || state.route === "log") {
            const actions = content.querySelector(
                ".page-heading .auth-actions",
            );
            if (actions && !actions.querySelector('[data-action="add-meal"]')) {
                actions.insertAdjacentHTML(
                    "afterbegin",
                    '<button class="button button-primary button-small" data-action="add-meal">Add meal</button>',
                );
            }
        }
        content.focus({ preventScroll: true });
    } catch (error) {
        errorState(error);
    }
}

function navigate(href) {
    history.pushState({}, "", href);
    renderRoute();
}

function findMeal(id) {
    const card = document.querySelector(`[data-meal-id="${CSS.escape(id)}"]`);
    return card ? card.querySelector("h4")?.textContent || "Meal" : "Meal";
}

function openDialog(title, body, actions = "") {
    dialog.innerHTML = `<div class="auth-card" style="min-width:min(92vw,520px);max-height:85vh;overflow:auto"><div class="panel-title"><h2 style="font-size:1.6rem">${escapeHtml(title)}</h2><button class="button button-quiet button-small" type="button" data-action="close-dialog" aria-label="Close">Close</button></div>${body}${actions}</div>`;
    dialog.showModal();
}

const draftNutrientFields = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "alcohol_g",
    "sodium_mg",
    "saturated_fat_g",
    "cholesterol_mg",
    "potassium_mg",
];

function draftDateTimeValue(value) {
    return value ? new Date(value).toISOString().slice(0, 16) : "";
}

function draftNumber(value) {
    if (value === "" || value == null) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function draftNutrientLabel(key) {
    return key
        .replace("_g", " (g)")
        .replace("_mg", " (mg)")
        .replace("saturated_fat", "sat. fat");
}

function draftItemPayloadFromDom(index) {
    const root = document.querySelector(`[data-draft-item-index="${index}"]`);
    const original = mealDraftReview.draft.items[index];
    if (!root || !original)
        throw new Error("Draft item is no longer available");
    const field = (name) => root.querySelector(`[data-draft-field="${name}"]`);
    const nutrientValues = Object.fromEntries(
        draftNutrientFields
            .map((key) => [key, draftNumber(field(key)?.value)])
            .filter(([, value]) => value !== undefined),
    );
    return {
        name: field("name")?.value || original.name,
        quantity: draftNumber(field("quantity")?.value),
        portion_label: field("portion_label")?.value || undefined,
        gram_weight: draftNumber(field("gram_weight")?.value),
        nutrients: nutrientValues,
        source_type: original.source_type,
        provider: original.provider || undefined,
        provider_food_id: original.provider_food_id || undefined,
        provider_revision: original.provider_revision || undefined,
        source_url: original.source_url || undefined,
        source_updated_at: original.source_updated_at || undefined,
        confidence: original.confidence ?? undefined,
        assumptions: original.assumptions || [],
        source_snapshot: original.source_snapshot || {},
    };
}

function draftManualPayloadFromDom(index) {
    const root = document.querySelector(
        `[data-draft-pending-index="${index}"]`,
    );
    if (!root) throw new Error("Manual draft item is no longer available");
    const field = (name) => root.querySelector(`[data-draft-field="${name}"]`);
    const nutrientValues = Object.fromEntries(
        draftNutrientFields
            .map((key) => [key, draftNumber(field(key)?.value)])
            .filter(([, value]) => value !== undefined),
    );
    return {
        name: field("name")?.value || "",
        quantity: draftNumber(field("quantity")?.value),
        portion_label: field("portion_label")?.value || undefined,
        gram_weight: draftNumber(field("gram_weight")?.value),
        nutrients: nutrientValues,
        source_type: "user_supplied",
        assumptions: [],
        source_snapshot: { resolution_layer: "web_manual" },
    };
}

function draftItemEditor(item, index) {
    const nutrientFields = draftNutrientFields
        .map(
            (key) =>
                `<label class="field"><span>${escapeHtml(draftNutrientLabel(key))}</span><input data-draft-field="${key}" type="number" min="0" step="0.1" value="${escapeHtml(item.nutrients?.[key] ?? "")}" /></label>`,
        )
        .join("");
    return `<article class="meal-draft-item meal-composer-item" data-draft-item-index="${index}"><div class="meal-composer-item-head"><div><strong>${escapeHtml(item.name)}</strong><small>${sourceBadge(item.source_type)} ${confidenceBadge(item.confidence)}</small></div><div class="auth-actions"><button class="button button-primary button-small" type="button" data-action="save-draft-item" data-index="${index}">Save item</button><button class="button button-quiet button-small" type="button" data-action="remove-draft-item" data-index="${index}">Remove</button></div></div><div class="meal-composer-grid"><label class="field"><span>Name</span><input data-draft-field="name" value="${escapeHtml(item.name)}" maxlength="500" required /></label><label class="field"><span>Portion</span><input data-draft-field="portion_label" value="${escapeHtml(item.portion_label || "")}" placeholder="1 bowl, 1 slice…" /></label><label class="field"><span>Quantity</span><input data-draft-field="quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(item.quantity ?? 1)}" /></label><label class="field"><span>Gram weight</span><input data-draft-field="gram_weight" type="number" min="0.01" step="0.1" value="${escapeHtml(item.gram_weight ?? "")}" /></label></div><div class="meal-composer-nutrients">${nutrientFields}</div><details class="food-audit"><summary>Provenance and assumptions</summary><div class="food-audit-body"><div>${sourceBadge(item.source_type)} ${escapeHtml(item.provider || "Source snapshot preserved")}</div>${item.source_url ? `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noreferrer">View source</a>` : ""}${item.assumptions?.length ? `<div>Assumptions: ${escapeHtml(item.assumptions.join("; "))}</div>` : ""}</div></details></article>`;
}

function draftManualEditor(item, index) {
    const nutrientFields = draftNutrientFields
        .map(
            (key) =>
                `<label class="field"><span>${escapeHtml(draftNutrientLabel(key))}</span><input data-draft-field="${key}" type="number" min="0" step="0.1" value="${escapeHtml(item.nutrients?.[key] ?? "")}" /></label>`,
        )
        .join("");
    return `<article class="meal-draft-item meal-composer-item" data-draft-pending-index="${index}"><div class="meal-composer-item-head"><div><strong>New manual food</strong><small>${sourceBadge("user_supplied")} Enter the nutrition used</small></div><button class="button button-primary button-small" type="button" data-action="save-draft-manual" data-index="${index}">Add item</button></div><div class="meal-composer-grid"><label class="field"><span>Name</span><input data-draft-field="name" value="${escapeHtml(item.name || "")}" maxlength="500" required /></label><label class="field"><span>Portion</span><input data-draft-field="portion_label" value="${escapeHtml(item.portion_label || "")}" placeholder="1 bowl, 1 slice…" /></label><label class="field"><span>Quantity</span><input data-draft-field="quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(item.quantity ?? 1)}" /></label><label class="field"><span>Gram weight</span><input data-draft-field="gram_weight" type="number" min="0.01" step="0.1" value="${escapeHtml(item.gram_weight ?? "")}" /></label></div><div class="meal-composer-nutrients">${nutrientFields}</div></article>`;
}

function renderMealDraftReview(draft) {
    mealDraftReview.draft = draft;
    const root = document.getElementById("meal-draft-review");
    if (!root) return;
    const openQuestions = draft.questions.filter(
        (question) => question.status === "open",
    );
    const totals = draft.totals || {};
    const editable = [
        "open",
        "awaiting_answers",
        "awaiting_confirmation",
    ].includes(draft.status);
    root.innerHTML = `<div class="meal-draft-review"><div class="panel-title"><div><span class="section-kicker">${escapeHtml(draft.status.replaceAll("_", " "))}</span><h3>${escapeHtml(draft.description || "Meal draft")}</h3></div><span>Version ${draft.version}</span></div><p class="tiny">${draft.expires_at ? `Expires ${escapeHtml(formatTime(draft.expires_at))}` : ""} ${draft.source_mode ? `· Source: ${escapeHtml(draft.source_mode)}` : ""}</p><div class="summary-grid">${metricCard("Calories", totals.calories, " kcal", null, true)}${metricCard("Protein", totals.protein_g, "g", null)}${metricCard("Carbs", totals.carbs_g, "g", null)}${metricCard("Fat", totals.fat_g, "g", null)}</div>${editable ? `<section class="meal-draft-section"><div class="panel-title"><h4>Meal details</h4><button class="button button-primary button-small" type="button" data-action="save-meal-draft">Save details</button></div><div class="meal-composer-grid"><label class="field"><span>Description</span><input data-draft-field="description" value="${escapeHtml(draft.description || "")}" maxlength="2000" /></label><label class="field"><span>Meal type</span><select data-draft-field="meal_type"><option value="breakfast" ${draft.meal_type === "breakfast" ? "selected" : ""}>Breakfast</option><option value="lunch" ${draft.meal_type === "lunch" ? "selected" : ""}>Lunch</option><option value="dinner" ${draft.meal_type === "dinner" ? "selected" : ""}>Dinner</option><option value="snack" ${draft.meal_type === "snack" ? "selected" : ""}>Snack</option></select></label><label class="field"><span>Logged at</span><input data-draft-field="logged_at" type="datetime-local" value="${escapeHtml(draftDateTimeValue(draft.logged_at))}" /></label></div><label class="field"><span>Notes</span><textarea data-draft-field="notes" rows="2" maxlength="4000">${escapeHtml(draft.notes || "")}</textarea></label></section>` : ""}<section class="meal-draft-section"><div class="panel-title"><h4>Foods and provenance</h4><span>${draft.items.length} item${draft.items.length === 1 ? "" : "s"}</span></div>${draft.items.map(draftItemEditor).join("") || `<p class="tiny">No foods are in this draft yet.</p>`}${mealDraftReview.pendingManual.map(draftManualEditor).join("")}</section>${editable ? `<section class="meal-draft-section meal-composer-search"><div class="panel-title"><h4>Add another food</h4><button class="button button-secondary button-small" type="button" data-action="add-draft-manual">Add manual food</button></div><div class="meal-composer-search-row"><input class="input" id="meal-draft-food-search" type="search" placeholder="Search oats, yogurt, chicken…" autocomplete="off" /><input class="input" id="meal-draft-food-barcode" inputmode="numeric" placeholder="Barcode" aria-label="Food barcode" /><button class="button button-secondary" type="button" data-action="lookup-draft-food-barcode">Look up</button></div><div id="meal-draft-food-results" class="meal-food-results"></div></section>` : ""}${openQuestions.length ? `<section class="meal-draft-section"><div class="panel-title"><h4>Questions</h4><span>${openQuestions.length} open</span></div>${openQuestions.map((question) => `<div class="meal-draft-question" data-draft-question-id="${escapeHtml(question.id)}"><strong>${escapeHtml(question.prompt)}</strong><div class="meal-composer-search-row"><input class="input" data-draft-question-answer placeholder="Answer or correction" maxlength="2000" /><button class="button button-secondary button-small" type="button" data-action="answer-meal-draft-question" data-question-id="${escapeHtml(question.id)}">Save answer</button></div></div>`).join("")}<label class="checkbox-row"><input type="checkbox" data-draft-accept-assumptions /> Accept the remaining assumptions as shown</label></section>` : ""}<div class="auth-actions meal-draft-actions">${editable ? `<button class="button button-primary" type="button" data-action="confirm-meal-draft">${openQuestions.length ? "Confirm and accept assumptions" : "Confirm and log meal"}</button><button class="button button-quiet" type="button" data-action="cancel-meal-draft">Abandon draft</button>` : `<p class="tiny">This draft is ${escapeHtml(draft.status)}.</p>`}</div></div>`;
}

function renderDraftFoodResults(data) {
    const root = document.getElementById("meal-draft-food-results");
    if (!root) return;
    mealDraftReview.options.clear();
    const sections = [];
    if (data.candidates?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Verified foods</h4>${data.candidates
                .map((candidate, index) => {
                    const key = `candidate:${index}`;
                    mealDraftReview.options.set(key, {
                        kind: "candidate",
                        candidateId: candidate.candidate_id,
                    });
                    return `<button class="meal-search-result" type="button" data-action="select-draft-food-option" data-key="${key}"><span><strong>${escapeHtml([candidate.brand, candidate.name].filter(Boolean).join(" — ") || candidate.name)}</strong><small>${sourceBadge(candidate.provider)} ${escapeHtml(candidate.default_portion?.label || "Details available after selection")}</small></span><span>${candidate.default_portion?.calories == null ? "" : `${number(candidate.default_portion.calories)} kcal`}</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    if (data.savedFoods?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Saved foods</h4>${data.savedFoods
                .map((saved, index) => {
                    const key = `saved:${index}`;
                    mealDraftReview.options.set(key, {
                        kind: "food",
                        candidateId: saved.food?.candidate_id,
                        portionId: saved.defaultPortionId,
                    });
                    return `<button class="meal-search-result" type="button" data-action="select-draft-food-option" data-key="${key}"><span><strong>${escapeHtml(saved.label)}</strong><small>${sourceBadge(saved.food?.provider)} ${escapeHtml(saved.food?.name || "Saved food")}</small></span><span>${number(foodPortion(saved.food, saved.defaultPortionId)?.nutrients?.calories)} kcal</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    if (data.recentMealItems?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Recent foods</h4>${data.recentMealItems
                .map((recent, index) => {
                    const key = `recent:${index}`;
                    mealDraftReview.options.set(key, {
                        kind: "recent",
                        recent,
                    });
                    return `<button class="meal-search-result" type="button" data-action="select-draft-food-option" data-key="${key}"><span><strong>${escapeHtml(recent.name)}</strong><small>${sourceBadge("past_meal")} ${escapeHtml(recent.portionLabel || "Portion not recorded")}</small></span><span>${number(recent.nutrients?.calories)} kcal</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    root.innerHTML =
        sections.join("") ||
        `<p class="tiny">No matches yet. Try a food name or add a manual food.</p>`;
}

async function searchDraftFoods(query) {
    const root = document.getElementById("meal-draft-food-results");
    if (!root) return;
    root.innerHTML = `<p class="tiny">Searching verified foods and personal history…</p>`;
    try {
        const data = await api(
            `/api/app/food-search?query=${encodeURIComponent(query)}&limit=8`,
            { keepPrevious: true },
        );
        renderDraftFoodResults(data);
    } catch (error) {
        if (error?.name !== "AbortError") {
            root.innerHTML = `<p class="tiny">${escapeHtml(error.message || "Food search failed")}</p>`;
        }
    }
}

async function selectDraftFoodOption(key) {
    const option = mealDraftReview.options.get(key);
    const draft = mealDraftReview.draft;
    if (!option || !draft) return;
    let item;
    if (option.kind === "candidate" || option.kind === "food") {
        item = {
            candidate_id: option.candidateId,
            portion_id: option.portionId,
            quantity: 1,
        };
    } else {
        item = {
            name: option.recent.name,
            quantity: 1,
            portion_label: option.recent.portionLabel || undefined,
            nutrients: option.recent.nutrients,
            source_type: "past_meal",
            provider: option.recent.provider,
            provider_food_id: option.recent.providerFoodId,
            source_snapshot: {
                resolution_layer: "personal_history",
                meal_id: option.recent.mealId,
                item_id: option.recent.itemId,
            },
        };
    }
    const result = await api(
        `/api/app/meal-drafts/${encodeURIComponent(draft.id)}/items`,
        {
            method: "POST",
            body: JSON.stringify({ expected_version: draft.version, item }),
            keepPrevious: true,
        },
    );
    mealDraftReview.pendingManual = [];
    renderMealDraftReview(result.draft);
    toast("Food added to draft.");
    searchDraftFoods("");
}

async function lookupDraftFoodBarcode() {
    const input = document.getElementById("meal-draft-food-barcode");
    const root = document.getElementById("meal-draft-food-results");
    if (!input || !root || !input.value.trim()) return;
    root.innerHTML = `<p class="tiny">Looking up the package barcode…</p>`;
    const data = await api(
        `/api/app/food-barcode?barcode=${encodeURIComponent(input.value.trim())}`,
        { keepPrevious: true },
    );
    renderDraftFoodResults({ ...data, savedFoods: [], recentMealItems: [] });
}

async function openMealDraft(id) {
    mealDraftReview.draft = null;
    mealDraftReview.options.clear();
    mealDraftReview.pendingManual = [];
    openDialog(
        "Review meal draft",
        `<div id="meal-draft-review"><p class="tiny">Loading draft…</p></div>`,
    );
    const data = await api(`/api/app/meal-drafts/${encodeURIComponent(id)}`, {
        keepPrevious: true,
    });
    renderMealDraftReview(data.draft);
    searchDraftFoods("");
}

function foodTitle(food) {
    return [food.brand, food.name].filter(Boolean).join(" — ") || "Food";
}

function foodPortion(food, portionId) {
    return (
        food.portions?.find((portion) => portion.id === portionId) ||
        food.portions?.[0] ||
        null
    );
}

function foodMacroLine(food, portionId) {
    const portion = foodPortion(food, portionId);
    if (!portion) return "No declared portion";
    const nutrients = portion.nutrients || {};
    return `${escapeHtml(portion.label)} · ${number(nutrients.calories)} kcal · P ${number(nutrients.protein_g, 1)}g · C ${number(nutrients.carbs_g, 1)}g · F ${number(nutrients.fat_g, 1)}g`;
}

function syncMealComposerFromDom() {
    const root = document.getElementById("meal-selected-items");
    if (!root) return;
    root.querySelectorAll("[data-composer-index]").forEach((row) => {
        const index = Number(row.dataset.composerIndex);
        const item = mealComposer.items[index];
        if (!item) return;
        const field = (name) =>
            row.querySelector(`[data-composer-field="${name}"]`);
        const quantity = Number(field("quantity")?.value || 1);
        item.quantity =
            Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
        if (item.kind === "food") {
            item.portionId = field("portion_id")?.value || item.portionId;
        } else {
            item.name = field("name")?.value || item.name || "";
            item.portionLabel = field("portion_label")?.value || "";
            item.nutrients = Object.fromEntries(
                [
                    "calories",
                    "protein_g",
                    "carbs_g",
                    "fat_g",
                    "fiber_g",
                    "sugar_g",
                    "alcohol_g",
                    "sodium_mg",
                ].map((key) => [
                    key,
                    field(key)?.value === "" || field(key)?.value == null
                        ? undefined
                        : Number(field(key).value),
                ]),
            );
        }
    });
}

function renderMealComposerItems() {
    const root = document.getElementById("meal-selected-items");
    if (!root) return;
    if (mealComposer.items.length === 0) {
        root.innerHTML = `<div class="empty-state"><div><strong>No foods selected yet.</strong><p>Search for a food, choose a recent item, or add a manual food.</p></div></div>`;
        return;
    }
    root.innerHTML = mealComposer.items
        .map((item, index) => {
            if (item.kind === "food") {
                const portions = item.food.portions || [];
                return `<article class="meal-composer-item" data-composer-index="${index}"><div class="meal-composer-item-head"><div><strong>${escapeHtml(foodTitle(item.food))}</strong><small>${sourceBadge(item.food.provider)} ${confidenceBadge(item.food.confidence)}</small></div><button class="button button-quiet button-small" type="button" data-action="remove-meal-item" data-index="${index}">Remove</button></div><div class="meal-composer-grid"><label class="field"><span>Portion</span><select data-composer-field="portion_id">${portions.map((portion) => `<option value="${escapeHtml(portion.id)}" ${portion.id === item.portionId ? "selected" : ""}>${escapeHtml(portion.label)}</option>`).join("")}</select></label><label class="field"><span>Quantity</span><input data-composer-field="quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(item.quantity || 1)}" /></label></div><small class="meal-composer-macros">${foodMacroLine(item.food, item.portionId)}</small></article>`;
            }
            const nutrients = item.nutrients || {};
            return `<article class="meal-composer-item" data-composer-index="${index}"><div class="meal-composer-item-head"><div><strong>${item.kind === "recent" ? escapeHtml(item.name) : "Manual food"}</strong><small>${sourceBadge(item.sourceType || "user_supplied")} ${item.kind === "recent" ? "From recent meal history" : "Enter the nutrition used"}</small></div><button class="button button-quiet button-small" type="button" data-action="remove-meal-item" data-index="${index}">Remove</button></div><div class="meal-composer-grid"><label class="field"><span>Name</span><input data-composer-field="name" value="${escapeHtml(item.name || "")}" required /></label><label class="field"><span>Portion</span><input data-composer-field="portion_label" value="${escapeHtml(item.portionLabel || "")}" placeholder="1 bowl, 1 slice…" /></label><label class="field"><span>Quantity</span><input data-composer-field="quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(item.quantity || 1)}" /></label></div><div class="meal-composer-nutrients">${["calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg"].map((key) => `<label class="field"><span>${escapeHtml(key.replaceAll("_g", " (g)").replace("sodium_mg", "sodium (mg)"))}</span><input data-composer-field="${key}" type="number" min="0" step="0.1" value="${escapeHtml(nutrients[key] ?? "")}" /></label>`).join("")}</div></article>`;
        })
        .join("");
}

function renderMealSearchResults(data) {
    const root = document.getElementById("meal-food-results");
    if (!root) return;
    mealComposer.options.clear();
    const sections = [];
    if (data.candidates?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Verified foods</h4>${data.candidates
                .map((candidate, index) => {
                    const key = `candidate:${index}`;
                    mealComposer.options.set(key, {
                        kind: "candidate",
                        candidateId: candidate.candidate_id,
                    });
                    const portion = candidate.default_portion;
                    return `<button class="meal-search-result" type="button" data-action="select-meal-option" data-key="${key}"><span><strong>${escapeHtml([candidate.brand, candidate.name].filter(Boolean).join(" — ") || candidate.name)}</strong><small>${sourceBadge(candidate.provider)} ${escapeHtml(portion?.label || "Details available after selection")}</small></span><span>${portion?.calories == null ? "" : `${number(portion.calories)} kcal`}</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    if (data.savedFoods?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Saved foods</h4>${data.savedFoods
                .map((saved, index) => {
                    const key = `saved:${index}`;
                    mealComposer.options.set(key, {
                        kind: "food",
                        food: saved.food,
                        defaultPortionId: saved.defaultPortionId,
                    });
                    return `<button class="meal-search-result" type="button" data-action="select-meal-option" data-key="${key}"><span><strong>${escapeHtml(saved.label)}</strong><small>${sourceBadge(saved.food.provider)} ${escapeHtml(saved.food.name || "Saved food")}</small></span><span>${number(foodPortion(saved.food, saved.defaultPortionId)?.nutrients?.calories)} kcal</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    if (data.recentMealItems?.length) {
        sections.push(
            `<div class="meal-search-section"><h4>Recent foods</h4>${data.recentMealItems
                .map((recent, index) => {
                    const key = `recent:${index}`;
                    mealComposer.options.set(key, { kind: "recent", recent });
                    return `<button class="meal-search-result" type="button" data-action="select-meal-option" data-key="${key}"><span><strong>${escapeHtml(recent.name)}</strong><small>${sourceBadge("past_meal")} ${escapeHtml(recent.portionLabel || "Portion not recorded")}</small></span><span>${number(recent.nutrients?.calories)} kcal</span></button>`;
                })
                .join("")}</div>`,
        );
    }
    root.innerHTML =
        sections.join("") ||
        `<p class="tiny">No matches yet. Try a food name or add a manual food.</p>`;
}

async function searchMealFoods(query) {
    const root = document.getElementById("meal-food-results");
    if (!root) return;
    root.innerHTML = `<p class="tiny">Searching verified foods and personal history…</p>`;
    try {
        const data = await api(
            `/api/app/food-search?query=${encodeURIComponent(query)}&limit=10`,
            { keepPrevious: true },
        );
        renderMealSearchResults(data);
    } catch (error) {
        if (error?.name !== "AbortError")
            root.innerHTML = `<p class="tiny">${escapeHtml(error.message || "Food search failed")}</p>`;
    }
}

async function selectMealOption(key) {
    syncMealComposerFromDom();
    const option = mealComposer.options.get(key);
    if (!option) return;
    if (option.kind === "candidate") {
        const data = await api(
            `/api/app/food-details?candidate_id=${encodeURIComponent(option.candidateId)}`,
            { keepPrevious: true },
        );
        if (!data.food) throw new Error("Food details are no longer available");
        mealComposer.items.push({
            kind: "food",
            food: data.food,
            candidateId: data.food.candidate_id,
            portionId: data.food.portions?.[0]?.id,
            quantity: 1,
        });
    } else if (option.kind === "food") {
        mealComposer.items.push({
            kind: "food",
            food: option.food,
            candidateId: option.food.candidate_id,
            portionId: option.defaultPortionId || option.food.portions?.[0]?.id,
            quantity: 1,
        });
    } else {
        mealComposer.items.push({
            kind: "recent",
            name: option.recent.name,
            quantity: 1,
            portionLabel: option.recent.portionLabel || "",
            nutrients: option.recent.nutrients,
            sourceType: "past_meal",
            provider: option.recent.provider,
            providerFoodId: option.recent.providerFoodId,
            sourceSnapshot: {
                resolution_layer: "personal_history",
                meal_id: option.recent.mealId,
                item_id: option.recent.itemId,
            },
        });
    }
    renderMealComposerItems();
}

async function lookupMealBarcode() {
    const input = document.getElementById("meal-food-barcode");
    const root = document.getElementById("meal-food-results");
    if (!input || !root) return;
    const barcode = input.value.trim();
    if (!barcode) return;
    root.innerHTML = `<p class="tiny">Looking up the package barcode…</p>`;
    const data = await api(
        `/api/app/food-barcode?barcode=${encodeURIComponent(barcode)}`,
        { keepPrevious: true },
    );
    renderMealSearchResults({
        ...data,
        savedFoods: [],
        recentMealItems: [],
    });
}

function openMealComposer() {
    mealComposer.items = [];
    mealComposer.options.clear();
    openDialog(
        "Add meal",
        `<form id="meal-form" class="auth-form"><input type="hidden" name="logged_at" value="${escapeHtml(`${state.date}T12:00:00.000Z`)}" /><label class="field"><span>Meal name</span><input name="description" value="Meal" maxlength="500" required /></label><label class="field"><span>Meal type</span><select name="meal_type"><option value="breakfast">Breakfast</option><option value="lunch" selected>Lunch</option><option value="dinner">Dinner</option><option value="snack">Snack</option></select></label><section class="meal-composer-search"><div class="panel-title"><h3>Find foods</h3><span>Verified, saved, and recent</span></div><div class="meal-composer-search-row"><input class="input" id="meal-food-search" type="search" placeholder="Search oats, yogurt, chicken…" autocomplete="off" /><input class="input" id="meal-food-barcode" inputmode="numeric" placeholder="Barcode" aria-label="Food barcode" /><button class="button button-secondary" type="button" data-action="lookup-food-barcode">Look up</button></div><div id="meal-food-results" class="meal-food-results"></div></section><section><div class="panel-title"><h3>Selected foods</h3><button class="button button-secondary button-small" type="button" data-action="add-manual-food">Add manual food</button></div><div id="meal-selected-items" class="meal-selected-items"></div></section><label class="field"><span>Notes</span><textarea name="notes" rows="2" maxlength="4000" placeholder="Optional"></textarea></label><button class="button button-primary" type="submit">Log meal</button></form>`,
    );
    renderMealComposerItems();
    searchMealFoods("");
}

async function editMeal(id) {
    const card = document.querySelector(`[data-meal-id="${CSS.escape(id)}"]`);
    const description = card?.querySelector("h4")?.textContent || "";
    openDialog(
        "Edit meal",
        `<form id="edit-meal-form" class="auth-form" data-id="${escapeHtml(id)}"><label class="field"><span>Description</span><textarea name="description" rows="4" required>${escapeHtml(description)}</textarea></label><label class="field"><span>Meal type</span><select name="meal_type"><option>breakfast</option><option>lunch</option><option>dinner</option><option>snack</option></select></label><button class="button button-primary" type="submit">Save meal</button></form>`,
    );
}

async function handleAction(button) {
    const action = button.dataset.action;
    if (!action) return;
    if (await handleAccountAction(button, accountContext())) return;
    if (action === "close-dialog") {
        dialog.close();
        return;
    }
    if (action === "refresh") return renderRoute();
    if (action === "date-prev") state.date = shiftDate(state.date, -1);
    if (action === "date-next") state.date = shiftDate(state.date, 1);
    if (action === "date-week-prev") state.date = shiftDate(state.date, -7);
    if (action === "date-week-next") state.date = shiftDate(state.date, 7);
    if (action === "date-today")
        state.date = dateInTimezone(state.bootstrap.profile?.timezone || "UTC");
    if (
        [
            "date-prev",
            "date-next",
            "date-week-prev",
            "date-week-next",
            "date-today",
        ].includes(action)
    )
        return renderRoute();
    if (action === "add-meal") return openMealComposer();
    if (action === "open-meal-draft") {
        await openMealDraft(button.dataset.id);
        return;
    }
    if (action === "select-draft-food-option") {
        await selectDraftFoodOption(button.dataset.key);
        return;
    }
    if (action === "lookup-draft-food-barcode") {
        await lookupDraftFoodBarcode();
        return;
    }
    if (action === "add-draft-manual") {
        mealDraftReview.pendingManual.push({
            name: "",
            quantity: 1,
            portion_label: "",
            nutrients: {},
        });
        renderMealDraftReview(mealDraftReview.draft);
        return;
    }
    if (action === "save-draft-manual") {
        const draft = mealDraftReview.draft;
        if (!draft) return;
        const item = draftManualPayloadFromDom(Number(button.dataset.index));
        const result = await api(
            `/api/app/meal-drafts/${encodeURIComponent(draft.id)}/items`,
            {
                method: "POST",
                body: JSON.stringify({
                    expected_version: draft.version,
                    item,
                }),
                keepPrevious: true,
            },
        );
        mealDraftReview.pendingManual = [];
        renderMealDraftReview(result.draft);
        toast("Manual food added to draft.");
        return;
    }
    if (action === "save-meal-draft") {
        const draft = mealDraftReview.draft;
        if (!draft) return;
        const root = document.getElementById("meal-draft-review");
        const field = (name) =>
            root?.querySelector(`[data-draft-field="${name}"]`);
        const loggedAt = field("logged_at")?.value
            ? new Date(field("logged_at").value).toISOString()
            : null;
        const result = await api(
            `/api/app/meal-drafts/${encodeURIComponent(draft.id)}`,
            {
                method: "PATCH",
                body: JSON.stringify({
                    expected_version: draft.version,
                    description: field("description")?.value || null,
                    meal_type: field("meal_type")?.value,
                    logged_at: loggedAt,
                    notes: field("notes")?.value || null,
                }),
                keepPrevious: true,
            },
        );
        renderMealDraftReview(result.draft);
        toast("Draft details saved.");
        return;
    }
    if (action === "save-draft-item") {
        const draft = mealDraftReview.draft;
        if (!draft) return;
        const index = Number(button.dataset.index);
        const item = draftItemPayloadFromDom(index);
        const record = draft.items[index];
        const result = await api(
            `/api/app/meal-drafts/${encodeURIComponent(draft.id)}/items/${encodeURIComponent(record.id)}`,
            {
                method: "PATCH",
                body: JSON.stringify({ expected_version: draft.version, item }),
                keepPrevious: true,
            },
        );
        renderMealDraftReview(result.draft);
        toast("Draft item saved.");
        return;
    }
    if (action === "remove-draft-item") {
        const draft = mealDraftReview.draft;
        if (!draft) return;
        const index = Number(button.dataset.index);
        const record = draft.items[index];
        if (!record || !confirm(`Remove ${record.name} from this draft?`))
            return;
        const result = await api(
            `/api/app/meal-drafts/${encodeURIComponent(draft.id)}/items/${encodeURIComponent(record.id)}`,
            {
                method: "DELETE",
                body: JSON.stringify({ expected_version: draft.version }),
                keepPrevious: true,
            },
        );
        renderMealDraftReview(result.draft);
        toast("Draft item removed.");
        return;
    }
    if (action === "answer-meal-draft-question") {
        const draft = mealDraftReview.draft;
        const question = button.closest("[data-draft-question-id]");
        const answer = question?.querySelector(
            "[data-draft-question-answer]",
        )?.value;
        if (!draft || !answer?.trim()) {
            toast("Enter an answer or correction first.", "error");
            return;
        }
        const result = await api(
            `/api/app/meal-drafts/${encodeURIComponent(draft.id)}/questions/${encodeURIComponent(button.dataset.questionId)}/answer`,
            {
                method: "POST",
                body: JSON.stringify({
                    expected_version: draft.version,
                    answer,
                }),
                keepPrevious: true,
            },
        );
        renderMealDraftReview(result.draft);
        toast("Draft question answered.");
        return;
    }
    if (action === "confirm-meal-draft") {
        const draft = mealDraftReview.draft;
        if (!draft) return;
        const accepted = Boolean(
            document.querySelector("[data-draft-accept-assumptions]")?.checked,
        );
        if (
            draft.questions.some((question) => question.status === "open") &&
            !accepted
        ) {
            toast(
                "Answer the open questions or accept the remaining assumptions.",
                "error",
            );
            return;
        }
        const result = await api(
            `/api/app/meal-drafts/${encodeURIComponent(draft.id)}/confirm`,
            {
                method: "POST",
                body: JSON.stringify({
                    expected_version: draft.version,
                    confirmed: true,
                    accept_remaining_assumptions: accepted,
                }),
                keepPrevious: true,
            },
        );
        dialog.close();
        toast("Meal confirmed and logged.");
        await renderRoute();
        return result;
    }
    if (action === "cancel-meal-draft") {
        const draft = mealDraftReview.draft;
        if (
            !draft ||
            !confirm("Abandon this meal draft? No meal will be logged.")
        )
            return;
        await api(
            `/api/app/meal-drafts/${encodeURIComponent(draft.id)}/cancel`,
            {
                method: "POST",
                body: JSON.stringify({
                    expected_version: draft.version,
                    confirm: true,
                }),
                keepPrevious: true,
            },
        );
        dialog.close();
        toast("Meal draft abandoned.");
        await renderRoute();
        return;
    }
    if (action === "select-meal-option") {
        await selectMealOption(button.dataset.key);
        return;
    }
    if (action === "remove-meal-item") {
        syncMealComposerFromDom();
        mealComposer.items.splice(Number(button.dataset.index), 1);
        renderMealComposerItems();
        return;
    }
    if (action === "add-manual-food") {
        syncMealComposerFromDom();
        mealComposer.items.push({
            kind: "manual",
            name: "",
            quantity: 1,
            portionLabel: "",
            nutrients: {},
            sourceType: "user_supplied",
        });
        renderMealComposerItems();
        return;
    }
    if (action === "lookup-food-barcode") {
        await lookupMealBarcode();
        return;
    }
    if (action === "edit-meal") return editMeal(button.dataset.id);
    if (action === "insight-range") {
        const days = Number(button.dataset.days);
        if (![7, 30, 90].includes(days)) return;
        state.insightsDays = days;
        return renderInsights();
    }
    if (action === "create-recipe") return openRecipeCreate();
    if (action === "add-recipe-ingredient") {
        syncRecipeComposerFromDom();
        recipeComposer.ingredients.push({
            name: "",
            quantity: 1,
            unit: "",
            preparation: "",
            optional: false,
            nutrients: {},
            sourceType: "user_supplied",
            sourceSnapshot: { entered_by_user: true },
        });
        renderRecipeIngredients();
        return;
    }
    if (action === "remove-recipe-ingredient") {
        syncRecipeComposerFromDom();
        recipeComposer.ingredients.splice(Number(button.dataset.index), 1);
        renderRecipeIngredients();
        return;
    }
    if (action === "select-recipe-food-option") {
        await selectRecipeFoodOption(button.dataset.key);
        return;
    }
    if (action === "view-recipe") return openRecipe(button.dataset.id);
    if (action === "log-recipe")
        return openRecipeLog(button.dataset.id, button.dataset.revision);
    if (action === "plan-recipe") return openRecipePlan(button.dataset.id);
    if (action === "archive-recipe") {
        if (
            !confirm(
                "Archive this recipe? Historical meal logs will be preserved.",
            )
        )
            return;
        await api(`/api/app/recipes/${encodeURIComponent(button.dataset.id)}`, {
            method: "DELETE",
            body: JSON.stringify({
                expected_version: Number(button.dataset.version),
            }),
            keepPrevious: true,
        });
        if (dialog.open) dialog.close();
        toast("Recipe archived.");
        return renderRoute();
    }
    if (action === "duplicate-meal") {
        toast(
            "Open ChatGPT and ask Munch to log this meal again. The original entry was not changed.",
        );
        return;
    }
    if (action === "delete-meal") {
        const id = button.dataset.id;
        if (!confirm(`Permanently delete ${findMeal(id)}?`)) return;
        await api(`/api/app/meals/${encodeURIComponent(id)}`, {
            method: "DELETE",
            keepPrevious: true,
        });
        toast("Meal deleted.");
        return renderRoute();
    }
    if (action === "add-water") {
        openDialog(
            "Add water",
            `<form id="water-form" class="auth-form"><label class="field"><span>Amount (milliliters)</span><input name="amount_ml" type="number" min="1" max="20000" value="350" required /></label><label class="field"><span>Notes</span><input name="notes" placeholder="Optional" /></label><button class="button button-primary" type="submit">Add water</button></form>`,
        );
        return;
    }
    if (action === "add-weight") {
        const preferredWeightUnit = savedWeightUnit(
            state.bootstrap.profile?.preferred_weight_unit,
        );
        openDialog(
            "Add weight",
            `<form id="weight-form" class="auth-form"><label class="field"><span>Weight</span><input name="weight" type="number" min="1" step="0.1" required /></label><label class="field"><span>Unit</span><select name="unit" required><option value="" disabled ${preferredWeightUnit ? "" : "selected"}>Select unit</option><option value="lb" ${preferredWeightUnit === "lb" ? "selected" : ""}>lb</option><option value="kg" ${preferredWeightUnit === "kg" ? "selected" : ""}>kg</option></select></label><label class="field"><span>Notes</span><input name="notes" placeholder="Optional" /></label><button class="button button-primary" type="submit">Add weight</button></form>`,
        );
        return;
    }
    if (action === "billing-checkout") {
        const data = await api("/billing/checkout", {
            method: "POST",
            body: JSON.stringify({ returnTo: "/app/settings/billing" }),
            keepPrevious: true,
        });
        location.href = data.url;
        return;
    }
    if (action === "billing-portal") {
        const data = await api("/billing/portal", {
            method: "POST",
            body: "{}",
            keepPrevious: true,
        });
        location.href = data.url;
        return;
    }
    if (action === "logout") {
        await api("/account/logout", {
            method: "POST",
            body: "{}",
            keepPrevious: true,
        });
        location.href = "/";
        return;
    }
    if (action === "open-chatgpt-import") {
        toast("Open ChatGPT and ask Munch to import your meal-history file.");
        return;
    }
    if (action === "export-account") {
        location.href = "/account/portal";
        return;
    }
    if (action === "add-grocery") {
        return openGroceryAdd(button.dataset.scope);
    }
    if (action === "edit-grocery") {
        const list = document.querySelector(
            `[data-grocery-scope="${CSS.escape(button.dataset.scope)}"]`,
        );
        const item = list?.querySelector(
            `[data-grocery-item-id="${CSS.escape(button.dataset.id)}"]`,
        );
        if (!item) throw new Error("Grocery item is no longer visible");
        openGroceryEdit(
            {
                grocery_item_id: button.dataset.id,
                version: Number(button.dataset.version),
                name: item.querySelector(".grocery-item-main strong")
                    ?.textContent,
                quantity:
                    item.dataset.quantity === ""
                        ? null
                        : Number(item.dataset.quantity),
                unit: item.dataset.unit || null,
                note: item.dataset.note || null,
            },
            button.dataset.scope,
        );
        return;
    }
    if (action === "remove-grocery") {
        if (!confirm("Remove this grocery item from the list?")) return;
        await api(
            `/api/app/groceries/items/${encodeURIComponent(button.dataset.id)}`,
            {
                method: "DELETE",
                body: JSON.stringify({
                    scope: button.dataset.scope,
                    expected_version: Number(button.dataset.version),
                }),
                keepPrevious: true,
            },
        );
        toast("Grocery item removed.");
        return renderRoute();
    }
    if (action === "toggle-grocery-purchased") {
        const purchased = Boolean(button.checked);
        try {
            await api(
                `/api/app/groceries/items/${encodeURIComponent(button.dataset.id)}/purchased`,
                {
                    method: "POST",
                    body: JSON.stringify({
                        scope: button.dataset.scope,
                        purchased,
                        expected_version: Number(button.dataset.version),
                    }),
                    keepPrevious: true,
                },
            );
        } catch (error) {
            button.checked = !purchased;
            throw error;
        }
        toast(purchased ? "Marked purchased." : "Restored to the list.");
        return renderRoute();
    }
    if (action === "clear-purchased") {
        if (!confirm("Remove all purchased items from this list?")) return;
        const result = await api("/api/app/groceries/clear-purchased", {
            method: "POST",
            body: JSON.stringify({ scope: button.dataset.scope }),
            keepPrevious: true,
        });
        toast(
            `${number(result.clearedCount)} purchased item${result.clearedCount === 1 ? "" : "s"} cleared.`,
        );
        return renderRoute();
    }
    if (action === "shopping-mode")
        document.body.classList.toggle("shopping-mode");
}

document.addEventListener("click", async (event) => {
    const link = event.target.closest("a[href^='/app']");
    if (
        link &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        link.target !== "_blank"
    ) {
        event.preventDefault();
        navigate(link.getAttribute("href"));
        return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    try {
        await handleAction(button);
    } catch (error) {
        toast(error.message || "Action failed", "error");
    }
});

document.addEventListener("input", (event) => {
    if (event.target.id === "meal-food-search") {
        window.clearTimeout(mealComposer.searchTimer);
        mealComposer.searchTimer = window.setTimeout(
            () => searchMealFoods(event.target.value),
            240,
        );
    }
    if (event.target.id === "meal-draft-food-search") {
        window.clearTimeout(mealDraftReview.searchTimer);
        mealDraftReview.searchTimer = window.setTimeout(
            () => searchDraftFoods(event.target.value),
            240,
        );
    }
    if (event.target.id === "recipe-food-search") {
        window.clearTimeout(recipeComposer.searchTimer);
        recipeComposer.searchTimer = window.setTimeout(
            () => searchRecipeFoods(event.target.value),
            240,
        );
    }
    if (event.target.id === "food-filter") {
        const value = event.target.value.toLowerCase();
        document.querySelectorAll("[data-food-label]").forEach((row) => {
            row.hidden = !row.dataset.foodLabel.includes(value);
        });
    }
    if (event.target.id === "recipe-filter") {
        const value = event.target.value.toLowerCase();
        document.querySelectorAll("[data-recipe-name]").forEach((card) => {
            card.hidden = !card.dataset.recipeName.includes(value);
        });
    }
});

function mealComposerPayload() {
    syncMealComposerFromDom();
    return mealComposer.items.map((item) =>
        item.kind === "food"
            ? {
                  candidate_id: item.candidateId,
                  portion_id: item.portionId,
                  quantity: item.quantity,
              }
            : {
                  name: item.name,
                  quantity: item.quantity,
                  portion_label: item.portionLabel,
                  nutrients: item.nutrients,
                  source_type: item.sourceType || "user_supplied",
                  provider: item.provider,
                  provider_food_id: item.providerFoodId,
                  source_snapshot: item.sourceSnapshot,
              },
    );
}

document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (
        [
            "settings-profile-form",
            "settings-goals-form",
            "household-create-form",
            "household-invite-form",
        ].includes(form.id)
    ) {
        event.preventDefault();
        try {
            await handleAccountSubmit(form, accountContext());
        } catch (error) {
            toast(error.message || "Save failed", "error");
        }
        return;
    }
    if (
        ![
            "edit-meal-form",
            "meal-form",
            "water-form",
            "weight-form",
            "preferences-form",
            "goals-form",
            "recipe-create-form",
            "recipe-edit-form",
            "recipe-log-form",
            "recipe-plan-form",
            "grocery-add-form",
            "grocery-edit-form",
        ].includes(form.id)
    )
        return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const submit = form.querySelector("button[type='submit']");
    submit.disabled = true;
    try {
        if (form.id === "meal-form") {
            const items = mealComposerPayload();
            const result = await api("/api/app/meals", {
                method: "POST",
                body: JSON.stringify({
                    description: values.description,
                    meal_type: values.meal_type,
                    logged_at: values.logged_at,
                    notes: values.notes || undefined,
                    idempotency_key: crypto.randomUUID(),
                    items,
                }),
                keepPrevious: true,
            });
            toast(
                result.deduplicated
                    ? "This meal was already logged."
                    : "Meal logged.",
            );
        }
        if (form.id === "edit-meal-form") {
            await api(`/api/app/meals/${encodeURIComponent(form.dataset.id)}`, {
                method: "PATCH",
                body: JSON.stringify(values),
                keepPrevious: true,
            });
            toast("Meal updated.");
        }
        if (form.id === "water-form") {
            await api("/api/app/water", {
                method: "POST",
                body: JSON.stringify(values),
                keepPrevious: true,
            });
            toast("Water added.");
        }
        if (form.id === "weight-form") {
            await api("/api/app/weight", {
                method: "POST",
                body: JSON.stringify(values),
                keepPrevious: true,
            });
            toast("Weight added.");
        }
        if (form.id === "preferences-form") {
            values.widgets_enabled = form.elements.widgets_enabled.checked;
            values.preferred_weight_unit = values.preferred_weight_unit || null;
            await api("/api/app/preferences", {
                method: "PUT",
                body: JSON.stringify(values),
                keepPrevious: true,
            });
            state.bootstrap = null;
            toast("Preferences saved.");
        }
        if (form.id === "goals-form") {
            await api("/api/app/goals", {
                method: "PUT",
                body: JSON.stringify(values),
                keepPrevious: true,
            });
            toast("Goals saved.");
        }
        if (form.id === "recipe-create-form") {
            await api("/api/app/recipes", {
                method: "POST",
                body: JSON.stringify({
                    scope: values.scope || "personal",
                    idempotency_key: crypto.randomUUID(),
                    recipe: recipePayloadFromForm(values),
                }),
                keepPrevious: true,
            });
            toast("Recipe created.");
        }
        if (form.id === "recipe-edit-form") {
            await api(
                `/api/app/recipes/${encodeURIComponent(form.dataset.id)}`,
                {
                    method: "PATCH",
                    body: JSON.stringify({
                        expected_version: Number(form.dataset.version),
                        idempotency_key: crypto.randomUUID(),
                        recipe: recipePayloadFromForm(values),
                    }),
                    keepPrevious: true,
                },
            );
            toast("Recipe updated with a new revision.");
        }
        if (form.id === "recipe-log-form") {
            const result = await api(
                `/api/app/recipes/${encodeURIComponent(form.dataset.id)}/log`,
                {
                    method: "POST",
                    body: JSON.stringify({
                        servings_consumed: Number(values.servings_consumed),
                        meal_type: values.meal_type,
                        notes: values.notes || undefined,
                        recipe_revision_id: form.dataset.revision || undefined,
                        idempotency_key: crypto.randomUUID(),
                    }),
                    keepPrevious: true,
                },
            );
            toast(
                result.result?.deduplicated
                    ? "This recipe meal was already logged."
                    : "Recipe meal logged.",
            );
        }
        if (form.id === "recipe-plan-form") {
            await api(
                `/api/app/recipes/${encodeURIComponent(form.dataset.id)}/plan`,
                {
                    method: "POST",
                    body: JSON.stringify({
                        planned_date: values.planned_date,
                        meal_slot: values.meal_slot,
                        servings: Number(values.servings),
                        idempotency_key: crypto.randomUUID(),
                    }),
                    keepPrevious: true,
                },
            );
            toast("Recipe added to the meal plan.");
        }
        if (form.id === "grocery-add-form") {
            await api("/api/app/groceries/items", {
                method: "POST",
                body: JSON.stringify({
                    scope: form.dataset.scope,
                    item: {
                        name: values.name,
                        quantity:
                            values.quantity === ""
                                ? null
                                : Number(values.quantity),
                        unit: values.unit || undefined,
                        note: values.note || undefined,
                        idempotency_key: crypto.randomUUID(),
                    },
                }),
                keepPrevious: true,
            });
            toast("Grocery item added.");
        }
        if (form.id === "grocery-edit-form") {
            await api(
                `/api/app/groceries/items/${encodeURIComponent(form.dataset.id)}`,
                {
                    method: "PATCH",
                    body: JSON.stringify({
                        scope: form.dataset.scope,
                        expected_version: Number(form.dataset.version),
                        item: {
                            name: values.name,
                            quantity:
                                values.quantity === ""
                                    ? null
                                    : Number(values.quantity),
                            unit: values.unit || undefined,
                            note: values.note || undefined,
                        },
                    }),
                    keepPrevious: true,
                },
            );
            toast("Grocery item updated.");
        }
        if (dialog.open) dialog.close();
        await renderRoute();
    } catch (error) {
        toast(error.message || "Save failed", "error");
    } finally {
        submit.disabled = false;
    }
});

refreshButton.addEventListener("click", renderRoute);
quickAction.addEventListener("click", () => {
    toast(
        "Open ChatGPT and ask Munch to log, search, plan, or review nutrition data.",
    );
});
window.addEventListener("popstate", renderRoute);
renderRoute();
