import { createReadStream } from "node:fs";
import { normalizeUsdaFoodDetails } from "./usda.js";
import type { FoodCandidate } from "./types.js";

export type UsdaBulkDataset = "foundation" | "survey" | "sr_legacy" | "branded";

export const USDA_BULK_ROOT_KEYS: Record<UsdaBulkDataset, string> = {
    foundation: "FoundationFoods",
    survey: "SurveyFoods",
    sr_legacy: "SRLegacyFoods",
    branded: "BrandedFoods",
};

export interface UsdaBulkSink {
    upsertMany(candidates: FoodCandidate[]): Promise<void>;
}

export interface UsdaBulkImportOptions {
    filePath: string;
    dataset: UsdaBulkDataset;
    release: string;
    sink: UsdaBulkSink;
    batchSize?: number;
    maxRecords?: number;
    dryRun?: boolean;
}

export interface UsdaBulkImportStats {
    dataset: UsdaBulkDataset;
    release: string;
    parsed: number;
    accepted: number;
    rejected: number;
    written: number;
    batches: number;
    durationMs: number;
}

function sourceDate(record: Record<string, unknown>): string | undefined {
    for (const key of ["publishedDate", "publicationDate"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
}

export function normalizeUsdaBulkFood(
    record: Record<string, unknown>,
    dataset: UsdaBulkDataset,
    release: string,
): FoodCandidate | null {
    const publishedDate = sourceDate(record);
    const input = {
        ...record,
        ...(publishedDate ? { publishedDate } : {}),
    } as Parameters<typeof normalizeUsdaFoodDetails>[0];
    const candidate = normalizeUsdaFoodDetails(input);
    if (!candidate) return null;
    return {
        ...candidate,
        raw: {
            ingestionSource: "bulk_seed",
            dataset,
            datasetRelease: release,
            revision: `bulk:${dataset}:${release}`,
        },
    };
}

/**
 * Streams one top-level USDA JSON food array without loading the full export
 * into memory. USDA bulk JSON wraps the foods in a named root array such as
 * FoundationFoods or SRLegacyFoods. Nested arrays/objects and braces inside
 * JSON strings are handled by tracking JSON string and object depth state.
 */
export async function* streamUsdaBulkFoods(
    filePath: string,
    dataset: UsdaBulkDataset,
): AsyncGenerator<Record<string, unknown>> {
    const rootKey = `"${USDA_BULK_ROOT_KEYS[dataset]}"`;
    const stream = createReadStream(filePath, {
        encoding: "utf8",
        highWaterMark: 256 * 1024,
    });

    let header = "";
    let arrayStarted = false;
    let object = "";
    let depth = 0;
    let inString = false;
    let escaped = false;
    let finished = false;

    for await (const rawChunk of stream) {
        let chunk = String(rawChunk);
        if (!arrayStarted) {
            header += chunk;
            const keyIndex = header.indexOf(rootKey);
            if (keyIndex < 0) {
                if (header.length > 1_048_576) {
                    throw new Error(`USDA bulk JSON root ${rootKey} was not found`);
                }
                continue;
            }
            const arrayIndex = header.indexOf("[", keyIndex + rootKey.length);
            if (arrayIndex < 0) {
                if (header.length > 1_048_576) {
                    throw new Error(`USDA bulk JSON array ${rootKey} was not found`);
                }
                continue;
            }
            chunk = header.slice(arrayIndex + 1);
            header = "";
            arrayStarted = true;
        }

        for (let index = 0; index < chunk.length; index += 1) {
            const character = chunk[index]!;
            if (depth === 0) {
                if (character === "{") {
                    object = "{";
                    depth = 1;
                    inString = false;
                    escaped = false;
                    continue;
                }
                if (character === "]") {
                    finished = true;
                    break;
                }
                continue;
            }

            object += character;
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (character === "\\") {
                    escaped = true;
                } else if (character === '"') {
                    inString = false;
                }
                continue;
            }

            if (character === '"') {
                inString = true;
                continue;
            }
            if (character === "{") {
                depth += 1;
                continue;
            }
            if (character !== "}") continue;
            depth -= 1;
            if (depth !== 0) continue;

            let parsed: unknown;
            try {
                parsed = JSON.parse(object);
            } catch (error) {
                throw new Error("USDA bulk JSON contained a malformed food record", {
                    cause: error,
                });
            }
            object = "";
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                yield parsed as Record<string, unknown>;
            }
        }
        if (finished) break;
    }

    if (!arrayStarted) {
        throw new Error(`USDA bulk JSON root ${rootKey} was not found`);
    }
    if (depth !== 0 || object) {
        throw new Error("USDA bulk JSON ended inside a food record");
    }
    if (!finished) {
        throw new Error(`USDA bulk JSON array ${rootKey} did not terminate`);
    }
}

export async function importUsdaBulkFile(
    options: UsdaBulkImportOptions,
): Promise<UsdaBulkImportStats> {
    const startedAt = performance.now();
    const batchSize = Math.max(1, Math.min(5_000, options.batchSize ?? 500));
    const maxRecords =
        options.maxRecords === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(1, options.maxRecords);
    const batch: FoodCandidate[] = [];
    let parsed = 0;
    let accepted = 0;
    let rejected = 0;
    let written = 0;
    let batches = 0;

    const flush = async () => {
        if (batch.length === 0) return;
        const current = batch.splice(0, batch.length);
        if (!options.dryRun) {
            await options.sink.upsertMany(current);
            written += current.length;
        }
        batches += 1;
    };

    for await (const record of streamUsdaBulkFoods(
        options.filePath,
        options.dataset,
    )) {
        parsed += 1;
        const candidate = normalizeUsdaBulkFood(
            record,
            options.dataset,
            options.release,
        );
        if (candidate) {
            accepted += 1;
            batch.push(candidate);
            if (batch.length >= batchSize) await flush();
        } else {
            rejected += 1;
        }
        if (parsed >= maxRecords) break;
    }
    await flush();

    return {
        dataset: options.dataset,
        release: options.release,
        parsed,
        accepted,
        rejected,
        written,
        batches,
        durationMs: Math.round(performance.now() - startedAt),
    };
}
