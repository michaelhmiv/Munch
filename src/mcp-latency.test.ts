import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    compactToolDescription,
    isModelPrivateTool,
    withLatencyOptimizedToolCatalog,
} from "./mcp-latency.js";

describe("MCP latency catalog optimization", () => {
    test("uses concise direct-routing descriptions for common tools", () => {
        const description = compactToolDescription(
            "get_grocery_list",
            "A deliberately huge original description that should be replaced.",
        );

        expect(description).toContain("active grocery list");
        expect(description).toContain("Use directly");
        expect(description.length).toBeLessThan(261);
    });

    test("compacts unmapped verbose descriptions to one bounded sentence", () => {
        const description = compactToolDescription(
            "example_tool",
            "First sentence explains the tool clearly. Second sentence contains a large amount of implementation detail that the model does not need for routing.",
        );

        expect(description).toBe("First sentence explains the tool clearly.");
        expect(description.length).toBeLessThan(261);
    });

    test("marks superseded compatibility tools private without changing handlers", async () => {
        let capturedName = "";
        let capturedConfig: Record<string, any> = {};
        let capturedHandler: ((args: Record<string, any>) => any) | undefined;
        const fakeServer = {
            registerTool(
                name: string,
                config: Record<string, any>,
                handler: (args: Record<string, any>) => any,
            ) {
                capturedName = name;
                capturedConfig = config;
                capturedHandler = handler;
                return { name };
            },
        } as unknown as McpServer;
        const wrapped = withLatencyOptimizedToolCatalog(fakeServer);
        const handler = async () => ({ ok: true });

        (wrapped as any).registerTool(
            "start_meal_draft",
            {
                description: "Legacy draft workflow. More detail follows.",
                annotations: { readOnlyHint: false },
                _meta: { ui: { resourceUri: "ui://meal-review" }, custom: true },
            },
            handler,
        );

        expect(capturedName).toBe("start_meal_draft");
        expect(isModelPrivateTool(capturedName)).toBe(true);
        expect(capturedConfig.annotations).toEqual({ readOnlyHint: false });
        expect(capturedConfig._meta.custom).toBe(true);
        expect(capturedConfig._meta["openai/visibility"]).toBe("private");
        expect(capturedConfig._meta.ui.resourceUri).toBe("ui://meal-review");
        expect(capturedConfig._meta.ui.visibility).toEqual(["app"]);
        expect(capturedHandler).toBe(handler);
        expect(await capturedHandler!({})).toEqual({ ok: true });
    });

    test("keeps canonical confirmation tool model-visible", () => {
        expect(isModelPrivateTool("confirm_meal_draft")).toBe(false);
        expect(isModelPrivateTool("prepare_meal_review")).toBe(false);
        expect(isModelPrivateTool("get_grocery_list")).toBe(false);
    });
});
