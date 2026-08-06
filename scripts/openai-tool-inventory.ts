export interface ToolInventoryEntry {
    name: string;
    sourcePath: string;
    title: string | null;
    description: string | null;
    hasInputSchema: boolean;
    hasOutputSchema: boolean;
    readOnlyHint: boolean | null;
    openWorldHint: boolean | null;
    destructiveHint: boolean | null;
    idempotentHint: boolean | null;
    inputExcerpt: string;
}

function matchingDelimiter(
    source: string,
    start: number,
    open = "{",
    close = "}",
): number {
    let depth = 0;
    let quote: string | null = null;
    let lineComment = false;
    let blockComment = false;

    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];

        if (lineComment) {
            if (char === "\n") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === "*" && next === "/") {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (char === "\\") {
                index += 1;
                continue;
            }
            if (char === quote) quote = null;
            continue;
        }
        if (char === "/" && next === "/") {
            lineComment = true;
            index += 1;
            continue;
        }
        if (char === "/" && next === "*") {
            blockComment = true;
            index += 1;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === open) depth += 1;
        if (char === close) {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
}

function literalProperty(source: string, property: string): string | null {
    const pattern = new RegExp(
        `${property}\\s*:\\s*(["'])([\\s\\S]*?)\\1`,
    );
    return pattern.exec(source)?.[2]?.replace(/\\n/g, " ").trim() ?? null;
}

function declaredTextProperty(source: string, property: string): string | null {
    const literal = literalProperty(source, property);
    if (literal) return literal;
    return new RegExp(`\\b${property}\\s*:`).test(source)
        ? "[declared expression]"
        : null;
}

function booleanProperty(source: string, property: string): boolean | null {
    const match = new RegExp(`${property}\\s*:\\s*(true|false)`).exec(source);
    return match ? match[1] === "true" : null;
}

function propertyBlock(source: string, property: string): string {
    const match = new RegExp(`${property}\\s*:`).exec(source);
    if (!match) return "";
    const valueStart = match.index + match[0].length;
    const objectStart = source.indexOf("{", valueStart);
    if (objectStart < 0) return source.slice(valueStart, valueStart + 1_500);
    const objectEnd = matchingDelimiter(source, objectStart);
    return objectEnd < 0
        ? source.slice(objectStart, objectStart + 1_500)
        : source.slice(objectStart, objectEnd + 1);
}

function inventoryFromSource(
    source: string,
    sourcePath: string,
): ToolInventoryEntry[] {
    const entries: ToolInventoryEntry[] = [];
    const callPattern = /\b[a-zA-Z_$][\w$]*\.registerTool\s*\(/g;

    for (const call of source.matchAll(callPattern)) {
        const callStart = (call.index ?? 0) + call[0].length;
        const remaining = source.slice(callStart);
        const nameMatch = /^\s*(["'])([a-zA-Z0-9_-]+)\1\s*,/.exec(remaining);
        if (!nameMatch) continue;

        const name = nameMatch[2];
        const configStart = source.indexOf("{", callStart + nameMatch[0].length);
        if (configStart < 0) continue;
        const configEnd = matchingDelimiter(source, configStart);
        if (configEnd < 0) {
            throw new Error(`${sourcePath}:${name} has an unclosed tool config`);
        }
        const config = source.slice(configStart, configEnd + 1);
        const annotations = propertyBlock(config, "annotations");
        const inputExcerpt = propertyBlock(config, "inputSchema");

        entries.push({
            name,
            sourcePath,
            title: declaredTextProperty(config, "title"),
            description: declaredTextProperty(config, "description"),
            hasInputSchema: /\binputSchema\s*:/.test(config),
            hasOutputSchema: /\boutputSchema\s*:/.test(config),
            readOnlyHint: booleanProperty(annotations, "readOnlyHint"),
            openWorldHint: booleanProperty(annotations, "openWorldHint"),
            destructiveHint: booleanProperty(annotations, "destructiveHint"),
            idempotentHint: booleanProperty(annotations, "idempotentHint"),
            inputExcerpt,
        });
    }

    return entries;
}

export async function collectToolInventory(): Promise<ToolInventoryEntry[]> {
    const entries: ToolInventoryEntry[] = [];
    const glob = new Bun.Glob("src/**/*.ts");

    for await (const sourcePath of glob.scan({ cwd: "." })) {
        if (
            sourcePath.endsWith(".test.ts") ||
            sourcePath.includes("/__tests__/")
        ) {
            continue;
        }
        entries.push(
            ...inventoryFromSource(
                await Bun.file(sourcePath).text(),
                sourcePath,
            ),
        );
    }

    const names = new Set<string>();
    for (const entry of entries) {
        if (names.has(entry.name)) {
            throw new Error(`Duplicate exposed tool name: ${entry.name}`);
        }
        names.add(entry.name);
    }

    return entries.sort((left, right) => left.name.localeCompare(right.name));
}

if (import.meta.main) {
    console.log(JSON.stringify(await collectToolInventory(), null, 2));
}
