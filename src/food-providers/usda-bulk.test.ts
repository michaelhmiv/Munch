import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { FoodCandidate } from "./types.js";
import {
    importUsdaBulkFile,
    normalizeUsdaBulkFood,
    streamUsdaBulkFoods,
} from "./usda-bulk.js";

const fixture = path.join(
    import.meta.dir,
    "fixtures",
    "usda-foundation-mini.json",
);

describe("USDA bulk ingestion", () => {
    test("streams the top-level USDA array without loading the whole file", async () => {
        const foods: Record<string, unknown>[] = [];
        for await (const food of streamUsdaBulkFoods(fixture, "foundation")) {
            foods.push(food);
        }
        expect(foods).toHaveLength(3);
        expect(foods[0]).toMatchObject({
            fdcId: 321358,
            description: "Bananas, ripe and slightly ripe, raw",
        });
    });

    test("normalizes bulk records through the canonical USDA candidate contract", async () => {
        const iterator = streamUsdaBulkFoods(fixture, "foundation");
        const first = await iterator.next();
        expect(first.done).toBe(false);
        const candidate = normalizeUsdaBulkFood(
            first.value!,
            "foundation",
            "2026-04",
        );
        expect(candidate).toMatchObject({
            provider: "usda",
            providerFoodId: "321358",
            dataKind: "generic",
            sourceUpdatedAt: "4/30/2026",
            nutrientsPer100g: {
                calories: 89,
                protein_g: 1.09,
                carbs_g: 22.84,
                fat_g: 0.33,
            },
            raw: {
                ingestionSource: "bulk_seed",
                dataset: "foundation",
                datasetRelease: "2026-04",
                revision: "bulk:foundation:2026-04",
            },
        });
        expect(candidate?.portions[0]?.gramWeight).toBe(118);
    });

    test("rejects records without usable nutrition and writes accepted foods in batches", async () => {
        const written: FoodCandidate[][] = [];
        const stats = await importUsdaBulkFile({
            filePath: fixture,
            dataset: "foundation",
            release: "2026-04",
            batchSize: 1,
            sink: {
                async upsertMany(candidates) {
                    written.push(candidates);
                },
            },
        });
        expect(stats).toMatchObject({
            parsed: 3,
            accepted: 2,
            rejected: 1,
            written: 2,
            batches: 2,
        });
        expect(written.flat().map((food) => food.providerFoodId)).toEqual([
            "321358",
            "2346400",
        ]);
    });

    test("dry-run validates the entire fixture without writing", async () => {
        let writes = 0;
        const stats = await importUsdaBulkFile({
            filePath: fixture,
            dataset: "foundation",
            release: "2026-04",
            dryRun: true,
            sink: {
                async upsertMany() {
                    writes += 1;
                },
            },
        });
        expect(stats.parsed).toBe(3);
        expect(stats.accepted).toBe(2);
        expect(stats.written).toBe(0);
        expect(writes).toBe(0);
    });
});
