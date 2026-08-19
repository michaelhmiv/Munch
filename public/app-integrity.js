// Compatibility adapter for the legacy website renderer.
//
// Nutrition calculations and goals come from the server-side canonical range
// contract. This module only presents that data until app.js is retired. It
// also retires the old Foods workspace while saved-food MCP compatibility
// remains available server-side.

if (location.pathname === "/app/foods") {
    location.replace("/app/log");
}

function retireFoodsLinks() {
    document
        .querySelectorAll('[data-route="foods"], a[href="/app/foods"]')
        .forEach((node) => node.remove());
}

retireFoodsLinks();

const nativeFetch = window.fetch.bind(window);
let latestInsights = null;

function requestPath(input) {
    try {
        if (input instanceof Request) {
            return new URL(input.url, location.href).pathname;
        }
        return new URL(String(input), location.href).pathname;
    } catch {
        return "";
    }
}

window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (requestPath(args[0]) === "/api/app/insights" && response.ok) {
        void response
            .clone()
            .json()
            .then((data) => {
                latestInsights = data;
                queueMicrotask(syncInsightsGoals);
            })
            .catch(() => undefined);
    }
    return response;
};

const goalFields = new Map([
    ["Average calories", ["daily_calories", "kcal"]],
    ["Average protein", ["daily_protein_g", "g"]],
    ["Average carbs", ["daily_carbs_g", "g"]],
    ["Average fat", ["daily_fat_g", "g"]],
]);

function formatTarget(value) {
    return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 1,
    }).format(Number(value));
}

function syncInsightsGoals() {
    if (location.pathname !== "/app/insights" || !latestInsights?.goals) {
        return;
    }
    const goals = latestInsights.goals;
    document.querySelectorAll(".summary-card").forEach((card) => {
        const label = card.querySelector(":scope > span")?.textContent?.trim();
        const definition = label ? goalFields.get(label) : null;
        if (!definition) return;

        const [field, unit] = definition;
        const target = Number(goals[field]);
        if (!Number.isFinite(target) || target <= 0) return;

        const detail = card.querySelector(":scope > small");
        if (detail) {
            detail.textContent = `${formatTarget(target)} ${unit} target`;
        }
        card.dataset.goalSource = "nutrition_goals";

        const valueText =
            card.querySelector(":scope > strong")?.textContent || "";
        const current = Number(valueText.replace(/[^0-9.+-]/g, ""));
        if (!Number.isFinite(current)) return;

        const progress = Math.max(
            0,
            Math.min(100, Math.round((current / target) * 100)),
        );
        let bar = card.querySelector(":scope > .progress");
        if (!bar) {
            bar = document.createElement("div");
            bar.className = "progress";
            bar.append(document.createElement("span"));
            card.append(bar);
        }
        bar.setAttribute("aria-label", `${progress}% of target`);
        const fill = bar.querySelector("span");
        if (fill) fill.style.width = `${progress}%`;
    });
}

const content = document.getElementById("app-content");
if (content) {
    const observer = new MutationObserver(() => {
        retireFoodsLinks();
        syncInsightsGoals();
    });
    observer.observe(content, { childList: true, subtree: true });
}
