from pathlib import Path
import json
import re
import shutil

# Move callers from the vendor-named compatibility module to neutral storage.
for base in (Path("src"), Path("scripts")):
    if not base.exists():
        continue
    for path in base.rglob("*.ts"):
        text = path.read_text()
        text = text.replace("../src/supabase.js", "../src/storage.js")
        text = text.replace("../supabase.js", "../storage.js")
        text = text.replace("./supabase.js", "./storage.js")
        text = text.replace("actualSupabase", "actualStorage")
        path.write_text(text)

Path("src/storage.ts").write_text(
    '''import * as railwayService from "./service-platform/repository.js";
import { resolveAccessToken } from "./oauth-platform/repository.js";

// Railway PostgreSQL is the only persistence backend.
export * from "./nutrition-platform/index.js";

export async function getCachedFood<T>(
    source: string,
    sourceId: string,
): Promise<T | null> {
    return (await railwayService.getCachedFood(source, sourceId)) as T | null;
}

export const cacheFood = railwayService.cacheFood;
export const insertToolAnalytics = railwayService.insertToolAnalytics;
export const getLandingStats = railwayService.getLandingStats;

export async function getUserIdByToken(token: string): Promise<
    | { status: "valid"; userId: string }
    | { status: "invalid" }
    | { status: "unavailable" }
> {
    try {
        const lookup = await resolveAccessToken(token);
        return lookup.status === "valid"
            ? { status: "valid", userId: lookup.userId }
            : { status: "invalid" };
    } catch {
        return { status: "unavailable" };
    }
}

export type {
    CountryStat,
    ExportFile,
    LandingStats,
} from "./service-platform/repository.js";
'''
)

analytics = Path("src/analytics.ts")
text = analytics.read_text()
text = text.replace(
    'import { getSupabase } from "./storage.js";',
    'import { insertToolAnalytics } from "./storage.js";',
)
text = re.sub(
    r"function persistAnalytics\(record: AnalyticsRecord\): void \{.*?\n\}",
    '''function persistAnalytics(record: AnalyticsRecord): void {
    void insertToolAnalytics(record).catch((error) => {
        console.warn(
            `Failed to persist analytics for ${record.tool_name}:`,
            error instanceof Error ? error.message : String(error),
        );
    });
}''',
    text,
    flags=re.S,
)
text = text.replace('return "supabase_error";', 'return "database_error";')
text = text.replace('msg.includes("supabase") ||\n        ', "")
analytics.write_text(text)

foods = Path("src/foods.ts")
text = foods.read_text()
text = text.replace(
    'import { getSupabase } from "./storage.js";',
    'import { cacheFood, getCachedFood as readCachedFood } from "./storage.js";',
)
start = text.index("async function getCachedFood(\n")
end = text.index("// Cache-first barcode lookup.", start)
replacement = '''async function getCachedFood(
    source: string,
    sourceId: string,
    _ttlMs: number,
): Promise<FoodResult | null> {
    try {
        const payload = await readCachedFood<FoodResult>(source, sourceId);
        if (!payload) return null;
        return {
            ...payload,
            fiber_g: payload.fiber_g ?? null,
            sugar_g: payload.sugar_g ?? null,
            alcohol_g: payload.alcohol_g ?? null,
        };
    } catch {
        return null;
    }
}

async function putCachedFood(
    source: string,
    sourceId: string,
    payload: FoodResult,
): Promise<void> {
    try {
        await cacheFood(source, sourceId, payload);
    } catch {
        // Best-effort cache writes never block a food lookup.
    }
}

'''
foods.write_text(text[:start] + replacement + text[end:])

