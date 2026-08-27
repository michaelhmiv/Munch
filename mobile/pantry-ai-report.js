import { requestJson as api } from "./mobile-runtime.js";

const MAX_EXCERPT_LENGTH = 2000;

function reportExcerpt(card) {
    return [...card.querySelectorAll("h3, p, .idea-detail")]
        .map((node) => node.textContent?.trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, MAX_EXCERPT_LENGTH);
}

async function reportSuggestion(button, card) {
    const contentExcerpt = reportExcerpt(card);
    if (!contentExcerpt) return;
    const confirmed = window.confirm(
        "Report this AI-generated meal suggestion to Munch for safety review?",
    );
    if (!confirmed) return;

    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "Reporting…";
    try {
        await api("/api/app/pantry/meal-ideas/report", {
            method: "POST",
            body: JSON.stringify({
                surface: "pantry_meal_idea",
                reason: "offensive",
                content_excerpt: contentExcerpt,
            }),
        });
        button.textContent = "Reported";
        button.dataset.reported = "true";
        button.setAttribute("aria-label", "AI suggestion reported to Munch");
    } catch (error) {
        button.disabled = false;
        button.textContent = originalLabel;
        window.alert(
            error?.message || "Munch could not submit this report. Try again.",
        );
    }
}

function decorateReportableIdeas() {
    for (const card of document.querySelectorAll(
        ".meal-idea-card:not([data-ai-report-ready])",
    )) {
        card.dataset.aiReportReady = "true";
        const actions = document.createElement("div");
        actions.className = "idea-report-actions";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = "Report AI suggestion";
        button.setAttribute(
            "aria-label",
            "Report this AI-generated suggestion to Munch",
        );
        button.addEventListener("click", () => {
            void reportSuggestion(button, card);
        });
        actions.append(button);
        card.append(actions);
    }
}

const mealIdeas = document.querySelector("#meal-ideas");
if (mealIdeas) {
    new MutationObserver(decorateReportableIdeas).observe(mealIdeas, {
        childList: true,
        subtree: true,
    });
    decorateReportableIdeas();
}
