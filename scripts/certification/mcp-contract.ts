#!/usr/bin/env bun

import { evaluateMcpToolContract } from "../../src/certification/contract.js";

interface CheckResult {
    name: string;
    ok: boolean;
    status?: number;
    detail?: string;
}

interface JsonRpcEnvelope {
    jsonrpc?: string;
    id?: string | number | null;
    result?: Record<string, unknown>;
    error?: { code?: number; message?: string };
}

function argument(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv
        .find((value) => value.startsWith(prefix))
        ?.slice(prefix.length);
}

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function baseUrl(): URL {
    const value = argument("base-url") ?? process.env.MUNCH_CERT_BASE_URL;
    if (!value) {
        throw new Error(
            "Provide --base-url=https://... or MUNCH_CERT_BASE_URL",
        );
    }
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
        throw new Error("Certification base URL must use HTTPS");
    }
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url;
}

function parseEventStream(text: string): JsonRpcEnvelope[] {
    const envelopes: JsonRpcEnvelope[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
            envelopes.push(JSON.parse(payload) as JsonRpcEnvelope);
        } catch {
            // A malformed event is handled when no usable envelope is found.
        }
    }
    return envelopes;
}

async function responseEnvelope(response: Response): Promise<JsonRpcEnvelope> {
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    let envelopes: JsonRpcEnvelope[];
    if (contentType.includes("text/event-stream")) {
        envelopes = parseEventStream(text);
    } else {
        try {
            const parsed = JSON.parse(text) as JsonRpcEnvelope | JsonRpcEnvelope[];
            envelopes = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            throw new Error(
                `MCP returned non-JSON content (${contentType || "unknown type"})`,
            );
        }
    }
    const envelope = envelopes.find(
        (candidate) => candidate.result !== undefined || candidate.error !== undefined,
    );
    if (!envelope) throw new Error("MCP returned no JSON-RPC result");
    if (envelope.error) {
        throw new Error(
            `MCP error ${envelope.error.code ?? "unknown"}: ${envelope.error.message ?? "unknown error"}`,
        );
    }
    return envelope;
}

async function jsonRpc(input: {
    url: URL;
    accessToken: string;
    id?: number;
    method: string;
    params?: Record<string, unknown>;
}): Promise<JsonRpcEnvelope | null> {
    const body = {
        jsonrpc: "2.0",
        ...(input.id === undefined ? {} : { id: input.id }),
        method: input.method,
        ...(input.params === undefined ? {} : { params: input.params }),
    };
    const response = await fetch(new URL("/mcp", input.url), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${input.accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-03-26",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
        const diagnostic = (await response.text()).slice(0, 500);
        throw new Error(
            `MCP ${input.method} returned ${response.status}: ${diagnostic}`,
        );
    }
    if (input.id === undefined || response.status === 202) return null;
    return responseEnvelope(response);
}

async function publicCheck(
    origin: URL,
    path: string,
    name: string,
    requireReady = false,
): Promise<CheckResult> {
    try {
        const response = await fetch(new URL(path, origin), {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
        });
        const text = await response.text();
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = text;
        }
        const ready =
            !requireReady ||
            (typeof parsed === "object" &&
                parsed !== null &&
                "ready" in parsed &&
                (parsed as { ready?: unknown }).ready === true);
        return {
            name,
            ok: response.ok && ready,
            status: response.status,
            ...(!response.ok || !ready
                ? { detail: text.slice(0, 300) }
                : {}),
        };
    } catch (error) {
        return {
            name,
            ok: false,
            detail: error instanceof Error ? error.message : "request failed",
        };
    }
}

const origin = baseUrl();
const accessToken =
    argument("access-token") ?? process.env.MUNCH_CERT_ACCESS_TOKEN?.trim();
const requireAuthenticated = flag("require-authenticated");
const checks: CheckResult[] = [];

checks.push(
    await publicCheck(origin, "/health/live", "liveness"),
    await publicCheck(origin, "/health/ready", "readiness", true),
    await publicCheck(
        origin,
        "/.well-known/oauth-protected-resource",
        "protected-resource-discovery",
    ),
    await publicCheck(
        origin,
        "/.well-known/oauth-authorization-server",
        "authorization-server-discovery",
    ),
);

let initializeResult: Record<string, unknown> | null = null;
let toolNames: string[] = [];
let toolContract: ReturnType<typeof evaluateMcpToolContract> | null = null;

if (accessToken) {
    try {
        const initialized = await jsonRpc({
            url: origin,
            accessToken,
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: {
                    name: "munch-staging-certification",
                    version: "1.0.0",
                },
            },
        });
        initializeResult = initialized?.result ?? null;
        checks.push({
            name: "mcp-initialize",
            ok: initializeResult !== null,
        });

        await jsonRpc({
            url: origin,
            accessToken,
            method: "notifications/initialized",
        });

        const listed = await jsonRpc({
            url: origin,
            accessToken,
            id: 2,
            method: "tools/list",
            params: {},
        });
        const tools = listed?.result?.tools;
        if (!Array.isArray(tools)) {
            throw new Error("tools/list did not return a tools array");
        }
        toolNames = tools
            .map((tool) =>
                typeof tool === "object" &&
                tool !== null &&
                "name" in tool &&
                typeof (tool as { name?: unknown }).name === "string"
                    ? (tool as { name: string }).name
                    : null,
            )
            .filter((name): name is string => name !== null);
        toolContract = evaluateMcpToolContract(toolNames);
        checks.push({
            name: "mcp-tool-contract",
            ok: toolContract.ok,
            detail: toolContract.ok
                ? `${toolContract.toolCount} tools`
                : `missing=${toolContract.missingRequiredTools.join(",")} duplicates=${toolContract.duplicateTools.join(",")} count=${toolContract.toolCount}`,
        });
    } catch (error) {
        checks.push({
            name: "authenticated-mcp-contract",
            ok: false,
            detail: error instanceof Error ? error.message : "MCP check failed",
        });
    }
} else {
    checks.push({
        name: "authenticated-mcp-contract",
        ok: !requireAuthenticated,
        detail: requireAuthenticated
            ? "MUNCH_CERT_ACCESS_TOKEN or --access-token is required"
            : "skipped: no staging access token supplied",
    });
}

const passed = checks.every((check) => check.ok);
console.log(
    JSON.stringify(
        {
            certification: passed ? "passed" : "failed",
            baseUrl: origin.origin,
            checkedAt: new Date().toISOString(),
            checks,
            initializeResult,
            toolContract,
            toolNames,
        },
        null,
        2,
    ),
);
if (!passed) process.exitCode = 1;
