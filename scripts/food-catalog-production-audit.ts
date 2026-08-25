#!/usr/bin/env bun

import { SQL } from "bun";

type SummaryRow = {
    total_rows: number;
    bulk_seed_rows: number;
    api_cached_rows: number;
    stale_rows: number;
    accessed_rows: number;
    oldest_refresh: string | null;
    newest_refresh: string | null;
    oldest_fetched: string | null;
    newest_fetched: string | null;
};

type ProviderRow = { provider: string; rows: number };
type DatasetRow = { dataset: string; release: string; rows: number };
type CacheRow = {
    query_cache_rows: number;
    live_query_cache_rows: number;
    negative_cache_rows: number;
    live_negative_cache_rows: number;
};
type SizeRow = {
    relation: string;
    total_bytes: number;
    table_bytes: number;
    index_bytes: number;
};
type IndexRow = { indexname: string; indexdef: string };
type DatabaseHealthRow = {
    active_connections: number;
    waiting_locks: number;
};

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = new SQL({ url: databaseUrl, max: 2 });

try {
    const [summary] = await database<SummaryRow[]>`
        select
            count(*)::int as total_rows,
            count(*) filter (
                where source_snapshot -> 'raw' ->> 'ingestionSource' = 'bulk_seed'
            )::int as bulk_seed_rows,
            count(*) filter (
                where coalesce(source_snapshot -> 'raw' ->> 'ingestionSource', '') <> 'bulk_seed'
            )::int as api_cached_rows,
            count(*) filter (where refresh_after <= now())::int as stale_rows,
            count(*) filter (where access_count > 0)::int as accessed_rows,
            min(last_successful_refresh_at)::text as oldest_refresh,
            max(last_successful_refresh_at)::text as newest_refresh,
            min(fetched_at)::text as oldest_fetched,
            max(fetched_at)::text as newest_fetched
        from munch.food_catalog_entries
        where deprecated_at is null
    `;

    const providers = await database<ProviderRow[]>`
        select provider, count(*)::int as rows
        from munch.food_catalog_entries
        where deprecated_at is null
        group by provider
        order by rows desc, provider
    `;

    const datasets = await database<DatasetRow[]>`
        select
            coalesce(source_snapshot -> 'raw' ->> 'dataset', 'api_cache') as dataset,
            coalesce(source_snapshot -> 'raw' ->> 'datasetRelease', provider_revision, 'unknown') as release,
            count(*)::int as rows
        from munch.food_catalog_entries
        where deprecated_at is null
        group by 1, 2
        order by rows desc, dataset, release
    `;

    const [cache] = await database<CacheRow[]>`
        select
            (select count(*)::int from munch.food_catalog_query_cache) as query_cache_rows,
            (select count(*)::int from munch.food_catalog_query_cache where expires_at > now()) as live_query_cache_rows,
            (select count(*)::int from munch.food_catalog_negative_cache) as negative_cache_rows,
            (select count(*)::int from munch.food_catalog_negative_cache where expires_at > now()) as live_negative_cache_rows
    `;

    const sizes = await database<SizeRow[]>`
        select
            'munch.food_catalog_entries' as relation,
            pg_total_relation_size('munch.food_catalog_entries')::bigint::text::numeric::float8 as total_bytes,
            pg_relation_size('munch.food_catalog_entries')::bigint::text::numeric::float8 as table_bytes,
            pg_indexes_size('munch.food_catalog_entries')::bigint::text::numeric::float8 as index_bytes
        union all
        select
            'munch.food_catalog_query_cache',
            pg_total_relation_size('munch.food_catalog_query_cache')::bigint::text::numeric::float8,
            pg_relation_size('munch.food_catalog_query_cache')::bigint::text::numeric::float8,
            pg_indexes_size('munch.food_catalog_query_cache')::bigint::text::numeric::float8
        union all
        select
            'munch.food_catalog_negative_cache',
            pg_total_relation_size('munch.food_catalog_negative_cache')::bigint::text::numeric::float8,
            pg_relation_size('munch.food_catalog_negative_cache')::bigint::text::numeric::float8,
            pg_indexes_size('munch.food_catalog_negative_cache')::bigint::text::numeric::float8
    `;

    const indexes = await database<IndexRow[]>`
        select indexname, indexdef
        from pg_indexes
        where schemaname = 'munch'
          and tablename = 'food_catalog_entries'
        order by indexname
    `;

    const [databaseHealth] = await database<DatabaseHealthRow[]>`
        select
            (select count(*)::int from pg_stat_activity where datname = current_database()) as active_connections,
            (select count(*)::int from pg_locks where not granted) as waiting_locks
    `;

    console.log(
        `[food_catalog_production_audit] ${JSON.stringify({
            summary,
            providers,
            datasets,
            cache,
            sizes,
            indexes,
            database_health: databaseHealth,
        })}`,
    );
} finally {
    await database.close();
}
