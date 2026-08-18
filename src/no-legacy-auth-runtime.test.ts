import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOTS = [
    "src",
    "scripts",
    "public",
    ".github/workflows",
    "db/schema",
    "docs/deployment",
];
const SINGLE_FILES = [
    ".env.example",
    "docs/architecture/README.md",
    "docs/architecture/better-auth.md",
    "docs/architecture/0009-canonical-better-auth-postgresql-baseline.md",
];
const SELF = "src/no-legacy-auth-runtime.test.ts";
const INTENTIONAL_LEGACY_FIXTURE = "scripts/rebaseline-preservation-smoke.ts";

const FORBIDDEN = [
    ["oauth", "platform"].join("-"),
    ["MUNCH", "AUTH", "BACKEND"].join("_"),
    ["MUNCH", "RAILWAY", "AUTH", "ENABLED"].join("_"),
    ["MUNCH", "RAILWAY", "DATA", "ENABLED"].join("_"),
    ["MUNCH", "SESSION", "SECRET"].join("_"),
    ["MUNCH", "LOGIN", "DELIVERY"].join("_"),
    ["munch", "oauth_clients"].join("."),
    ["munch", "oauth_authorization_sessions"].join("."),
    ["munch", "oauth_authorization_codes"].join("."),
    ["munch", "oauth_access_tokens"].join("."),
    ["munch", "oauth_refresh_tokens"].join("."),
    ["munch", "login_tokens"].join("."),
    ["munch", "web_sessions"].join("."),
];

async function filesUnder(relative: string): Promise<string[]> {
    const absolute = path.resolve(relative);
    const info = await stat(absolute).catch(() => null);
    if (!info) return [];
    if (info.isFile()) return [relative];

    const output: string[] = [];
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) output.push(...(await filesUnder(child)));
        else if (entry.isFile()) output.push(child);
    }
    return output;
}

describe("canonical Better Auth runtime", () => {
    test("contains no retired auth/data-plane implementation references", async () => {
        const files = [
            ...(await Promise.all(ROOTS.map(filesUnder))).flat(),
            ...SINGLE_FILES,
        ].filter(
            (file) =>
                file !== SELF && file !== INTENTIONAL_LEGACY_FIXTURE,
        );
        const violations: string[] = [];
        for (const file of files) {
            const content = await readFile(file, "utf8").catch(() => "");
            for (const forbidden of FORBIDDEN) {
                if (content.includes(forbidden))
                    violations.push(`${file}: ${forbidden}`);
            }
        }
        expect(violations).toEqual([]);
    });
});
