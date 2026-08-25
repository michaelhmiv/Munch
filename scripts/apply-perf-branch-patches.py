from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"marker not found in {path}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


def wrap_handler(
    path: str,
    tool_name: str,
    start_old: str,
    start_new: str,
    next_marker: str,
    close_old: str,
    close_new: str,
) -> None:
    file = Path(path)
    text = file.read_text()
    tool_at = text.index(f'"{tool_name}"')
    next_at = text.index(next_marker, tool_at)
    section = text[tool_at:next_at]
    if start_new in section:
        return
    if start_old not in section:
        raise SystemExit(f"handler start not found for {tool_name} in {path}")
    section = section.replace(start_old, start_new, 1)
    close_at = section.rfind(close_old)
    if close_at < 0:
        raise SystemExit(f"handler close not found for {tool_name} in {path}")
    section = section[:close_at] + close_new + section[close_at + len(close_old):]
    file.write_text(text[:tool_at] + section + text[next_at:])


# Blank optional strings should behave like omitted values instead of causing an
# entire model/tool retry before the Munch handler is reached.
replace_once(
    "src/recipe-planning-tools.ts",
    '                query: z.string().min(1).max(200).optional(),',
    '''                query: z.preprocess(
                    (value) =>
                        typeof value === "string"
                            ? value.trim() || undefined
                            : value,
                    z.string().min(1).max(200).optional(),
                ),''',
)

planning_test = Path("src/recipe-planning-tools.test.ts")
planning_text = planning_test.read_text()
planning_case = '''    test("normalizes blank optional recipe queries instead of forcing a retry", () => {
        const tools = captureTools(premiumPersonal);
        const querySchema = tools.get("search_recipes")?.inputSchema.query;
        expect(querySchema.parse("")).toBeUndefined();
        expect(querySchema.parse("   ")).toBeUndefined();
        expect(querySchema.parse("  pasta  ")).toBe("pasta");
    });

'''
if planning_case not in planning_text:
    marker = '    test("keeps the catalog when an account lacks recipe read access", () => {'
    if marker not in planning_text:
        raise SystemExit("recipe planning test insertion marker not found")
    planning_test.write_text(planning_text.replace(marker, planning_case + marker, 1))

# Fill the model-visible analytics gaps while retaining native thrown-error
# semantics for the advanced gateway.
replace_once(
    "src/mcp-latency.ts",
    'import { MCP_TOOL_CAPABILITY_MAP } from "./capability-manifest.js";',
    'import { observeAnalytics } from "./analytics.js";\nimport { MCP_TOOL_CAPABILITY_MAP } from "./capability-manifest.js";',
)
replace_once(
    "src/mcp-latency.ts",
    'export function registerAdvancedToolGateway(server: McpServer): void {',
    'export function registerAdvancedToolGateway(\n    server: McpServer,\n    userId?: string,\n): void {',
)
replace_once(
    "src/mcp-latency.ts",
    '    const toolServer = server as unknown as ToolServer;\n\n    toolServer.registerTool(',
    '''    const toolServer = server as unknown as ToolServer;
    const observe = <T>(
        toolName: string,
        args: Record<string, unknown>,
        handler: () => Promise<T> | T,
    ): Promise<T> | T =>
        userId
            ? observeAnalytics(toolName, async () => handler(), { userId }, args)
            : handler();

    toolServer.registerTool(''',
)
wrap_handler(
    "src/mcp-latency.ts",
    "find_munch_actions",
    '        async ({ query }) => {',
    '        async ({ query }) =>\n            observe("find_munch_actions", { query }, async () => {',
    '    toolServer.registerTool(\n        "run_munch_action"',
    '        },\n    );\n\n',
    '            }),\n    );\n\n',
)
# The final gateway handler is easier to wrap by replacing its start and final
# close inside the function tail.
mcp_latency = Path("src/mcp-latency.ts")
text = mcp_latency.read_text()
run_at = text.index('"run_munch_action"')
section = text[run_at:]
run_start_old = '        async ({ action, args, confirm }) => {'
run_start_new = '''        async ({ action, args, confirm }) =>
            observe(
                "run_munch_action",
                { action, args, confirm },
                async () => {'''
if run_start_new not in section:
    if run_start_old not in section:
        raise SystemExit("run_munch_action handler start not found")
    section = section.replace(run_start_old, run_start_new, 1)
    close_old = '        },\n    );\n}'
    close_new = '                },\n            ),\n    );\n}'
    if close_old not in section:
        raise SystemExit("run_munch_action handler close not found")
    section = section.replace(close_old, close_new, 1)
    mcp_latency.write_text(text[:run_at] + section)

replace_once(
    "src/mcp-runtime.ts",
    '    registerAdvancedToolGateway(optimizedServer);',
    '    registerAdvancedToolGateway(optimizedServer, userId);',
)

replace_once(
    "src/meal-detail-tools.ts",
    'import { z } from "zod";',
    'import { z } from "zod";\nimport { withAnalytics } from "./analytics.js";',
)
wrap_handler(
    "src/meal-detail-tools.ts",
    "get_meal_details",
    '        async ({ meal_id }) => {',
    '''        async ({ meal_id }) =>
            withAnalytics(
                "get_meal_details",
                async () => {''',
    '    toolServer.registerTool(\n        "get_nutrition_provenance"',
    '        },\n    );\n\n',
    '                },\n                { userId },\n                { meal_id },\n            ),\n    );\n\n',
)
