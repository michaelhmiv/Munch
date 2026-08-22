import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
    compactToolDescription,
    directModelToolCount,
    isModelPrivateTool,
    registerAdvancedToolGateway,
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

    test("keeps only the direct conversational surface model-visible", () => {
        expect(directModelToolCount()).toBe(35);
        expect(isModelPrivateTool("get_grocery_list")).toBe(false);
        expect(isModelPrivateTool("confirm_meal_draft")).toBe(false);
        expect(isModelPrivateTool("get_meals_by_date_range")).toBe(false);

        expect(isModelPrivateTool("get_meals_by_date")).toBe(true);
        expect(isModelPrivateTool("set_timezone")).toBe(true);
        expect(isModelPrivateTool("update_weight")).toBe(true);
        expect(isModelPrivateTool("mark_saved_food_used")).toBe(true);
        expect(isModelPrivateTool("start_meal_draft")).toBe(true);

        // Infrastructure and third-party registrations are not accidentally
        // hidden merely because they are absent from Munch's capability map.
        expect(isModelPrivateTool("example_tool")).toBe(false);
    });

    test("marks deferred tools private without changing metadata or handlers", async () => {
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
            "set_timezone",
            {
                description: "Set timezone. More detail follows.",
                annotations: { readOnlyHint: false },
                _meta: {
                    ui: { resourceUri: "ui://settings" },
                    custom: true,
                },
            },
            handler,
        );

        expect(capturedName).toBe("set_timezone");
        expect(isModelPrivateTool(capturedName)).toBe(true);
        expect(capturedConfig.annotations).toEqual({ readOnlyHint: false });
        expect(capturedConfig._meta.custom).toBe(true);
        expect(capturedConfig._meta["openai/visibility"]).toBe("private");
        expect(capturedConfig._meta.ui.resourceUri).toBe("ui://settings");
        expect(capturedConfig._meta.ui.visibility).toEqual(["app"]);
        expect(capturedHandler).toBe(handler);
        expect(await capturedHandler!({})).toEqual({ ok: true });
    });

    test("discovers and executes a private action through the gateway", async () => {
        const registered = new Map<
            string,
            {
                config: Record<string, any>;
                handler: (args: Record<string, any>) => any;
            }
        >();
        const fakeServer = {
            registerTool(
                name: string,
                config: Record<string, any>,
                handler: (args: Record<string, any>) => any,
            ) {
                registered.set(name, { config, handler });
                return { name };
            },
        } as unknown as McpServer;
        const wrapped = withLatencyOptimizedToolCatalog(fakeServer);
        let received: Record<string, any> | null = null;

        (wrapped as any).registerTool(
            "set_timezone",
            {
                title: "Set Timezone",
                description: "Set the user's IANA timezone for dated entries.",
                inputSchema: {
                    timezone: z
                        .string()
                        .min(1)
                        .describe("IANA timezone such as America/Chicago"),
                },
            },
            async (args: Record<string, any>) => {
                received = args;
                return { content: [{ type: "text", text: "Timezone saved." }] };
            },
        );
        registerAdvancedToolGateway(wrapped);

        const finder = registered.get("find_munch_actions");
        const runner = registered.get("run_munch_action");
        expect(finder).toBeDefined();
        expect(runner).toBeDefined();

        const found = await finder!.handler({ query: "change timezone" });
        expect(found.structuredContent.actions[0].action).toBe("set_timezone");
        expect(found.structuredContent.actions[0].parameters).toEqual([
            expect.objectContaining({
                name: "timezone",
                type: "string",
                required: true,
            }),
        ]);

        await runner!.handler({
            action: "set_timezone",
            args: { timezone: "America/Chicago" },
        });
        expect(received).toEqual({ timezone: "America/Chicago" });
    });

    test("gateway validates private action arguments before invoking handlers", async () => {
        const registered = new Map<string, any>();
        const fakeServer = {
            registerTool(name: string, config: any, handler: any) {
                registered.set(name, { config, handler });
                return { name };
            },
        } as unknown as McpServer;
        const wrapped = withLatencyOptimizedToolCatalog(fakeServer);
        let calls = 0;

        (wrapped as any).registerTool(
            "delete_weight",
            {
                description: "Delete a weight entry.",
                inputSchema: {
                    id: z.string().uuid(),
                },
            },
            async () => {
                calls += 1;
                return { ok: true };
            },
        );
        registerAdvancedToolGateway(wrapped);

        const runner = registered.get("run_munch_action");
        await expect(
            runner.handler({ action: "delete_weight", args: { id: "bad" } }),
        ).rejects.toThrow();
        expect(calls).toBe(0);
    });
});
