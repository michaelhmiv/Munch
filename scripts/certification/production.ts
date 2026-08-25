#!/usr/bin/env bun

import {
    summarizeDurations,
    type CertificationCheck,
} from "./report.js";

const input = process.argv[2]?.trim() || process.env.MUNCH_CERT_BASE_URL?.trim();
if (!input) {
    console.error(
        "Usage: bun scripts/certification/production.ts https://host",
    );
    process.exit(2);
}

const baseUrl = new URL(input).origin;
const expectedSha = process.env.MUNCH_CERT_EXPECTED_SHA?.trim() || null;
const bearerToken = process.env.MUNCH_CERT_BEARER_TOKEN?.trim() || null;
const requireAuthenticated =
    process.env.MUNCH_CERT_REQUIRE_AUTH?.trim().toLowerCase() === "true";
const reportPath =
    process.env.MUNCH_CERT_REPORT?.trim() ||
    "/tmp/munch-production-certification.json";
const markdownPath =
    process.env.MUNCH_CERT_MARKDOWN_REPORT?.trim() ||
    "/tmp/munch-production-certification.md";

const startedAt = new Date();
const checks: CertificationCheck[] = [];
let release: Record<string, unknown> | null = null;
let toolNames: string[] = [];

async function record<T>(
    name: string,
    action: () => Promise<T>,
): Promise<T | null> {
    const started = performance.now();
    try {
        const result = await action();
        checks.push({
            name,
            ok: true,
            duration_ms: Number((performance.now() - started).toFixed(2)),
        });
        return result;
    } catch (error) {
        checks.push({
            name,
            ok: false,
            duration_ms: Number((performance.now() - started).toFixed(2)),
            detail: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

async function expectJson(path: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl}${path}`, {
        headers: { accept: "application/json" },
        redirect: "manual",
    });
    if (response.status !== 200) {
        throw new Error(`${path} returned ${response.status}`);
    }
    if (response.headers.get("location")) {
        throw new Error(`${path} unexpectedly redirected`);
    }
    if (response.headers.get("cache-control") !== "no-store") {
        throw new Error(`${path} must use Cache-Control: no-store`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("application/json")) {
        throw new Error(`${path} returned ${contentType || "no content type"}`);
    }
    return (await response.json()) as Record<string, unknown>;
}

function parseJsonRpc(
    text: string,
    contentType: string,
): Record<string, unknown> {
    if (contentType.includes("text/event-stream")) {
        const data = text
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .find(Boolean);
        if (!data)
            throw new Error("MCP SSE response contained no JSON-RPC data");
        return JSON.parse(data) as Record<string, unknown>;
    }
    if (!text.trim())
        throw new Error("MCP response contained no JSON-RPC data");
    return JSON.parse(text) as Record<string, unknown>;
}

function mcpHeaders(): Record<string, string> {
    if (!bearerToken)
        throw new Error("Authenticated token is not configured");
    return {
        authorization: `Bearer ${bearerToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
    };
}

async function mcpRequest(
    body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: mcpHeaders(),
        body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(
            `MCP returned ${response.status}: ${text.slice(0, 300)}`,
        );
    }
    return parseJsonRpc(text, response.headers.get("content-type") ?? "");
}

async function mcpNotification(
    body: Record<string, unknown>,
): Promise<void> {
    const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: mcpHeaders(),
        body: JSON.stringify(body),
    });
    const text = await response.text();
    if (![200, 202, 204].includes(response.status)) {
        throw new Error(
            `MCP notification returned ${response.status}: ${text.slice(0, 300)}`,
        );
    }
    if (text.trim()) {
        const parsed = parseJsonRpc(
            text,
            response.headers.get("content-type") ?? "",
        );
        if (parsed.error) {
            throw new Error(
                `MCP notification returned an error: ${text.slice(0, 300)}`,
            );
        }
    }
}

await record("health.live", async () => {
    const live = await expectJson("/health/live");
    if (live.status !== "ok" || live.service !== "munch") {
        throw new Error("Liveness payload is invalid");
    }
});

