import { expect, test } from "bun:test";

const ACTIVE_ROOTS = ["src", "scripts", "db", "public"];
const ACTIVE_FILES = [
    ".env.example",
    "Dockerfile",
    "railway.json",
    "package.json",
    "bun.lock",
];
const TEXT_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".sql",
    ".html",
    ".css",
    ".md",
    ".yml",
    ".yaml",
    ".sh",
]);
const FORBIDDEN = new RegExp(`supa${"base"}|SUPA${"BASE"}_`, "i");

function extension(path: string): string {
    const index = path.lastIndexOf(".");
    return index < 0 ? "" : path.slice(index);
}

test("active source and configuration contain no Supabase dependency or fallback", async () => {
    const violations: string[] = [];

    for (const root of ACTIVE_ROOTS) {
        const glob = new Bun.Glob("**/*");
        for await (const relative of glob.scan({
            cwd: root,
            onlyFiles: true,
        })) {
            const path = `${root}/${relative}`;
            if (path.endsWith("no-supabase-runtime.test.ts")) continue;
            if (!TEXT_EXTENSIONS.has(extension(path))) continue;
            const content = await Bun.file(path).text();
            if (FORBIDDEN.test(content)) violations.push(path);
        }
    }

    for (const path of ACTIVE_FILES) {
        const file = Bun.file(path);
        if (!(await file.exists())) continue;
        if (FORBIDDEN.test(await file.text())) violations.push(path);
    }

    expect(
        violations,
        "Railway PostgreSQL is authoritative; remove every Supabase runtime, fallback, variable, migration, and client reference",
    ).toEqual([]);
});
