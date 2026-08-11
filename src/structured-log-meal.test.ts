import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withCanonicalStructuredLogMeal } from "./structured-log-meal.js";

describe("canonical structured log_meal adapter", () => {
    test("extends log_meal while preserving aggregate compatibility", async () => {
        let capturedConfig: Record<string, any> | null = null;
        let capturedHandler:
            ((args: Record<string, any>) => Promise<any>) | null = null;
        let legacyCalls = 0;
        const fakeServer = {
            registerTool(
                _name: string,
                config: Record<string, any>,
                handler: (args: Record<string, any>) => Promise<any>,
            ) {
                capturedConfig = config;
                capturedHandler = handler;
                return {};
            },
        } as unknown as McpServer;

        const wrapped = withCanonicalStructuredLogMeal(
            fakeServer,
            "11111111-1111-4111-8111-111111111111",
        ) as unknown as {
            registerTool: (
                name: string,
                config: Record<string, any>,
                handler: (args: Record<string, any>) => Promise<any>,
            ) => unknown;
        };

        wrapped.registerTool(
            "log_meal",
            {
                description: "Legacy meal logger",
                inputSchema: { description: z.string() },
                outputSchema: { action: z.string() },
            },
            async () => {
                legacyCalls += 1;
                return {
                    content: [{ type: "text", text: "legacy" }],
                    structuredContent: { action: "logged" },
                };
            },
        );

        expect(capturedConfig).not.toBeNull();
        expect(capturedConfig!.inputSchema.items).toBeDefined();
        expect(capturedConfig!.outputSchema.meal_items).toBeDefined();
        expect(capturedConfig!.description).toContain(
            "persistent local catalog before USDA and Open Food Facts",
        );

        const result = await capturedHandler!({ description: "legacy" });
        expect(result.content[0].text).toBe("legacy");
        expect(legacyCalls).toBe(1);
    });

    test("does not alter unrelated tool registrations", () => {
        let registeredName = "";
        const fakeServer = {
            registerTool(name: string) {
                registeredName = name;
                return {};
            },
        } as unknown as McpServer;
        const wrapped = withCanonicalStructuredLogMeal(
            fakeServer,
            "11111111-1111-4111-8111-111111111111",
        ) as unknown as {
            registerTool: (
                name: string,
                config: Record<string, any>,
                handler: () => unknown,
            ) => unknown;
        };
        wrapped.registerTool("get_meals_today", {}, () => ({}));
        expect(registeredName).toBe("get_meals_today");
    });
});
