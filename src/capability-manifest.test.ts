import { describe, expect, test } from "bun:test";
import {
    assertCapabilityManifest,
    CAPABILITY_MANIFEST,
    MCP_TOOL_CAPABILITY_MAP,
} from "./capability-manifest.js";

describe("cross-surface capability manifest", () => {
    test("has no internally inconsistent contracts", () => {
        expect(assertCapabilityManifest()).toEqual([]);
    });

    test("documents every currently exposed MCP tool", () => {
        expect(Object.keys(MCP_TOOL_CAPABILITY_MAP)).toHaveLength(72);
        expect(
            CAPABILITY_MANIFEST.flatMap(
                (capability) => capability.mcp.entryPoints,
            ),
        ).toHaveLength(72);
    });

    test("does not mistake channel-specific website capabilities for parity gaps", () => {
        for (const capability of CAPABILITY_MANIFEST.filter(
            (item) => item.intentionalChannelException,
        )) {
            expect(capability.gap).toBeNull();
            expect(capability.web.coverage).toBe("complete");
        }
    });
});
