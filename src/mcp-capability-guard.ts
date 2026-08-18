import type { MunchCapabilities } from "./billing/capabilities.js";
import type { PlanningScope } from "./planning/repository.js";

/**
 * Keep entitlement failures neutral in MCP. The host should not be turned into
 * a billing or account-recovery surface, and the same message is useful for a
 * temporarily unavailable capability lookup as it is for an account without a
 * particular feature.
 */
export const MUNCH_FEATURE_UNAVAILABLE_MESSAGE =
    "This Munch feature is unavailable for the current connection.";

export type AccessibleScope = "personal" | "household" | "all";

export function requireCapability(allowed: boolean): void {
    if (!allowed) throw new Error(MUNCH_FEATURE_UNAVAILABLE_MESSAGE);
}

export function hasRecipeAccess(
    capabilities: MunchCapabilities,
    scope: AccessibleScope = "all",
    write = false,
): boolean {
    if (scope === "personal") {
        return write
            ? capabilities.personalRecipesWrite
            : capabilities.personalRecipesRead;
    }
    if (scope === "household") {
        return write ? capabilities.householdWrite : capabilities.householdRead;
    }
    return write
        ? capabilities.personalRecipesWrite || capabilities.householdWrite
        : capabilities.personalRecipesRead || capabilities.householdRead;
}

export function requireRecipeAccess(
    capabilities: MunchCapabilities,
    scope: AccessibleScope = "all",
    write = false,
): void {
    requireCapability(hasRecipeAccess(capabilities, scope, write));
}

export function requireRecipeScope(
    scope: Exclude<AccessibleScope, "all">,
    capabilities: MunchCapabilities,
    write: boolean,
): PlanningScope {
    requireRecipeAccess(capabilities, scope, write);
    if (scope === "personal") return { type: "personal" };

    const household = capabilities.household;
    requireCapability(Boolean(household));
    return { type: "household", householdId: household!.householdId };
}

export function hasPlanningAccess(
    capabilities: MunchCapabilities,
    scope: AccessibleScope = "all",
    write = false,
): boolean {
    if (scope === "personal") {
        return write
            ? capabilities.personalPlanningWrite
            : capabilities.personalPlanningRead;
    }
    if (scope === "household") {
        return write ? capabilities.householdWrite : capabilities.householdRead;
    }
    return write
        ? capabilities.personalPlanningWrite || capabilities.householdWrite
        : capabilities.personalPlanningRead || capabilities.householdRead;
}

export function requirePlanningAccess(
    capabilities: MunchCapabilities,
    scope: AccessibleScope = "all",
    write = false,
): void {
    requireCapability(hasPlanningAccess(capabilities, scope, write));
}

export function requirePlanningScope(
    scope: Exclude<AccessibleScope, "all">,
    capabilities: MunchCapabilities,
    write: boolean,
): PlanningScope {
    requirePlanningAccess(capabilities, scope, write);
    if (scope === "personal") return { type: "personal" };

    const household = capabilities.household;
    requireCapability(Boolean(household));
    return { type: "household", householdId: household!.householdId };
}
