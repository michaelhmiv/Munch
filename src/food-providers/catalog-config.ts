import type { CatalogConfig } from "./catalog-repository.js";

function bool(name: string, fallback: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (!value) return fallback;
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
    throw new Error(`${name} must be a boolean`);
}

function days(name: string, fallback: number, min = 0.01, max = 3650): number {
    const value = process.env[name]?.trim();
    if (!value) return fallback * 86_400_000;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw new Error(`${name} must be between ${min} and ${max} days`);
    }
    return parsed * 86_400_000;
}

export function foodCatalogConfig(): CatalogConfig {
    const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim());
    return {
        readsEnabled: bool(
            "MUNCH_FOOD_CATALOG_READS_ENABLED",
            databaseConfigured,
        ),
        writesEnabled: bool(
            "MUNCH_FOOD_CATALOG_WRITES_ENABLED",
            databaseConfigured,
        ),
        staleOnError: bool("MUNCH_FOOD_CATALOG_STALE_ON_ERROR", true),
        packagedTtlMs: days("MUNCH_FOOD_CATALOG_PACKAGED_TTL_DAYS", 90),
        genericTtlMs: days("MUNCH_FOOD_CATALOG_GENERIC_TTL_DAYS", 180),
        searchTtlMs: days("MUNCH_FOOD_CATALOG_SEARCH_TTL_DAYS", 3),
        negativeTtlMs: days("MUNCH_FOOD_CATALOG_NEGATIVE_TTL_DAYS", 1),
    };
}
