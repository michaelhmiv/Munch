#!/usr/bin/env bun

import { asFoodProviderError } from "../src/food-providers/errors.js";
import { OpenFoodFactsProvider } from "../src/food-providers/open-food-facts.js";
import { UsdaFoodDataCentralProvider } from "../src/food-providers/usda.js";

const iterations = Math.max(
    1,
    Math.min(5, Number(process.env.MUNCH_PROVIDER_LIVE_ITERATIONS ?? 3)),
);
const maxLatencyMs = Math.max(
    1_000,
    Number(process.env.MUNCH_PROVIDER_LIVE_MAX_MS ?? 6_000),
);

function percentile(values: number[], fraction: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 0) return 0;
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * fraction) - 1),
    );
    return Number(sorted[index]!.toFixed(2));
}

async function timed<T>(callback: () => Promise<T>): Promise<[T, number]> {
    const startedAt = performance.now();
    const value = await callback();
    return [value, performance.now() - startedAt];
}

async function retry<T>(label: string, callback: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            return await callback();
        } catch (error) {
            lastError = error;
            if (attempt < 3) {
                console.warn(
                    `[food_provider_live] ${label} attempt=${attempt} failed; retrying`,
                );
                await Bun.sleep(attempt * 750);
            }
        }
    }
    throw lastError;
}

type ProbeResult<T> =
    | { status: "ok"; value: T; durationMs: number }
    | { status: "degraded"; code: string; message: string };

const degraded: Record<string, number> = {};

async function probe<T>(
    label: string,
    provider: string,
    callback: () => Promise<T>,
): Promise<ProbeResult<T>> {
    try {
        const [value, durationMs] = await timed(() => retry(label, callback));
        return { status: "ok", value, durationMs };
    } catch (error) {
        const normalized = asFoodProviderError(error, provider);
        if (
            normalized.code === "rate_limited" ||
            normalized.code === "provider_unavailable"
        ) {
            degraded[label] = (degraded[label] ?? 0) + 1;
            console.warn(
                `[food_provider_live] ${label} degraded code=${normalized.code} provider=${normalized.provider ?? provider} message=${JSON.stringify(normalized.message)}`,
            );
            return {
                status: "degraded",
                code: normalized.code,
                message: normalized.message,
            };
        }
        throw normalized;
    }
}

function metric(values: number[]) {
    return {
        samples: values.length,
        p50_ms: values.length === 0 ? null : percentile(values, 0.5),
        p95_ms: values.length === 0 ? null : percentile(values, 0.95),
    };
}

const usda = new UsdaFoodDataCentralProvider({
    apiKey: process.env.USDA_FDC_API_KEY?.trim() || "DEMO_KEY",
    timeoutMs: maxLatencyMs,
});
const off = new OpenFoodFactsProvider({
    userAgent:
        process.env.OFF_USER_AGENT?.trim() ||
        "Munch-CI/1.0 (https://munch.business; support@munch.business)",
    timeoutMs: maxLatencyMs,
});

const usdaSearchMs: number[] = [];
const usdaDetailsMs: number[] = [];
const offBarcodeMs: number[] = [];
const offSearchMs: number[] = [];

for (let index = 0; index < iterations; index += 1) {
    const usdaSearch = await probe("usda_search", "usda", () =>
        usda.search({ query: "banana", limit: 5 }),
    );
    if (usdaSearch.status === "ok") {
        const topUsda = usdaSearch.value[0];
        if (!topUsda || !topUsda.nutrientsPer100g?.calories) {
            throw new Error(
                "USDA live search returned no usable banana candidate",
            );
        }
        usdaSearchMs.push(usdaSearch.durationMs);

        const usdaDetails = await probe("usda_details", "usda", () =>
            usda.getDetails({ providerFoodId: topUsda.providerFoodId }),
        );
        if (usdaDetails.status === "ok") {
            if (!usdaDetails.value?.nutrientsPer100g?.calories) {
                throw new Error(
                    "USDA live details returned no usable nutrition",
                );
            }
            usdaDetailsMs.push(usdaDetails.durationMs);
        }
    }

    const offBarcode = await probe("off_barcode", "open_food_facts", () =>
        off.lookupBarcode({ barcode: "3017620422003" }),
    );
    if (offBarcode.status === "ok") {
        if (!offBarcode.value?.nutrientsPer100g?.calories) {
            throw new Error(
                "Open Food Facts live barcode lookup returned no usable Nutella nutrition",
            );
        }
        offBarcodeMs.push(offBarcode.durationMs);
    }

    const offSearch = await probe("off_search", "open_food_facts", () =>
        off.search({ query: "peanut butter", limit: 5 }),
    );
    if (offSearch.status === "ok") {
        if (offSearch.value.length === 0) {
            throw new Error(
                "Open Food Facts live search returned no candidates",
            );
        }
        offSearchMs.push(offSearch.durationMs);
    }
}

const report = {
    iterations,
    max_latency_gate_ms: maxLatencyMs,
    degraded,
    usda_search: metric(usdaSearchMs),
    usda_details: metric(usdaDetailsMs),
    off_barcode: metric(offBarcodeMs),
    off_search: metric(offSearchMs),
};

console.log(`[food_provider_live] ${JSON.stringify(report)}`);

for (const [label, metricValue] of Object.entries(report).filter(
    ([key]) => !["iterations", "max_latency_gate_ms", "degraded"].includes(key),
)) {
    const p95 = (metricValue as { p95_ms: number | null }).p95_ms;
    if (p95 !== null && p95 > maxLatencyMs) {
        throw new Error(
            `${label} p95 ${p95}ms exceeded live provider gate ${maxLatencyMs}ms`,
        );
    }
}
