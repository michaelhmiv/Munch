import { createHash } from "node:crypto";
import { withServiceDatabase } from "../platform/database.js";
import type {
    FoodCandidate,
    FoodProviderName,
    NutrientValues,
} from "./types.js";

export interface CatalogConfig {
    readsEnabled: boolean;
    writesEnabled: boolean;
    staleOnError: boolean;
    packagedTtlMs: number;
    genericTtlMs: number;
    searchTtlMs: number;
    negativeTtlMs: number;
}

export interface CatalogHit {
    candidate: FoodCandidate;
    stale: boolean;
}

interface CatalogRow {
    provider: FoodProviderName;
    provider_food_id: string;
    source_snapshot: unknown;
    refresh_after: Date | string;
}

export function normalizeFoodText(value: string): string {
    return value
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function hashCatalogIdentity(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function finiteNonNegative(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateNutrients(nutrients: NutrientValues | undefined): void {
    if (!nutrients) return;
    for (const [name, value] of Object.entries(nutrients)) {
        if (value !== undefined && !finiteNonNegative(value)) {
            throw new Error(`Invalid nutrient value for ${name}`);
        }
    }
}

export function validateCatalogCandidate(candidate: FoodCandidate): void {
    if (!candidate.providerFoodId.trim())
        throw new Error("Missing provider food ID");
    if (!candidate.name.trim()) throw new Error("Missing food name");
    if (candidate.barcode && !/^[0-9]{8,14}$/.test(candidate.barcode)) {
        throw new Error("Invalid barcode");
    }
    if (
        !Number.isFinite(candidate.confidence) ||
        candidate.confidence < 0 ||
        candidate.confidence > 1
    ) {
        throw new Error("Invalid confidence");
    }
    validateNutrients(candidate.nutrientsPer100g);
    for (const portion of candidate.portions) {
        if (!Number.isFinite(portion.amount) || portion.amount <= 0) {
            throw new Error("Invalid portion amount");
        }
        if (
            portion.gramWeight !== undefined &&
            (!Number.isFinite(portion.gramWeight) || portion.gramWeight <= 0)
        ) {
            throw new Error("Invalid portion gram weight");
        }
        validateNutrients(portion.nutrients);
    }
}

function contentHash(candidate: FoodCandidate): string {
    return createHash("sha256")
        .update(JSON.stringify(candidate), "utf8")
        .digest("hex");
}

function candidateFromRow(row: CatalogRow): FoodCandidate | null {
    const snapshot =
        typeof row.source_snapshot === "string"
            ? JSON.parse(row.source_snapshot)
            : row.source_snapshot;
    if (!snapshot || typeof snapshot !== "object") return null;
    return snapshot as FoodCandidate;
}

function refreshAfter(
    candidate: FoodCandidate,
    config: CatalogConfig,
    now: Date,
): Date {
    const ttl =
        candidate.dataKind === "generic"
            ? config.genericTtlMs
            : config.packagedTtlMs;
    return new Date(now.getTime() + ttl);
}

export class FoodCatalogRepository {
    constructor(private readonly config: CatalogConfig) {}

    async findByProviderId(
        provider: FoodProviderName,
        providerFoodId: string,
    ): Promise<CatalogHit | null> {
        if (!this.config.readsEnabled) return null;
        return withServiceDatabase(async (tx) => {
            const rows = await tx<CatalogRow[]>`
                update munch.food_catalog_entries
                set last_accessed_at = now(), access_count = access_count + 1
                where provider = ${provider}
                  and provider_food_id = ${providerFoodId}
                  and deprecated_at is null
                returning provider, provider_food_id, source_snapshot, refresh_after
            `;
            const row = rows[0];
            if (!row) return null;
            const candidate = candidateFromRow(row);
            if (!candidate) return null;
            return {
                candidate,
                stale: new Date(row.refresh_after) <= new Date(),
            };
        });
    }

    async findByBarcode(barcode: string): Promise<CatalogHit[]> {
        if (!this.config.readsEnabled) return [];
        return withServiceDatabase(async (tx) => {
            const rows = await tx<CatalogRow[]>`
                update munch.food_catalog_entries
                set last_accessed_at = now(), access_count = access_count + 1
                where barcode = ${barcode}
                  and deprecated_at is null
                returning provider, provider_food_id, source_snapshot, refresh_after
            `;
            return rows.flatMap((row) => {
                const candidate = candidateFromRow(row);
                return candidate
                    ? [
                          {
                              candidate,
                              stale: new Date(row.refresh_after) <= new Date(),
                          },
                      ]
                    : [];
            });
        });
    }

    async searchLocal(query: string, limit: number): Promise<FoodCandidate[]> {
        if (!this.config.readsEnabled) return [];
        const normalized = normalizeFoodText(query);
        if (!normalized) return [];
        return withServiceDatabase(async (tx) => {
            const rows = await tx<CatalogRow[]>`
                select provider, provider_food_id, source_snapshot, refresh_after
                from munch.food_catalog_entries
                where deprecated_at is null
                  and (
                    normalized_name % ${normalized}
                    or normalized_name like ${`%${normalized}%`}
                    or coalesce(normalized_brand, '') % ${normalized}
                  )
                order by
                    case when normalized_name = ${normalized} then 0 else 1 end,
                    greatest(similarity(normalized_name, ${normalized}), similarity(coalesce(normalized_brand, ''), ${normalized})) desc,
                    confidence desc,
                    last_accessed_at desc
                limit ${Math.max(1, Math.min(25, limit))}
            `;
            return rows.flatMap((row) => {
                const candidate = candidateFromRow(row);
                return candidate ? [candidate] : [];
            });
        });
    }

    async upsert(candidate: FoodCandidate): Promise<void> {
        if (!this.config.writesEnabled) return;
        validateCatalogCandidate(candidate);
        const now = new Date();
        const normalizedName = normalizeFoodText(candidate.name);
        const normalizedBrand = candidate.brand
            ? normalizeFoodText(candidate.brand)
            : null;
        const serving = candidate.portions[0]?.nutrients ?? null;
        const sourceUrl = candidate.attribution.url ?? null;
        const sourceLicense = candidate.attribution.license ?? null;
        const revision =
            typeof candidate.raw?.revision === "string"
                ? candidate.raw.revision
                : null;
        await withServiceDatabase(async (tx) => {
            await tx`
                insert into munch.food_catalog_entries (
                    provider, provider_food_id, barcode, name, normalized_name,
                    brand, normalized_brand, data_kind, portions,
                    nutrients_per_100g, declared_serving_nutrition, nutrient_payload,
                    source_snapshot, source_url, source_license, provider_revision,
                    source_updated_at, fetched_at, last_successful_refresh_at,
                    refresh_after, confidence, content_hash
                ) values (
                    ${candidate.provider}, ${candidate.providerFoodId}, ${candidate.barcode ?? null},
                    ${candidate.name}, ${normalizedName}, ${candidate.brand ?? null},
                    ${normalizedBrand}, ${candidate.dataKind}, ${candidate.portions}::jsonb,
                    ${candidate.nutrientsPer100g ?? null}::jsonb, ${serving}::jsonb,
                    ${candidate.nutrientsPer100g ?? {}}::jsonb, ${candidate}::jsonb,
                    ${sourceUrl}, ${sourceLicense}, ${revision}, ${candidate.sourceUpdatedAt ?? null},
                    ${now}, ${now}, ${refreshAfter(candidate, this.config, now)},
                    ${candidate.confidence}, ${contentHash(candidate)}
                )
                on conflict (provider, provider_food_id) do update set
                    barcode = excluded.barcode,
                    name = excluded.name,
                    normalized_name = excluded.normalized_name,
                    brand = excluded.brand,
                    normalized_brand = excluded.normalized_brand,
                    data_kind = excluded.data_kind,
                    portions = excluded.portions,
                    nutrients_per_100g = excluded.nutrients_per_100g,
                    declared_serving_nutrition = excluded.declared_serving_nutrition,
                    nutrient_payload = excluded.nutrient_payload,
                    source_snapshot = excluded.source_snapshot,
                    source_url = excluded.source_url,
                    source_license = excluded.source_license,
                    provider_revision = excluded.provider_revision,
                    source_updated_at = excluded.source_updated_at,
                    fetched_at = excluded.fetched_at,
                    last_successful_refresh_at = excluded.last_successful_refresh_at,
                    refresh_after = excluded.refresh_after,
                    confidence = excluded.confidence,
                    content_hash = excluded.content_hash,
                    deprecated_at = null
            `;
        });
    }

    async upsertMany(candidates: FoodCandidate[]): Promise<void> {
        for (const candidate of candidates) await this.upsert(candidate);
    }

    async isNegative(
        operation: string,
        identity: string,
        provider: string,
    ): Promise<boolean> {
        if (!this.config.readsEnabled) return false;
        const identityHash = hashCatalogIdentity(identity);
        return withServiceDatabase(async (tx) => {
            const rows = await tx<Array<{ found: boolean }>>`
                select true as found
                from munch.food_catalog_negative_cache
                where operation = ${operation}
                  and identity_hash = ${identityHash}
                  and provider = ${provider}
                  and expires_at > now()
                limit 1
            `;
            return rows.length > 0;
        });
    }

    async recordNegative(
        operation: string,
        identity: string,
        provider: string,
    ): Promise<void> {
        if (!this.config.writesEnabled) return;
        const identityHash = hashCatalogIdentity(identity);
        const expiresAt = new Date(Date.now() + this.config.negativeTtlMs);
        await withServiceDatabase(async (tx) => {
            await tx`
                insert into munch.food_catalog_negative_cache (operation, identity_hash, provider, expires_at)
                values (${operation}, ${identityHash}, ${provider}, ${expiresAt})
                on conflict (operation, identity_hash, provider) do update
                set not_found_at = now(), expires_at = excluded.expires_at
            `;
        });
    }
}
