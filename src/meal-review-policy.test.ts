import { expect, test } from "bun:test";
import { getWidgetHtml } from "./widgets.js";

const runtimeSource = await Bun.file("./src/mcp-runtime.ts").text();
const toolSource = await Bun.file("./src/meal-review-tools.ts").text();

test("photo policy prefers atomic inference-first review", () => {
    expect(runtimeSource).toContain("use prepare_meal_review");
    expect(runtimeSource).toContain(
        "infer homemade versus restaurant from the evidence instead of asking by default",
    );
    expect(runtimeSource).toContain("Use visible scale references");
    expect(runtimeSource).toContain(
        "Put low-impact uncertainty into explicit assumptions",
    );
    expect(runtimeSource).not.toContain(
        "interview the user across multiple turns",
    );
    expect(runtimeSource).not.toContain(
        "Establish provenance: restaurant/takeout or homemade?",
    );
});

test("atomic review tools preserve explicit confirmation", () => {
    expect(toolSource).toContain(
        "This tool does not save the meal permanently",
    );
    expect(toolSource).toContain(
        "call confirm_meal_draft only after explicit approval",
    );
    expect(toolSource).toContain("accept_remaining_assumptions");
});

test("meal review widget exposes one primary and one adjustment action", async () => {
    const html = await getWidgetHtml("meal-review");
    expect(html).toContain('id="confirm"');
    expect(html).toContain('id="adjust"');
    expect(html).not.toContain('id="cancel"');
    expect(html).not.toContain("<textarea");
    expect(html).toContain('API.callTool("confirm_meal_draft"');
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain("min-height: 44px");
    expect(html).toContain("Meal logged");
});
