import { foodCatalogConfig } from "./catalog-config.js";
import { FoodCatalogRepository, normalizeFoodText } from "./catalog-repository.js";
import { OpenFoodFactsProvider } from "./open-food-facts.js";
import {
    FoodProviderRegistry,
    type AggregatedFoodSearchResult,
} from "./registry.js";
import { rankCandidates } from "./ranking.js";
import type { FoodCandidate, FoodProviderName } from "./types.js";
import { UsdaFoodDataCentralProvider } from "./usda.js";

export interface FoodCandidateSummary {
    candidate_id: string;
    name: string;
    brand: string | null;
    provider: FoodProviderName;
    provider_label: string;
    data_kind: FoodCandidate["dataKind"];
    barcode: string | null;
    confidence: number;
    default_portion: {
        id: string;
        label: string;
        calories: number | null;
        protein_g: number | null;
        carbs_g: number | null;
        fat_g: number | null;
    } | null;
}

export function encodeFoodCandidateId(
    candidate: Pick<FoodCandidate, "provider" | "providerFoodId">,
): string {
    return `${candidate.provider}:${encodeURIComponent(candidate.providerFoodId)}`;
}

export function decodeFoodCandidateId(value: string): {
    provider: FoodProviderName;
    providerFoodId: string;
} | null {
    const separator = value.indexOf(":");
    if (separator <= 0) return null;
    const provider = value.slice(0, separator);
    if (provider !== "usda" && provider !== "open_food_facts") return null;
    try {
        const providerFoodId = decodeURIComponent(value.slice(separator + 1));
        if (!providerFoodId || providerFoodId.length > 255) return null;
        return { provider, providerFoodId };
    } catch {
        return null;
    }
}

export function summarizeFoodCandidate(
    candidate: FoodCandidate,
): FoodCandidateSummary {
    const portion = candidate.portions[0];
    return {
        candidate_id: encodeFoodCandidateId(candidate),
        name: candidate.name,
        brand: candidate.brand ?? null,
        provider: candidate.provider,
        provider_label: candidate.attribution.label,
        data_kind: candidate.dataKind,
        barcode: candidate.barcode ?? null,
        confidence: candidate.confidence,
        default_portion: portion
            ? {
                  id: portion.id,
                  label: portion.label,
                  calories: portion.nutrients.calories ?? null,
                  protein_g: portion.nutrients.protein_g ?? null,
                  carbs_g: portion.nutrients.carbs_g ?? null,
                  fat_g: portion.nutrients.fat_g ?? null,
              }
            : null,
    };
}

function dedupe(candidates: FoodCandidate[]): FoodCandidate[] {
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        const key = `${candidate.provider}:${candidate.providerFoodId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export class FoodSearchService {
    private readonly config = foodCatalogConfig();
    private readonly catalog: FoodCatalogRepository;

    constructor(
        private readonly registry = new FoodProviderRegistry([
            new UsdaFoodDataCentralProvider(),
            new OpenFoodFactsProvider(),
        ]),
        catalog?: FoodCatalogRepository,
    ) {
        this.catalog = catalog ?? new FoodCatalogRepository(this.config);
    }

    async search(query: string, limit = 10): Promise<AggregatedFoodSearchResult> {
        const normalized = normalizeFoodText(query);
        if (!normalized) return { candidates: [], failures: [] };
        const boundedLimit = Math.max(1, Math.min(25, limit));
        const local = await this.catalog.searchLocal(normalized, boundedLimit);
        if (local.length >= boundedLimit) {
            console.info(`[food_catalog] local_hit operation=search count=${local.length}`);
            return { candidates: local.slice(0, boundedLimit), failures: [] };
        }

        console.info(`[food_catalog] local_miss operation=search count=${local.length}`);
        const result = await this.registry.search({ query: normalized, limit: boundedLimit });
        if (result.candidates.length > 0) {
            await this.catalog.upsertMany(result.candidates);
            console.info(`[food_catalog] provider_write operation=search count=${result.candidates.length}`);
        }
        const combined = rankCandidates(
            { query: normalized },
            dedupe([...local, ...result.candidates]),
        ).slice(0, boundedLimit);
        return { candidates: combined, failures: result.failures };
    }

    async details(candidateId: string): Promise<FoodCandidate | null> {
        const decoded = decodeFoodCandidateId(candidateId);
        if (!decoded) return null;
        const local = await this.catalog.findByProviderId(decoded.provider, decoded.providerFoodId);
        if (local && !local.stale) {
            console.info(`[food_catalog] local_hit operation=details provider=${decoded.provider}`);
            return local.candidate;
        }

        try {
            const candidate = await this.registry.getDetails(decoded.provider, {
                providerFoodId: decoded.providerFoodId,
            });
            if (candidate) {
                await this.catalog.upsert(candidate);
                console.info(`[food_catalog] provider_write operation=details provider=${decoded.provider}`);
                return candidate;
            }
            await this.catalog.recordNegative("details", decoded.providerFoodId, decoded.provider);
            return local?.candidate ?? null;
        } catch (error) {
            if (local && this.config.staleOnError) {
                console.warn(`[food_catalog] stale_hit operation=details provider=${decoded.provider}`);
                return local.candidate;
            }
            throw error;
        }
    }

    async barcode(barcode: string): Promise<AggregatedFoodSearchResult> {
        const digits = barcode.replace(/\D/g, "");
        if (digits.length < 8 || digits.length > 14) {
            return { candidates: [], failures: [] };
        }
        const local = await this.catalog.findByBarcode(digits);
        const fresh = local.filter((hit) => !hit.stale).map((hit) => hit.candidate);
        if (fresh.length > 0) {
            console.info(`[food_catalog] local_hit operation=barcode count=${fresh.length}`);
            return { candidates: fresh, failures: [] };
        }

        if (await this.catalog.isNegative("barcode", digits, "aggregate")) {
            console.info("[food_catalog] negative_hit operation=barcode");
            return { candidates: [], failures: [] };
        }

        console.info(`[food_catalog] local_miss operation=barcode stale=${local.length}`);
        const result = await this.registry.lookupBarcode({ barcode: digits });
        if (result.candidates.length > 0) {
            await this.catalog.upsertMany(result.candidates);
            console.info(`[food_catalog] provider_write operation=barcode count=${result.candidates.length}`);
            return result;
        }
        if (result.failures.length === 0) {
            await this.catalog.recordNegative("barcode", digits, "aggregate");
        }
        if (local.length > 0 && this.config.staleOnError) {
            console.warn(`[food_catalog] stale_hit operation=barcode count=${local.length}`);
            return { candidates: local.map((hit) => hit.candidate), failures: result.failures };
        }
        return result;
    }
}

let sharedService: FoodSearchService | null = null;

export function getFoodSearchService(): FoodSearchService {
    sharedService ??= new FoodSearchService();
    return sharedService;
}
