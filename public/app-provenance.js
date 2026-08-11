const content = document.getElementById("app-content");
const title = document.getElementById("page-title");
let renderToken = 0;

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function number(value, digits = 1) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed)
        ? parsed.toFixed(digits).replace(/\.0+$/, "")
        : "0";
}

function sourceName(value) {
    const labels = {
        usda: "USDA",
        open_food_facts: "Open Food Facts",
        saved_food: "Saved food",
        past_meal: "Past meal",
        published_restaurant: "Restaurant nutrition",
        external_web: "External web",
        user_supplied: "Provided label",
        model_estimate: "Estimated",
        legacy_aggregate: "Legacy aggregate",
    };
    return labels[value] || String(value || "Unknown").replaceAll("_", " ");
}

function contributorRows(values, nutrient) {
    if (!values?.length) {
        return `<div class="empty-state"><div><h3>No item-level values</h3><p>This nutrient has no structured contributors in the selected audit window.</p></div></div>`;
    }
    const unit =
        nutrient === "calories"
            ? "kcal"
            : nutrient === "sodium_mg"
              ? "mg"
              : "g";
    return `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Food</th><th>Source</th><th>Contribution</th></tr></thead><tbody>${values
        .map(
            (entry) =>
                `<tr><td><strong>${escapeHtml(entry.name)}</strong></td><td>${escapeHtml(sourceName(entry.source))}</td><td>${number(entry.value)} ${unit}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
}

function provenanceMarkup(data) {
    const coverage = data.coverage;
    const confidence = data.confidence;
    const sources = data.sources || [];
    const sourceRows = sources.length
        ? sources
              .map(
                  (source) =>
                      `<div class="food-row"><div><strong>${escapeHtml(sourceName(source.source))}</strong><small>${number(source.percentOfItems)}% of structured foods</small></div><span>${number(source.itemCount, 0)} items</span></div>`,
              )
              .join("")
        : `<p class="tiny">No structured food sources are recorded in this window.</p>`;
    const nutrientButtons = [
        ["calories", "Calories"],
        ["protein_g", "Protein"],
        ["carbs_g", "Carbs"],
        ["fat_g", "Fat"],
        ["fiber_g", "Fiber"],
        ["sugar_g", "Sugar"],
        ["sodium_mg", "Sodium"],
    ]
        .map(
            ([key, label], index) =>
                `<button class="button ${index === 0 ? "button-secondary" : "button-quiet"} button-small" type="button" data-provenance-nutrient="${key}">${label}</button>`,
        )
        .join("");

    return `<section class="panel panel-span-12" id="provenance-insights"><div class="panel-title"><div><h3>Nutrition data quality</h3><p>${escapeHtml(data.startDate)} through ${escapeHtml(data.endDate)} · ${escapeHtml(data.timezone)}</p></div><span>${number(coverage.itemizedCaloriePercent)}% itemized</span></div><div class="summary-grid"><article class="summary-card primary"><span>Itemized calories</span><strong>${number(coverage.itemizedCaloriePercent)}<small>%</small></strong><small>${number(coverage.structuredMealCount, 0)} structured meals</small></article><article class="summary-card"><span>Food items</span><strong>${number(coverage.itemCount, 0)}</strong><small>With retained source snapshots</small></article><article class="summary-card"><span>Estimated items</span><strong>${number(confidence.estimatedItemCount, 0)}</strong><small>Explicit model estimates</small></article><article class="summary-card"><span>Legacy meals</span><strong>${number(coverage.legacyMealCount, 0)}</strong><small>No fabricated item breakdown</small></article></div><div class="dashboard-grid spacer-top"><div class="panel panel-span-4"><div class="panel-title"><h3>Source mix</h3></div>${sourceRows}${confidence.average == null ? "" : `<p class="tiny spacer-top">Average recorded confidence: ${Math.round(confidence.average * 100)}%</p>`}</div><div class="panel panel-span-8"><div class="panel-title"><div><h3>Top nutrient contributors</h3><p>Which foods supplied the largest recorded amounts.</p></div></div><div class="auth-actions" style="flex-wrap:wrap">${nutrientButtons}</div><div class="spacer-top" id="provenance-contributors">${contributorRows(data.contributors?.calories, "calories")}</div></div></div></section>`;
}

async function loadProvenance() {
    if (!content || !title || title.textContent?.trim() !== "Insights") return;
    if (document.getElementById("provenance-insights")) return;
    const token = ++renderToken;
    try {
        const response = await fetch("/api/app/provenance", {
            credentials: "same-origin",
            headers: { Accept: "application/json" },
            cache: "no-store",
        });
        if (!response.ok) return;
        const data = await response.json();
        if (token !== renderToken || title.textContent?.trim() !== "Insights")
            return;
        const grid = content.querySelector(".dashboard-grid");
        if (!grid || document.getElementById("provenance-insights")) return;
        grid.insertAdjacentHTML("beforeend", provenanceMarkup(data));
        const section = document.getElementById("provenance-insights");
        section._provenanceData = data;
    } catch {
        // Insights remains usable if the optional provenance panel cannot load.
    }
}

document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-provenance-nutrient]");
    if (!button) return;
    const section = document.getElementById("provenance-insights");
    const data = section?._provenanceData;
    const nutrient = button.dataset.provenanceNutrient;
    if (!data || !nutrient) return;
    section
        .querySelectorAll("[data-provenance-nutrient]")
        .forEach((candidate) => {
            candidate.classList.toggle(
                "button-secondary",
                candidate === button,
            );
            candidate.classList.toggle("button-quiet", candidate !== button);
        });
    const target = document.getElementById("provenance-contributors");
    if (target)
        target.innerHTML = contributorRows(
            data.contributors?.[nutrient],
            nutrient,
        );
});

if (content) {
    new MutationObserver(() => queueMicrotask(loadProvenance)).observe(
        content,
        {
            childList: true,
            subtree: true,
        },
    );
}
queueMicrotask(loadProvenance);
