/**
 * MCP tools that exist only to route or discover customer-facing operations.
 * They are intentionally not outcome capabilities: every business operation
 * they surface remains documented in MCP_TOOL_CAPABILITY_MAP.
 */
export const MCP_INFRASTRUCTURE_TOOLS = new Set([
    "find_munch_actions",
    "run_munch_action",
]);
