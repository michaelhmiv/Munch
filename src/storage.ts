import * as railwayService from "./service-platform/repository.js";

// Railway PostgreSQL is the only persistence backend.
export * from "./nutrition-platform/index.js";

export async function getCachedFood<T>(
    source: string,
    sourceId: string,
): Promise<T | null> {
    return (await railwayService.getCachedFood(source, sourceId)) as T | null;
}

export const cacheFood = railwayService.cacheFood;
export const insertToolAnalytics = railwayService.insertToolAnalytics;
export const getLandingStats = railwayService.getLandingStats;

export type {
    CountryStat,
    ExportFile,
    LandingStats,
} from "./service-platform/repository.js";
