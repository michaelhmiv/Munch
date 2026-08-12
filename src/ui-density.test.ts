import { expect, test } from "bun:test";

async function source(path: string): Promise<string> {
    return Bun.file(path).text();
}

test("web diary uses progressive disclosure for structured meal audit data", async () => {
    const [html, css] = await Promise.all([
        source("./public/app.html"),
        source("./public/app-overrides.css"),
    ]);

    expect(html).toContain('card.classList.add("is-structured")');
    expect(html).toContain("heading.textContent = `${rows.length} food");
    expect(html).toContain('auditSummary.textContent = "Log details"');
    expect(html).toContain('summary.textContent = "Source & estimate"');
    expect(html).toContain('label.textContent = "Original description"');
    expect(css).toContain(".meal-card.is-structured");
    expect(css).toContain(".meal-audit");
    expect(css).toContain(".food-audit");
    expect(css).toContain(".settings-index-card");
});

test("logged-meal widget stays compact while retaining food and audit details", async () => {
    const template = await source(
        "./public/widgets/src/templates/meal-logged.html",
    );

    expect(template).toContain("View ${items.length} food");
    expect(template).toContain("Source & estimate");
    expect(template).toContain("Log details");
    expect(template).toContain("originalTitle");
    expect(template).toContain("P ${fmt(meal.protein_g, 1)}g");
    expect(template).not.toContain("Today after this meal");
});

test("meal-review widget exposes approval data first and estimate audit second", async () => {
    const template = await source(
        "./public/widgets/src/templates/meal-review.html",
    );

    expect(template).toContain("Estimate details");
    expect(template).toContain("Original description");
    expect(template).toContain("sourceRows");
    expect(template).toContain("review-flags");
    expect(template).toContain("Needs input");
    expect(template).not.toContain("How Munch estimated this");
});
