// Assembles the self-contained widget HTML from shared source partials at
// server startup, so the shared design tokens, components, and MCP Apps host
// bridge live in exactly one place instead of being copy-pasted into files.

const SRC_DIR = "./public/widgets/src";
const INCLUDE_RE = /\/\*@include\s+([^\s@]+)\s*@\*\//g;
const INLINE_TS_RE = /\/\*@inlinets\s+([^\s@]+)\s*@\*\//g;

async function inlineTs(relPath: string): Promise<string> {
    const file = Bun.file(`./${relPath}`);
    if (!(await file.exists())) {
        throw new Error(`@inlinets source not found: ${relPath}`);
    }
    const ts = await file.text();
    if (/^\s*import\s/m.test(ts)) {
        throw new Error(
            `@inlinets ${relPath} has runtime imports; only self-contained modules can be inlined`,
        );
    }
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(ts);
    return js
        .replace(/^export\s+default\s+/gm, "")
        .replace(/^export\s+/gm, "")
        .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, "");
}

export const WIDGET_TEMPLATES: Record<string, string> = {
    "nutrition-summary": "nutrition-summary.html",
    "goal-progress": "goal-progress.html",
    "meal-logged": "meal-logged.html",
    "meal-review": "meal-review.html",
    trends: "trends.html",
    "weight-trends": "weight-trends.html",
    "import-meals": "import-meals.html",
    "component-gallery": "component-gallery.html",
};

const cache = new Map<string, string>();

async function readSrc(relPath: string): Promise<string> {
    const file = Bun.file(`${SRC_DIR}/${relPath}`);
    if (!(await file.exists())) {
        throw new Error(`widget source partial not found: ${relPath}`);
    }
    return file.text();
}

async function resolveIncludes(
    text: string,
    fromPath: string,
    stack: string[],
): Promise<string> {
    const matches = [...text.matchAll(INCLUDE_RE)];
    if (matches.length === 0) return text;
    const resolved = new Map<string, string>();
    for (const m of matches) {
        const rel = m[1];
        if (!rel || resolved.has(rel)) continue;
        if (stack.includes(rel)) {
            throw new Error(`@include cycle: ${[...stack, rel].join(" -> ")}`);
        }
        const raw = await readSrc(rel);
        resolved.set(rel, await resolveIncludes(raw, rel, [...stack, rel]));
    }
    return text.replace(INCLUDE_RE, (_full, rel) => resolved.get(rel) ?? "");
}

async function assemble(templateFile: string): Promise<string> {
    const template = await readSrc(`templates/${templateFile}`);
    const withPartials = await resolveIncludes(template, templateFile, [
        `templates/${templateFile}`,
    ]);
    const tsMatches = [...withPartials.matchAll(INLINE_TS_RE)];
    if (tsMatches.length === 0) return withPartials;
    const compiled = new Map<string, string>();
    for (const m of tsMatches) {
        const rel = m[1];
        if (!rel || compiled.has(rel)) continue;
        compiled.set(rel, await inlineTs(rel));
    }
    return withPartials.replace(
        INLINE_TS_RE,
        (_full, rel) => compiled.get(rel) ?? "",
    );
}

export async function getWidgetHtml(key: string): Promise<string> {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const templateFile = WIDGET_TEMPLATES[key];
    if (!templateFile) throw new Error(`unknown widget: ${key}`);
    const html = await assemble(templateFile);
    cache.set(key, html);
    return html;
}

export async function warmWidgets(): Promise<void> {
    await Promise.all(
        Object.keys(WIDGET_TEMPLATES).map((key) => getWidgetHtml(key)),
    );
}
