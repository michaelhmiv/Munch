import {
    PROTECTED_COMMERCE_PATHS,
    PROTECTED_COMMERCE_TERMS,
} from "../src/product-config.js";

const root = new URL("../", import.meta.url);
const rootPath = root.pathname;
const findings: string[] = [];
const inspected = new Set<string>();

function hasGlob(pattern: string): boolean {
    return /[*?[\]{}]/.test(pattern);
}

function stringLiterals(source: string): string[] {
    const values: string[] = [];
    const pattern = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
    for (const match of source.matchAll(pattern)) {
        const value = match[2]?.trim() ?? "";
        if (!value || value.startsWith("./") || value.startsWith("../")) {
            continue;
        }
        values.push(value.replace(/\\[nrt]/g, " "));
    }
    return values;
}

async function inspectFile(relativePath: string): Promise<void> {
    if (inspected.has(relativePath)) return;
    inspected.add(relativePath);

    const file = Bun.file(new URL(relativePath, root));
    if (!(await file.exists())) return;

    const text = await file.text();
    const surfaces = relativePath.endsWith(".html")
        ? [text]
        : stringLiterals(text);

    for (const surface of surfaces) {
        const normalized = surface.toLowerCase().replace(/\s+/g, " ");
        for (const term of PROTECTED_COMMERCE_TERMS) {
            if (normalized.includes(term)) {
                findings.push(`${relativePath}: ${term}`);
            }
        }
    }
}

async function inspectPattern(pattern: string): Promise<void> {
    if (!hasGlob(pattern)) {
        await inspectFile(pattern);
        return;
    }

    const glob = new Bun.Glob(pattern);
    for await (const relativePath of glob.scan({ cwd: rootPath })) {
        await inspectFile(relativePath);
    }
}

for (const pattern of PROTECTED_COMMERCE_PATHS) {
    await inspectPattern(pattern);
}

if (findings.length > 0) {
    console.error(
        "Commercial language was found in a protected connection, MCP, or widget surface:",
    );
    for (const finding of [...new Set(findings)].sort()) {
        console.error(`- ${finding}`);
    }
    process.exit(1);
}

console.log(
    `Commerce boundary check passed across ${inspected.size} protected files.`,
);