await record("health.ready", async () => {
    const ready = await expectJson("/health/ready");
    if (ready.ready !== true) throw new Error("Readiness payload is not ready");
});

release = await record("health.version", async () => {
    const value = await expectJson("/health/version");
    if (value.service !== "munch") throw new Error("Release service is invalid");
    if (expectedSha && value.git_sha !== expectedSha) {
        throw new Error(
            `Production SHA ${String(value.git_sha)} does not match expected ${expectedSha}`,
        );
    }
    return value;
});

if (bearerToken) {
    await record("mcp.initialize", async () => {
        const body = await mcpRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: {
                    name: "Munch production certification",
                    version: "1.0.0",
                },
            },
        });
        const serverName = (
            body.result as { serverInfo?: { name?: unknown } } | undefined
        )?.serverInfo?.name;
        if (serverName !== "Munch") {
            throw new Error(`Unexpected MCP server ${String(serverName)}`);
        }
    });

    await record("mcp.initialized", async () => {
        await mcpNotification({
            jsonrpc: "2.0",
            method: "notifications/initialized",
        });
    });

    await record("mcp.tools_list", async () => {
        const body = await mcpRequest({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
        });
        const tools = (body.result as { tools?: unknown[] } | undefined)?.tools;
        if (!Array.isArray(tools) || tools.length === 0) {
            throw new Error("MCP returned no tools");
        }
        const names = tools.map((candidate) => {
            const name = (candidate as { name?: unknown }).name;
            if (typeof name !== "string" || !name) {
                throw new Error("MCP exposed a tool without a name");
            }
            return name;
        });
        if (new Set(names).size !== names.length) {
            throw new Error("MCP exposed duplicate tool names");
        }
        for (const required of [
            "search_foods",
            "get_meals_today",
            "get_nutrition_summary",
            "get_grocery_list",
            "search_recipes",
            "parse_recipe_url",
            "find_munch_actions",
            "run_munch_action",
        ]) {
            if (!names.includes(required)) {
                throw new Error(`MCP tool discovery omitted ${required}`);
            }
        }
        toolNames = names.sort();
    });
} else if (requireAuthenticated) {
    checks.push({
        name: "mcp.authenticated",
        ok: false,
        duration_ms: 0,
        detail: "MUNCH_CERT_BEARER_TOKEN is required for authenticated certification",
    });
} else {
    checks.push({
        name: "mcp.authenticated",
        ok: true,
        skipped: true,
        duration_ms: 0,
        detail: "No bearer token configured; authenticated MCP phase skipped",
    });
}

const completedAt = new Date();
const failed = checks.filter((check) => !check.ok);
const report = {
    ok: failed.length === 0,
    base_url: baseUrl,
    expected_git_sha: expectedSha,
    release,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - startedAt.getTime(),
    authenticated_mcp: Boolean(bearerToken),
    tool_count: toolNames.length,
    tool_names: toolNames,
    latency: summarizeDurations(checks),
    checks,
};

await Bun.write(reportPath, JSON.stringify(report, null, 2));
await Bun.write(
    markdownPath,
    [
        "# Munch production certification",
        "",
        `- Result: ${report.ok ? "PASS" : "FAIL"}`,
        `- Base URL: ${baseUrl}`,
        `- Expected SHA: ${expectedSha ?? "not specified"}`,
        `- Production SHA: ${String(release?.git_sha ?? "unknown")}`,
        `- Railway deployment: ${String(release?.deployment_id ?? "unknown")}`,
        `- Authenticated MCP: ${report.authenticated_mcp ? "yes" : "no"}`,
        `- MCP tools: ${report.tool_count}`,
        `- Check p95: ${report.latency.p95_ms} ms`,
        "",
        "## Checks",
        "",
        ...checks.map(
            (check) =>
                `- ${check.ok ? "PASS" : "FAIL"}${check.skipped ? " (skipped)" : ""} ${check.name} — ${check.duration_ms} ms${check.detail ? ` — ${check.detail}` : ""}`,
        ),
        "",
    ].join("\n"),
);

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
