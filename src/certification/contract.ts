export const REQUIRED_MCP_TOOLS = [
    "log_meal",
    "get_nutrition_summary",
    "search_meals",
    "lookup_barcode",
    "search_foods",
    "get_food_details",
    "lookup_food_barcode",
    "save_food",
    "search_saved_foods",
    "list_saved_foods",
    "mark_saved_food_used",
    "delete_saved_food",
    "start_meal_draft",
    "get_meal_draft",
    "update_meal_draft",
    "upsert_meal_draft_item",
    "add_meal_draft_question",
    "answer_meal_draft_question",
    "prepare_meal_confirmation",
    "confirm_meal_draft",
    "cancel_meal_draft",
] as const;

export const MINIMUM_MCP_TOOL_COUNT = 30;

export interface McpToolContractResult {
    ok: boolean;
    toolCount: number;
    missingRequiredTools: string[];
    duplicateTools: string[];
}

export function evaluateMcpToolContract(
    toolNames: string[],
): McpToolContractResult {
    const counts = new Map<string, number>();
    for (const name of toolNames) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const missingRequiredTools = REQUIRED_MCP_TOOLS.filter(
        (name) => !counts.has(name),
    );
    const duplicateTools = [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name)
        .sort();
    return {
        ok:
            missingRequiredTools.length === 0 &&
            duplicateTools.length === 0 &&
            toolNames.length >= MINIMUM_MCP_TOOL_COUNT,
        toolCount: toolNames.length,
        missingRequiredTools: [...missingRequiredTools],
        duplicateTools,
    };
}
