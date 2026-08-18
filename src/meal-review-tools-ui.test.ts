import { expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMealReviewTools } from "./meal-review-tools.js";

function registeredToolConfigs(widgetsEnabled: boolean) {
    const configs = new Map<string, Record<string, any>>();
    const fakeServer = {
        registerTool(name: string, config: Record<string, any>) {
            configs.set(name, config);
        },
        registerResource() {},
    } as unknown as McpServer;

    registerMealReviewTools(fakeServer, "test-user", widgetsEnabled);
    return configs;
}

test("meal review tools advertise UI only when widget display is enabled", () => {
    const enabled = registeredToolConfigs(true);
    for (const name of ["prepare_meal_review", "resolve_meal_review"]) {
        expect(enabled.get(name)?._meta?.ui?.resourceUri).toBe(
            "ui://widget/meal-review.html",
        );
    }

    const disabled = registeredToolConfigs(false);
    for (const name of ["prepare_meal_review", "resolve_meal_review"]) {
        expect(disabled.get(name)?._meta?.ui).toBeUndefined();
    }
});
