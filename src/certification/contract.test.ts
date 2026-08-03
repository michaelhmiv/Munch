import { describe, expect, test } from "bun:test";
import {
    MINIMUM_MCP_TOOL_COUNT,
    REQUIRED_MCP_TOOLS,
    evaluateMcpToolContract,
} from "./contract.js";

describe("MCP certification contract", () => {
    test("passes a complete unique tool catalog", () => {
        const extras = Array.from(
            { length: Math.max(0, MINIMUM_MCP_TOOL_COUNT - REQUIRED_MCP_TOOLS.length) },
            (_, index) => `extra_tool_${index}`,
        );
        const result = evaluateMcpToolContract([
            ...REQUIRED_MCP_TOOLS,
            ...extras,
        ]);
        expect(result.ok).toBe(true);
        expect(result.missingRequiredTools).toEqual([]);
        expect(result.duplicateTools).toEqual([]);
    });

    test("reports missing and duplicate tools", () => {
        const result = evaluateMcpToolContract([
            "log_meal",
            "log_meal",
            ...Array.from(
                { length: MINIMUM_MCP_TOOL_COUNT - 2 },
                (_, index) => `other_${index}`,
            ),
        ]);
        expect(result.ok).toBe(false);
        expect(result.duplicateTools).toEqual(["log_meal"]);
        expect(result.missingRequiredTools).toContain("confirm_meal_draft");
    });

    test("fails a catalog below the commercial minimum", () => {
        const result = evaluateMcpToolContract([...REQUIRED_MCP_TOOLS]);
        expect(result.ok).toBe(
            REQUIRED_MCP_TOOLS.length >= MINIMUM_MCP_TOOL_COUNT,
        );
    });
});
