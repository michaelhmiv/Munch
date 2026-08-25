#!/usr/bin/env bun

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
    const [usdaResults, searchMs] = await timed(() =>
        retry("usda_search", () => usda.search({ query: "banana", limit: 5 })),
    );
    const topUsda = usdaResults[0];
    if (!topUsda || !topUsda.nutrientsPer100g?.calories) {
        throw new Error("USDA live search returned no usable banana candidate");
    }
    usdaSearchMs.push(searchMs);

    const [usdaDetails, detailsMs] = await timed(() =>
        retry("usda_details", () =>
            usda.getDetails({ providerFoodId: topUsda.providerFoodId }),
        ),
    );
    if (!usdaDetails || !usdaDetails.nutrientsPer100g?.calories) {
        throw new Error("USDA live details returned no usable nutrition");
    }
    usdaDetailsMs.push(detailsMs);

    const [offProduct, barcodeMs] = await timed(() =>
        retry("off_barcode", () =>
            off.lookupBarcode({ barcode: "3017620422003" }),
        ),
    );
    if (!offProduct || !offProduct.nutrientsPer100g?.calories) {
        throw new Error(
            "Open Food Facts live barcode lookup returned no usable Nutella nutrition",
        );
    }
    offBarcodeMs.push(barcodeMs);

    const [offResults, offSearchDurationMs] = await timed(() =>
        retry("off_search", () => off.search({ query: "peanut butter", limit: 5 })),
    );
    if (offResults.length === 0) {
        throw new Error("Open Food Facts live search returned no candidates");
    }
    offSearchMs.push(offSearchDurationMs);
}

const report = {
    iterations,
    max_latency_gate_ms: maxLatencyMs,
    usda_search: {
        p50_ms: percentile(usdaSearchMs, 0.5),
        p95_ms: percentile(usdaSearchMs, 0.95),
    },
    usda_details: {
        p50_ms: percentile(usdaDetailsMs, 0.5),
        p95_ms: percentile(usdaDetailsMs, 0.95),
    },
    off_barcode: {
        p50_ms: percentile(offBarcodeMs, 0.5),
        p95_ms: percentile(offBarcodeMs, 0.95),
    },
    off_search: {
        p50_ms: percentile(offSearchMs, 0.5),
        p95_ms: percentile(offSearchMs, 0.95),
    },
};

console.log(`[food_provider_live] ${JSON.stringify(report)}`);

for (const [label, metric] of Object.entries(report).filter(
    ([key]) => key !== "iterations" && key !== "max_latency_gate_ms",
)) {
    const p95 = (metric as { p95_ms: number }).p95_ms;
    if (p95 > maxLatencyMs) {
        throw new Error(
            `${label} p95 ${p95}ms exceeded live provider gate ${maxLatencyMs}ms`,
        );
    }
}
