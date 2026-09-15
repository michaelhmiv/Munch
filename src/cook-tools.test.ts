import { expect, test } from "bun:test";
import { registerCookTools } from "./cook-tools.js";

test("Cooks MCP tools expose the durable file input and shared widget", () => {
    const tools = new Map<string, Record<string, any>>();
    let resource: Record<string, any> | null = null;
    const server = {
        registerTool(name: string, config: Record<string, any>) {
            tools.set(name, config);
        },
        registerResource(
            name: string,
            uri: string,
            config: Record<string, any>,
        ) {
            resource = { name, uri, config };
        },
    };

    registerCookTools(server, "00000000-0000-4000-8000-000000000001");

    expect(tools.has("start_cook")).toBe(true);
    expect(tools.has("update_cook")).toBe(true);
    expect(tools.has("update_cook_dish")).toBe(true);
    expect(tools.has("search_cooks")).toBe(true);
    expect(tools.has("log_cook_portion")).toBe(true);
    expect(tools.get("start_cook")?._meta?.["openai/fileParams"]).toEqual([
        "files",
    ]);
    expect(tools.get("update_cook")?._meta?.["openai/fileParams"]).toEqual([
        "files",
    ]);
    expect(resource).not.toBeNull();
    const resourceValue = resource as any;
    expect(resourceValue?.uri).toBe("ui://widget/cook-summary.html");
});

test("the cook widget contains the supported ChatGPT upload flow", async () => {
    const template = await Bun.file(
        "public/widgets/src/templates/cook-summary.html",
    ).text();
    expect(template).toContain("window.openai.uploadFile");
    expect(template).toContain("window.openai.getFileDownloadUrl");
    expect(template).toContain('API.callTool("update_cook"');
});
