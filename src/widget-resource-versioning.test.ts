import { expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    canonicalWidgetResourceUri,
    versionWidgetResourceUri,
    widgetDescriptionForUri,
    withVersionedWidgetResources,
} from "./widget-resource-versioning.js";

test("widget resources use a release-specific cache key", () => {
    expect(versionWidgetResourceUri("ui://widget/meal-logged.html")).toBe(
        "ui://widget/meal-logged/v2.html",
    );
    expect(
        versionWidgetResourceUri("ui://widget/meal-logged/v2.html"),
    ).toBe("ui://widget/meal-logged/v2.html");
    expect(versionWidgetResourceUri("https://example.com/widget.html")).toBe(
        "https://example.com/widget.html",
    );
    expect(
        canonicalWidgetResourceUri("ui://widget/meal-logged/v2.html"),
    ).toBe("ui://widget/meal-logged.html");
});

test("versioned resources keep a model-facing widget description", () => {
    expect(
        widgetDescriptionForUri("ui://widget/meal-logged/v2.html"),
    ).toContain("compact Munch receipt");
});

test("registration versions tool links and disables the duplicate host border", async () => {
    const registered: Record<string, any> = {};
    const fakeServer = {
        registerTool(name: string, config: Record<string, any>, handler: any) {
            registered.tool = { name, config, handler };
        },
        registerResource(
            name: string,
            uri: string,
            config: Record<string, any>,
            handler: any,
        ) {
            registered.resource = { name, uri, config, handler };
        },
    } as unknown as McpServer;

    const server = withVersionedWidgetResources(fakeServer) as unknown as {
        registerTool: (...args: any[]) => unknown;
        registerResource: (...args: any[]) => unknown;
    };

    server.registerTool(
        "log_meal",
        {
            _meta: {
                ui: { resourceUri: "ui://widget/meal-logged.html" },
            },
        },
        () => ({}),
    );
    expect(registered.tool.config._meta.ui.resourceUri).toBe(
        "ui://widget/meal-logged/v2.html",
    );

    server.registerResource(
        "meal-logged-widget",
        "ui://widget/meal-logged.html",
        { description: "stale legacy resource description" },
        async (uri: URL | string) => ({
            contents: [
                {
                    uri: typeof uri === "string" ? uri : uri.href,
                    mimeType: "text/html;profile=mcp-app",
                    text: "<p>Meal</p>",
                    _meta: { ui: { prefersBorder: true } },
                },
            ],
        }),
    );

    expect(registered.resource.uri).toBe(
        "ui://widget/meal-logged/v2.html",
    );
    expect(registered.resource.config.description).toContain(
        "compact Munch receipt",
    );
    expect(registered.resource.config.description).not.toContain("stale");
    const result = await registered.resource.handler(
        new URL("ui://widget/meal-logged/v2.html"),
    );
    expect(result.contents[0].uri).toBe("ui://widget/meal-logged/v2.html");
    expect(result.contents[0]._meta.ui.prefersBorder).toBe(false);
    expect(result.contents[0]._meta["openai/widgetPrefersBorder"]).toBe(false);
    expect(result.contents[0]._meta["openai/widgetDescription"]).toContain(
        "compact Munch receipt",
    );
});