Path("src/export.ts").write_text(
    '''import {
    getAllMeals,
    getUserTimezone,
    type Meal,
} from "./storage.js";
import {
    cleanupExpiredExports,
    consumeExportFile,
    createExportFile,
    type ExportFile,
} from "./service-platform/repository.js";
import { formatLocalDateTime } from "./tz.js";

const EXPORT_TTL_SECONDS = 60 * 60;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const CSV_COLUMNS = [
    "id",
    "logged_at",
    "timezone",
    "meal_type",
    "description",
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "alcohol_g",
    "notes",
] as const;

function csvEscape(value: string | number | null | undefined): string {
    if (value == null) return "";
    const str = String(value);
    return /[",\\r\\n]/.test(str)
        ? `"${str.replace(/"/g, '""')}"`
        : str;
}

export function buildMealsCsv(meals: Meal[], tz: string): string {
    const rows = [CSV_COLUMNS.join(",")];
    for (const meal of meals) {
        rows.push(
            [
                meal.id,
                formatLocalDateTime(meal.logged_at, tz),
                tz,
                meal.meal_type,
                meal.description,
                meal.calories,
                meal.protein_g,
                meal.carbs_g,
                meal.fat_g,
                meal.fiber_g,
                meal.sugar_g,
                meal.alcohol_g,
                meal.notes,
            ]
                .map(csvEscape)
                .join(","),
        );
    }
    return rows.join("\\n");
}

export interface MealsExportResult {
    count: number;
    url?: string;
}

function appBaseUrl(): string {
    const value = process.env.MUNCH_APP_BASE_URL?.trim();
    if (!value) throw new Error("MUNCH_APP_BASE_URL is required for exports");
    const url = new URL(value);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
        throw new Error("MUNCH_APP_BASE_URL must use HTTPS in production");
    }
    return url.origin;
}

export async function exportMeals(userId: string): Promise<MealsExportResult> {
    const meals = await getAllMeals(userId);
    if (meals.length === 0) return { count: 0 };
    const tz = await getUserTimezone(userId);
    const created = await createExportFile({
        userId,
        fileName: `munch-meals-${new Date().toISOString().slice(0, 10)}.csv`,
        content: buildMealsCsv(meals, tz),
        expiresAt: new Date(Date.now() + EXPORT_TTL_SECONDS * 1_000),
    });
    const url = new URL("/exports/download", appBaseUrl());
    url.searchParams.set("token", created.token);
    return { count: meals.length, url: url.toString() };
}

export async function getRailwayExportFile(
    token: string,
): Promise<ExportFile | null> {
    if (token.length < 20 || token.length > 500) return null;
    return consumeExportFile(token);
}

export async function sweepStaleExports(): Promise<void> {
    const removed = await cleanupExpiredExports();
    if (removed > 0) {
        console.log(`Export sweep: removed ${removed} expired export(s).`);
    }
}

let sweepRunning = false;
export function startExportCleanup(): void {
    setInterval(() => {
        if (sweepRunning) return;
        sweepRunning = true;
        sweepStaleExports().finally(() => {
            sweepRunning = false;
        });
    }, SWEEP_INTERVAL_MS);
}
'''
)

config = Path("src/operations/config.ts")
text = config.read_text()
start = text.index("export function configurationIssues()")
end = text.index("\nexport function validateStartupConfiguration()", start)
new_fn = '''export function configurationIssues(): ConfigurationIssue[] {
    const issues: ConfigurationIssue[] = [];
    const production = process.env.NODE_ENV === "production";
    const railwayAuth = present("MUNCH_RAILWAY_AUTH_ENABLED") === "true";
    const authBackend = present("MUNCH_AUTH_BACKEND") || "custom";
    if (authBackend !== "custom" && authBackend !== "better_auth") {
        issues.push({
            key: "MUNCH_AUTH_BACKEND",
            message: "Authentication backend must be custom or better_auth",
        });
    }
    if (authBackend === "custom" && !railwayAuth) {
        issues.push({
            key: "MUNCH_RAILWAY_AUTH_ENABLED",
            message: "Custom authentication requires Railway OAuth",
        });
    }

    const baseUrl = present("MUNCH_APP_BASE_URL");
    requireValue(issues, "MUNCH_APP_BASE_URL");
    if (baseUrl) {
        try {
            const parsed = new URL(baseUrl);
            if (production && parsed.protocol !== "https:") {
                issues.push({
                    key: "MUNCH_APP_BASE_URL",
                    message: "Production application URL must use HTTPS",
                });
            }
            if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
                issues.push({
                    key: "MUNCH_APP_BASE_URL",
                    message:
                        "Application URL must be an origin without path, query, or fragment",
                });
            }
        } catch {
            issues.push({
                key: "MUNCH_APP_BASE_URL",
                message: "Application URL is invalid",
            });
        }
    }

    if (authBackend === "better_auth") {
        requireValue(issues, "BETTER_AUTH_SECRET");
        const secret = present("BETTER_AUTH_SECRET");
        if (secret && secret.length < 32) {
            issues.push({
                key: "BETTER_AUTH_SECRET",
                message: "Better Auth secret must contain at least 32 characters",
            });
        }
        requireValue(issues, "RESEND_API_KEY");
        requireValue(issues, "MUNCH_EMAIL_FROM");
    } else {
        const sessionSecret = present("MUNCH_SESSION_SECRET");
        if (sessionSecret.length < 32) {
            issues.push({
                key: "MUNCH_SESSION_SECRET",
                message: "Session secret must contain at least 32 characters",
            });
        }
        if (production) {
            requireValue(issues, "MUNCH_LOGIN_DELIVERY_ENDPOINT");
            requireValue(issues, "MUNCH_LOGIN_DELIVERY_SECRET");
            validateHttpsUrl(
                issues,
                "MUNCH_LOGIN_DELIVERY_ENDPOINT",
                "Production login delivery endpoint must use HTTPS",
            );
        }
    }

    if (production && present("MUNCH_DEV_EXPOSE_LOGIN_LINK") === "true") {
        issues.push({
            key: "MUNCH_DEV_EXPOSE_LOGIN_LINK",
            message: "Development login-link exposure cannot be enabled in production",
        });
    }

    requireValue(issues, "DATABASE_URL");
    requireValue(issues, "STRIPE_SECRET_KEY");
    requireValue(issues, "STRIPE_WEBHOOK_SECRET");
    requireValue(issues, "STRIPE_PRICE_ID");
    requireValue(issues, "OFF_USER_AGENT");
    requireValue(
        issues,
        "USDA_FDC_API_KEY",
        "USDA_FDC_API_KEY is required because the USDA provider is enabled",
    );
    const pool = Number(present("MUNCH_DB_POOL_SIZE") || 10);
    if (!Number.isInteger(pool) || pool < 1 || pool > 50) {
        issues.push({
            key: "MUNCH_DB_POOL_SIZE",
            message: "Database pool size must be an integer from 1 to 50",
        });
    }
    return issues;
}
'''
config.write_text(text[:start] + new_fn + text[end:])

