import { asFoodProviderError, type FoodProviderErrorCode } from "./errors.js";
import { rankCandidates } from "./ranking.js";
import type {
    BarcodeLookupInput,
    FoodCandidate,
    FoodLookupInput,
    FoodProvider,
    FoodProviderName,
    FoodSearchInput,
} from "./types.js";

export interface FoodProviderFailure {
    provider: FoodProviderName;
    code: FoodProviderErrorCode;
    message: string;
    retryAfterSeconds?: number;
}

export interface AggregatedFoodSearchResult {
    candidates: FoodCandidate[];
    failures: FoodProviderFailure[];
}

export class FoodProviderRegistry {
    private readonly providers: Map<FoodProviderName, FoodProvider>;

    constructor(providers: FoodProvider[]) {
        this.providers = new Map();
        for (const provider of providers) {
            if (this.providers.has(provider.name)) {
                throw new Error(`Duplicate food provider: ${provider.name}`);
            }
            this.providers.set(provider.name, provider);
        }
    }

    listProviders(): FoodProviderName[] {
        return [...this.providers.keys()];
    }

    async search(input: FoodSearchInput): Promise<AggregatedFoodSearchResult> {
        const query = input.query.trim();
        if (!query) return { candidates: [], failures: [] };
        const limit = Math.max(1, Math.min(25, input.limit ?? 10));
        const settled = await Promise.allSettled(
            [...this.providers.values()].map(async (provider) => ({
                provider,
                candidates: await provider.search({ ...input, query, limit }),
            })),
        );

        const candidates: FoodCandidate[] = [];
        const failures: FoodProviderFailure[] = [];
        for (const result of settled) {
            if (result.status === "fulfilled") {
                candidates.push(...result.value.candidates);
                continue;
            }
            const error = asFoodProviderError(result.reason);
            failures.push({
                provider: (error.provider ?? "usda") as FoodProviderName,
                code: error.code,
                message: error.message,
                retryAfterSeconds: error.retryAfterSeconds,
            });
        }

        return {
            candidates: rankCandidates({ query }, candidates).slice(0, limit),
            failures,
        };
    }

    async getDetails(
        providerName: FoodProviderName,
        input: FoodLookupInput,
    ): Promise<FoodCandidate | null> {
        const provider = this.providers.get(providerName);
        if (!provider?.getDetails) return null;
        return provider.getDetails(input);
    }

    async lookupBarcode(
        input: BarcodeLookupInput,
    ): Promise<AggregatedFoodSearchResult> {
        const providers = [...this.providers.values()].filter(
            (provider) => provider.lookupBarcode,
        );
        const settled = await Promise.allSettled(
            providers.map(async (provider) => ({
                provider,
                candidate: await provider.lookupBarcode!(input),
            })),
        );
        const candidates: FoodCandidate[] = [];
        const failures: FoodProviderFailure[] = [];
        for (const result of settled) {
            if (result.status === "fulfilled") {
                if (result.value.candidate) candidates.push(result.value.candidate);
            } else {
                const error = asFoodProviderError(result.reason);
                failures.push({
                    provider: (error.provider ?? "open_food_facts") as FoodProviderName,
                    code: error.code,
                    message: error.message,
                    retryAfterSeconds: error.retryAfterSeconds,
                });
            }
        }
        return {
            candidates: rankCandidates(
                { query: input.barcode },
                candidates,
            ),
            failures,
        };
    }
}
