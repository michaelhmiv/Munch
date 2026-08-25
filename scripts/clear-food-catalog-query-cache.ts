#!/usr/bin/env bun

import { SQL } from "bun";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = new SQL({ url: databaseUrl, max: 1 });
try {
    const [queryResult, negativeResult] = await Promise.all([
        database`delete from munch.food_catalog_query_cache returning query_hash`,
        database`delete from munch.food_catalog_negative_cache returning identity_hash`,
    ]);
    console.log(
        `[food_catalog_cache_reset] ${JSON.stringify({ query_cache_rows: queryResult.length, negative_cache_rows: negativeResult.length })}`,
    );
} finally {
    await database.close();
}