Path("src/operations/config.test.ts").write_text(
    '''import { afterEach, describe, expect, test } from "bun:test";
import { configurationIssues } from "./config.js";

const original = { ...process.env };
afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
});

function validRailwayEnvironment() {
    Object.assign(process.env, {
        NODE_ENV: "production",
        MUNCH_RAILWAY_AUTH_ENABLED: "true",
        MUNCH_AUTH_BACKEND: "custom",
        MUNCH_APP_BASE_URL: "https://munch.example",
        MUNCH_SESSION_SECRET: "x".repeat(64),
        MUNCH_DEV_EXPOSE_LOGIN_LINK: "false",
        MUNCH_LOGIN_DELIVERY_ENDPOINT: "https://mail.example/deliver",
        MUNCH_LOGIN_DELIVERY_SECRET: "delivery-secret",
        STRIPE_SECRET_KEY: "sk_test_example",
        STRIPE_WEBHOOK_SECRET: "whsec_example",
        STRIPE_PRICE_ID: "price_example",
        OFF_USER_AGENT: "Munch (support@example.com)",
        USDA_FDC_API_KEY: "usda-example",
        DATABASE_URL: "postgresql://example",
        MUNCH_DB_POOL_SIZE: "10",
    });
}

function validBetterAuthEnvironment() {
    validRailwayEnvironment();
    Object.assign(process.env, {
        MUNCH_AUTH_BACKEND: "better_auth",
        BETTER_AUTH_SECRET: "b".repeat(64),
        RESEND_API_KEY: "re_test_key",
        MUNCH_EMAIL_FROM: "Munch <support@munch.example>",
    });
}

describe("Munch startup configuration", () => {
    test("accepts Railway PostgreSQL with custom auth", () => {
        validRailwayEnvironment();
        expect(configurationIssues()).toEqual([]);
    });
    test("accepts Railway PostgreSQL with Better Auth", () => {
        validBetterAuthEnvironment();
        expect(configurationIssues()).toEqual([]);
    });
    test("requires Railway OAuth for custom auth", () => {
        validRailwayEnvironment();
        process.env.MUNCH_RAILWAY_AUTH_ENABLED = "false";
        expect(configurationIssues()).toContainEqual(
            expect.objectContaining({ key: "MUNCH_RAILWAY_AUTH_ENABLED" }),
        );
    });
    test("always requires Railway PostgreSQL", () => {
        validBetterAuthEnvironment();
        delete process.env.DATABASE_URL;
        expect(configurationIssues()).toContainEqual(
            expect.objectContaining({ key: "DATABASE_URL" }),
        );
    });
    test("rejects insecure production settings", () => {
        validRailwayEnvironment();
        process.env.MUNCH_APP_BASE_URL = "http://munch.example/path";
        process.env.MUNCH_LOGIN_DELIVERY_ENDPOINT = "http://mail.example";
        process.env.MUNCH_DEV_EXPOSE_LOGIN_LINK = "true";
        const keys = configurationIssues().map((issue) => issue.key);
        expect(keys).toContain("MUNCH_APP_BASE_URL");
        expect(keys).toContain("MUNCH_LOGIN_DELIVERY_ENDPOINT");
        expect(keys).toContain("MUNCH_DEV_EXPOSE_LOGIN_LINK");
    });
    test("requires provider and billing configuration", () => {
        validRailwayEnvironment();
        delete process.env.USDA_FDC_API_KEY;
        delete process.env.STRIPE_WEBHOOK_SECRET;
        const keys = configurationIssues().map((issue) => issue.key);
        expect(keys).toContain("USDA_FDC_API_KEY");
        expect(keys).toContain("STRIPE_WEBHOOK_SECRET");
    });
    test("requires Resend and a Better Auth sender", () => {
        validBetterAuthEnvironment();
        delete process.env.RESEND_API_KEY;
        delete process.env.MUNCH_EMAIL_FROM;
        const keys = configurationIssues().map((issue) => issue.key);
        expect(keys).toContain("RESEND_API_KEY");
        expect(keys).toContain("MUNCH_EMAIL_FROM");
    });
});
'''
)

