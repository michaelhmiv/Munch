#!/usr/bin/env bun

import { FoodCatalogRepository } from "../src/food-providers/catalog-repository.js";
import { foodCatalogConfig } from "../src/food-providers/catalog-config.js";
import {
    importUsdaBulkFile,
    type UsdaBulkDataset,
} from "../src/food-providers/usda-bulk.js";

function argument(name: string): string | undefined {
    const prefix = `--${name}=`;
    const inline = process.argv.find((value) => value.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0) return process.argv[index + 1];
    return undefined;
}

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function positiveInteger(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Expected a positive integer, received ${value}`);
    }
    return parsed;
}

const filePath = argument("file")?.trim();
const dataset = argument("dataset")?.trim() as UsdaBulkDataset | undefined;
const release = argument("release")?.trim();
const dryRun = flag("dry-run");
const batchSize = positiveInteger(argument("batch-size"), 500);
const maxRecordsValue = argument("max-records");
const maxRecords = maxRecordsValue
    ? positiveInteger(maxRecordsValue, Number.MAX_SAFE_INTEGER)
    : undefined;

if (!filePath || !dataset || !release) {
    throw new Error(
        "Usage: bun scripts/import-usda-food-catalog.ts --file <json> --dataset <foundation|survey|sr_legacy|branded> --release <YYYY-MM> [--batch-size 500] [--max-records N] [--dry-run]",
    );
}
if (!["foundation", "survey", "sr_legacy", "branded"].includes(dataset)) {
    throw new Error(`Unsupported USDA dataset: ${dataset}`);
}
if (!/^\d{4}-\d{2}$/.test(release)) {
    throw new Error("--release must use YYYY-MM format");
}
if (!dryRun && !process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required unless --dry-run is used");
}

const config = foodCatalogConfig();
const repository = new FoodCatalogRepository(config);
const stats = await importUsdaBulkFile({
    filePath,
    dataset,
    release,
    batchSize,
    ...(maxRecords === undefined ? {} : { maxRecords }),
    dryRun,
    sink: dryRun
        ? { async upsertMany() {} }
        : repository,
});

console.log(
    `[usda_bulk_import] dataset=${stats.dataset} release=${stats.release} parsed=${stats.parsed} accepted=${stats.accepted} rejected=${stats.rejected} written=${stats.written} batches=${stats.batches} duration_ms=${stats.durationMs} dry_run=${dryRun}`,
);
console.log(JSON.stringify(stats, null, 2));
