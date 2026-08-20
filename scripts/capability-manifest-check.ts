import {
    assertCapabilityManifest,
    MCP_TOOL_CAPABILITY_MAP,
} from "../src/capability-manifest.js";

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
    if (!(toolName in MCP_TOOL_CAPABILITY_MAP)) {
        errors.push(
            `MCP tool ${toolName} is registered in source but has no capability contract`,
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

if (errors.length > 0) {
    console.error("Cross-surface capability manifest check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log(
    `Cross-surface capability manifest passed: ${discovered.size} MCP tools, ${new Set(Object.values(MCP_TOOL_CAPABILITY_MAP)).size} outcome capabilities.`,
);