Path("src/auth/mcp-auth-mode.ts").write_text(
    '''export type McpAuthMode = "better-auth" | "railway";

export function resolveMcpAuthMode(
    betterAuthEnabled: boolean,
    railwayAuthEnabled: boolean,
): McpAuthMode {
    if (betterAuthEnabled) return "better-auth";
    if (railwayAuthEnabled) return "railway";
    throw new Error("Munch requires Better Auth or Railway OAuth");
}
'''
)
Path("src/auth/mcp-auth-mode.test.ts").write_text(
    '''import { describe, expect, test } from "bun:test";
import { resolveMcpAuthMode } from "./mcp-auth-mode.js";

describe("MCP authentication mode selection", () => {
    test("prioritizes Better Auth", () => {
        expect(resolveMcpAuthMode(true, true)).toBe("better-auth");
    });
    test("uses Railway OAuth when Better Auth is disabled", () => {
        expect(resolveMcpAuthMode(false, true)).toBe("railway");
    });
    test("rejects no supported auth backend", () => {
        expect(() => resolveMcpAuthMode(false, false)).toThrow();
    });
});
'''
)

index = Path("src/index.ts")
text = index.read_text()
text = text.replace('import { createOAuthRouter } from "./oauth.js";\n', "")
text = text.replace(
    '} else if (!betterAuthEnabled) {\n    app.route("/", createOAuthRouter());\n',
    "}",
)
index.write_text(text)

mcp_test = Path("src/mcp.test.ts")
if mcp_test.exists():
    text = mcp_test.read_text()
    text = re.sub(
        r"\s*// analytics\.ts persists every tool call.*?getSupabase: \(\) => \(\{\n        from: \(\) => \(\{ insert: async \(\) => \(\{ error: null \}\) \}\),\n    \}\),",
        "\n    insertToolAnalytics: async () => undefined,",
        text,
        flags=re.S,
    )
    mcp_test.write_text(text)

old_test = Path("src/supabase.test.ts")
if old_test.exists():
    Path("src/storage.test.ts").write_text(
        old_test.read_text().replace("Supabase", "Railway PostgreSQL")
    )
    old_test.unlink()

for path in [
    Path("src/inherited-supabase.ts"),
    Path("src/supabase.ts"),
    Path("src/oauth.ts"),
    Path("src/oauth.test.ts"),
]:
    if path.exists():
        path.unlink()
shutil.rmtree("supabase", ignore_errors=True)

config_path = Path("tsconfig.typecheck.core.json")
data = json.loads(config_path.read_text())
data["files"] = [
    item
    for item in data.get("files", [])
    if item not in {"src/inherited-supabase.ts", "src/oauth.ts"}
]
if "src/storage.ts" not in data["files"]:
    data["files"].append("src/storage.ts")
config_path.write_text(json.dumps(data, indent=4) + "\n")

package = Path("package.json")
data = json.loads(package.read_text())
data.get("dependencies", {}).pop("@supabase/supabase-js", None)
data.get("scripts", {}).pop("generate-oauth-creds", None)
package.write_text(json.dumps(data, indent=4) + "\n")

env_file = Path(".env.example")
if env_file.exists():
    lines = [
        line
        for line in env_file.read_text().splitlines()
        if "SUPABASE_" not in line
        and not line.startswith("MUNCH_RAILWAY_DATA_ENABLED=")
        and not line.startswith("OAUTH_CLIENT_ID=")
        and not line.startswith("OAUTH_CLIENT_SECRET=")
    ]
    env_file.write_text("\n".join(lines) + "\n")

readme = Path("README.md")
if readme.exists():
    text = re.sub(
        r"Until the Railway/PostgreSQL migration is complete,.*?tested pull requests\.\n?",
        "Munch uses Railway PostgreSQL as its sole persistence layer.\n",
        readme.read_text(),
        flags=re.S,
    )
    readme.write_text(text)

for path in Path("src").rglob("*.ts"):
    text = path.read_text()
    text = text.replace("supabase_error", "database_error")
    text = text.replace("Supabase", "Railway PostgreSQL")
    path.write_text(text)

for path in [
    Path(".github/workflows/supabase-runtime-audit.yml"),
    Path(".github/workflows/railway-only-cutover.yml"),
    Path(".github/workflows/repair-cutover.yml"),
    Path(".cutover-trigger"),
    Path("scripts/railway-only-cutover.py"),
]:
    if path.exists():
        path.unlink()
