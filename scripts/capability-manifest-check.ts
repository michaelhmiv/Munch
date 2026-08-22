import {
    assertCapabilityManifest,
    MCP_TOOL_CAPABILITY_MAP,
} from "../src/capability-manifest.js";
import { MCP_INFRASTRUCTURE_TOOLS } from "../src/mcp-infrastructure.js";

const errors = assertCapabilityManifest();
const discovered = new Set<string>();
const sourceFiles = new Bun.Glob("src/**/*.ts");

for await (const path of sourceFiles.scan({ cwd: "." })) {
    const source = await Bun.file(path).text();
    const pattern = /registerTool\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/gs;
    for (const match of source.matchAll(pattern)) {
        const toolName = match[1] || match[2] || match[3];
        if (toolName) discovered.add(toolName);
    }
}

for (const toolName of discovered) {
    if (
        !(toolName in MCP_TOOL_CAPABILITY_MAP) &&
        !MCP_INFRASTRUCTURE_TOOLS.has(toolName)
    ) {
        errors.push(
            `MCP tool ${toolName} is registered in source but has no capability contract or infrastructure declaration`,
        );
    }
}

for (const toolName of Object.keys(MCP_TOOL_CAPABILITY_MAP)) {
    if (!discovered.has(toolName)) {
        errors.push(
            `Capability contract lists ${toolName}, but no source registration was found`,
        );
    }
}

for (const toolName of MCP_INFRASTRUCTURE_TOOLS) {
    if (!discovered.has(toolName)) {
        errors.push(
            `MCP infrastructure lists ${toolName}, but no source registration was found`,
        );
    }
    if (toolName in MCP_TOOL_CAPABILITY_MAP) {
        errors.push(
            `MCP infrastructure tool ${toolName} must not also masquerade as an outcome capability`,
        );
    }
}

if (errors.length > 0) {
    console.error("Cross-surface capability manifest check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log(
    `Cross-surface capability manifest passed: ${discovered.size} MCP tools (${MCP_INFRASTRUCTURE_TOOLS.size} infrastructure), ${new Set(Object.values(MCP_TOOL_CAPABILITY_MAP)).size} outcome capabilities.`,
);
