import { describe, expect, test } from "bun:test";

const predeploy = await Bun.file("scripts/predeploy-production.sh").text();

describe("production deployment contract", () => {
    test("keeps production MCP corpus certification opt-in", () => {
        expect(predeploy).toContain('MUNCH_PRODUCTION_MCP_CERT_MODE:-off');
        expect(predeploy).toContain('bun scripts/certification/production-mcp-corpus.ts');
        expect(predeploy).toContain('expected off or run');
    });
});
