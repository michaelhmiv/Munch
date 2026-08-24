export const INVENTORY_CAPABILITY_CONTRACTS = [
    {
        id: "inventory.read",
        mcp: ["get_pantry"],
        web: ["GET /api/app/pantry", "/app/pantry"],
    },
    {
        id: "inventory.reconcile",
        mcp: ["reconcile_pantry"],
        web: ["POST /api/app/pantry/reconcile", "POST /api/app/pantry/scan-preview"],
    },
    {
        id: "purchase.reconcile",
        mcp: ["reconcile_purchase"],
        web: ["POST /api/app/purchases/reconcile", "POST /api/app/purchases/receipt-preview"],
    },
] as const;

/**
 * Pantry is premium and user-opt-in, so these tools are registered only for an
 * eligible connection. They remain explicit outcome contracts even though they
 * are intentionally absent from the baseline catalog used by free/disabled
 * accounts.
 */
export const CONDITIONAL_PREMIUM_MCP_TOOL_CAPABILITY_MAP = {
    get_pantry: "inventory.read",
    reconcile_pantry: "inventory.reconcile",
    reconcile_purchase: "purchase.reconcile",
} as const;
