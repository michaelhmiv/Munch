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
        const registered = Object.keys(MCP_TOOL_CAPABILITY_MAP).sort();
        const documented = CAPABILITY_MANIFEST.flatMap(
            (capability) => capability.mcp.entryPoints,
        ).sort();
        expect(documented).toEqual(registered);
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
