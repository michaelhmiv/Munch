#!/usr/bin/env bun

import { SQL } from "bun";
import path from "node:path";
import { foodCatalogConfig } from "../src/food-providers/catalog-config.js";
import { FoodCatalogRepository } from "../src/food-providers/catalog-repository.js";
import { importUsdaBulkFile } from "../src/food-providers/usda-bulk.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = new SQL({ url: databaseUrl, max: 2 });
const repository = new FoodCatalogRepository(foodCatalogConfig());
const fixture = path.resolve(
    "src/food-providers/fixtures/usda-foundation-mini.json",
);
const fixtureIds = ["321358", "2346400"];

async function cleanup(): Promise<void> {
    await database`
        delete from munch.food_catalog_query_cache
        where normalized_query in ('banana', 'sweet potato')
    `;
    await database`
        delete from munch.food_catalog_entries
        where provider = 'usda'
          and provider_food_id in ('321358', '2346400')
    `;
}

try {
    await cleanup();

    const first = await importUsdaBulkFile({
        filePath: fixture,
        dataset: "foundation",
        release: "2026-04",
        batchSize: 100,
        sink: repository,
    });
    if (first.written !== 2 || first.rejected !== 1) {
        throw new Error(
            `Unexpected first import stats: ${JSON.stringify(first)}`,
        );
    }

    const second = await importUsdaBulkFile({
        filePath: fixture,
        dataset: "foundation",
        release: "2026-04",
        batchSize: 100,
        sink: repository,
    });
    if (second.written !== 2) {
        throw new Error(
            `Unexpected idempotent import stats: ${JSON.stringify(second)}`,
        );
    }

    const rows = await database<
        Array<{
            provider_food_id: string;
            access_count: number | string;
            provider_revision: string | null;
        }>
    >`
        select provider_food_id, access_count, provider_revision
        from munch.food_catalog_entries
        where provider = 'usda'
          and provider_food_id in ('321358', '2346400')
        order by provider_food_id
    `;
    if (rows.length !== 2) {
        throw new Error(
            `Expected 2 idempotent catalog rows, found ${rows.length}`,
        );
    }
    if (
        rows.some((row) => row.provider_revision !== "bulk:foundation:2026-04")
    ) {
        throw new Error("Bulk provenance revision was not persisted");
    }

    const local = await repository.searchLocal("banana", 10);
    if (local.length === 0 || local[0]?.candidate.providerFoodId !== "321358") {
        throw new Error(
            "Local trigram search did not recover the seeded banana",
        );
    }
    if (local[0]?.stale) {
        throw new Error("Newly imported USDA fixture was unexpectedly stale");
    }

    await repository.recordSearch(
        "banana",
        local.map((entry) => entry.candidate),
    );
    const cached = await repository.findCachedSearch("banana", 10);
    if (!cached?.length || cached[0]?.candidate.providerFoodId !== "321358") {
        throw new Error(
            "Query-result cache did not recover the persisted candidate",
        );
    }

    await database`
        update munch.food_catalog_entries
        set refresh_after = now() - interval '1 day'
        where provider = 'usda' and provider_food_id = '321358'
    `;
    const stale = await repository.searchLocal("banana", 10);
    if (!stale[0]?.stale) {
        throw new Error(
            "Local text search failed to expose stale catalog state",
        );
    }

    const countRows = await database<Array<{ count: number | string }>>`
        select count(*) as count
        from munch.food_catalog_entries
        where provider = 'usda'
          and provider_food_id in ('321358', '2346400')
    `;
    if (Number(countRows[0]?.count ?? 0) !== fixtureIds.length) {
        throw new Error("USDA fixture identities were duplicated");
    }

    const accessed = await database<Array<{ access_count: number | string }>>`
        select access_count
        from munch.food_catalog_entries
        where provider = 'usda' and provider_food_id = '321358'
    `;
    if (Number(accessed[0]?.access_count ?? 0) < 2) {
        throw new Error(
            "Local search/query-cache hits did not update access counters",
        );
    }

    console.log(
        `[food_catalog_smoke] imported=${first.accepted} idempotent_rows=${rows.length} local_hits=${local.length} query_cache_hits=${cached.length} stale_exposed=true access_count=${accessed[0]?.access_count}`,
    );
} finally {
    await cleanup();
    await database.close();
}
