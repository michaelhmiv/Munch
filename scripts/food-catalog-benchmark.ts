#!/usr/bin/env bun

import { SQL } from "bun";
import path from "node:path";
import { foodCatalogConfig } from "../src/food-providers/catalog-config.js";
import { FoodCatalogRepository } from "../src/food-providers/catalog-repository.js";
import { importUsdaBulkFile } from "../src/food-providers/usda-bulk.js";
import type { FoodCandidate } from "../src/food-providers/types.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const iterations = Math.max(
    20,
    Math.min(200, Number(process.env.MUNCH_FOOD_BENCHMARK_ITERATIONS ?? 60)),
);
const database = new SQL({ url: databaseUrl, max: 4 });
const repository = new FoodCatalogRepository(foodCatalogConfig());
const fixture = path.resolve(
    "src/food-providers/fixtures/usda-foundation-mini.json",
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

const synthetic: FoodCandidate[] = Array.from({ length: 500 }, (_, index) => ({
    provider: "usda",
    providerFoodId: String(8_000_000 + index),
    name: `Benchmark generic food ${index}`,
    dataKind: "generic",
    nutrientsPer100g: {
        calories: 100 + (index % 20),
        protein_g: 5,
        carbs_g: 15,
        fat_g: 2,
    },
    portions: [
        {
            id: "100g",
            amount: 100,
            unit: "g",
            label: "100 g",
            gramWeight: 100,
            nutrients: {
                calories: 100 + (index % 20),
                protein_g: 5,
                carbs_g: 15,
                fat_g: 2,
            },
        },
    ],
    attribution: { label: "USDA FoodData Central", license: "CC0 / public domain" },
    confidence: 0.95,
    raw: { revision: "ci-benchmark" },
}));

async function cleanup() {
    await database`
        delete from munch.food_catalog_query_cache
        where normalized_query in ('banana', 'bananas ripe')
    `;
    await database`
        delete from munch.food_catalog_entries
        where provider = 'usda'
          and (
              provider_food_id in ('321358', '2346400')
              or provider_revision = 'ci-benchmark'
          )
    `;
}

try {
    await cleanup();
    await importUsdaBulkFile({
        filePath: fixture,
        dataset: "foundation",
        release: "2026-04",
        sink: repository,
    });

    const [, batchUpsertMs] = await timed(() => repository.upsertMany(synthetic));
    const exactDurations: number[] = [];
    const fuzzyDurations: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
        const [exact, exactMs] = await timed(() =>
            repository.searchLocal("banana", 10),
        );
        if (!exact.some((hit) => hit.candidate.providerFoodId === "321358")) {
            throw new Error("Exact benchmark lost the seeded banana candidate");
        }
        exactDurations.push(exactMs);

        const [fuzzy, fuzzyMs] = await timed(() =>
            repository.searchLocal("bananas ripe", 10),
        );
        if (!fuzzy.some((hit) => hit.candidate.providerFoodId === "321358")) {
            throw new Error("Fuzzy benchmark lost the seeded banana candidate");
        }
        fuzzyDurations.push(fuzzyMs);
    }

    const report = {
        iterations,
        exact: {
            p50_ms: percentile(exactDurations, 0.5),
            p95_ms: percentile(exactDurations, 0.95),
            max_ms: Number(Math.max(...exactDurations).toFixed(2)),
        },
        fuzzy: {
            p50_ms: percentile(fuzzyDurations, 0.5),
            p95_ms: percentile(fuzzyDurations, 0.95),
            max_ms: Number(Math.max(...fuzzyDurations).toFixed(2)),
        },
        bulk_upsert_500_ms: Number(batchUpsertMs.toFixed(2)),
    };
    console.log(`[food_catalog_benchmark] ${JSON.stringify(report)}`);

    if (report.exact.p95_ms > 50) {
        throw new Error(`Exact local search p95 exceeded 50ms: ${report.exact.p95_ms}ms`);
    }
    if (report.fuzzy.p95_ms > 75) {
        throw new Error(`Fuzzy local search p95 exceeded 75ms: ${report.fuzzy.p95_ms}ms`);
    }
    if (report.bulk_upsert_500_ms > 2_000) {
        throw new Error(
            `500-row catalog upsert exceeded 2000ms: ${report.bulk_upsert_500_ms}ms`,
        );
    }
} finally {
    await cleanup();
    await database.close();
}
