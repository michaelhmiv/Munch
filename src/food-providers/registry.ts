import {
    asFoodProviderError,
    FoodProviderError,
    type FoodProviderErrorCode,
} from "./errors.js";
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

interface ProviderCallResult<T> {
    provider: FoodProviderName;
    value: T;
}

interface ProviderHealth {
    consecutiveFailures: number;
    openUntil: number;
}

export interface FoodProviderRegistryOptions {
    failureThreshold?: number;
    cooldownMs?: number;
    now?: () => number;
}

const TRANSIENT_CODES = new Set<FoodProviderErrorCode>([
    "rate_limited",
    "provider_unavailable",
    "invalid_provider_response",
]);

export class FoodProviderRegistry {
    private readonly providers: Map<FoodProviderName, FoodProvider>;
    private readonly health = new Map<FoodProviderName, ProviderHealth>();
    private readonly failureThreshold: number;
    private readonly cooldownMs: number;
    private readonly now: () => number;

    constructor(
        providers: FoodProvider[],
        options: FoodProviderRegistryOptions = {},
    ) {
        this.providers = new Map();
        for (const provider of providers) {
            if (this.providers.has(provider.name)) {
                throw new Error(`Duplicate food provider: ${provider.name}`);
            }
            this.providers.set(provider.name, provider);
            this.health.set(provider.name, {
                consecutiveFailures: 0,
                openUntil: 0,
            });
        }
        this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
        this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 60_000);
        this.now = options.now ?? Date.now;
    }

    listProviders(): FoodProviderName[] {
        return [...this.providers.keys()];
    }

    private circuitOpen(provider: FoodProviderName): boolean {
        return (this.health.get(provider)?.openUntil ?? 0) > this.now();
    }

    private circuitFailure(provider: FoodProviderName): FoodProviderFailure {
        const health = this.health.get(provider);
        const remainingMs = Math.max(0, (health?.openUntil ?? 0) - this.now());
        return {
            provider,
            code: "provider_unavailable",
            message: `${provider} circuit breaker is temporarily open after repeated upstream failures`,
            retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)),
        };
    }

    private recordSuccess(provider: FoodProviderName): void {
        this.health.set(provider, { consecutiveFailures: 0, openUntil: 0 });
    }

    private recordFailure(
        provider: FoodProviderName,
        error: FoodProviderError,
    ): void {
        if (!TRANSIENT_CODES.has(error.code)) return;
        const previous = this.health.get(provider) ?? {
            consecutiveFailures: 0,
            openUntil: 0,
        };
        const consecutiveFailures = previous.consecutiveFailures + 1;
        let openUntil = previous.openUntil;
        if (consecutiveFailures >= this.failureThreshold) {
            const providerCooldown = error.retryAfterSeconds
                ? error.retryAfterSeconds * 1_000
                : 0;
            openUntil = this.now() + Math.max(this.cooldownMs, providerCooldown);
            console.warn(
                `[food_provider] circuit_open provider=${provider} failures=${consecutiveFailures} cooldown_ms=${openUntil - this.now()}`,
            );
        }
        this.health.set(provider, { consecutiveFailures, openUntil });
    }

    async search(input: FoodSearchInput): Promise<AggregatedFoodSearchResult> {
        const query = input.query.trim();
        if (!query) return { candidates: [], failures: [] };
        const limit = Math.max(1, Math.min(25, input.limit ?? 10));
        const failures: FoodProviderFailure[] = [];
        const providers = [...this.providers.values()].filter((provider) => {
            if (!this.circuitOpen(provider.name)) return true;
            failures.push(this.circuitFailure(provider.name));
            return false;
        });
        const settled = await Promise.allSettled(
            providers.map(
                async (
                    provider,
                ): Promise<ProviderCallResult<FoodCandidate[]>> => {
                    try {
                        const value = await provider.search({
                            ...input,
                            query,
                            limit,
                        });
                        this.recordSuccess(provider.name);
                        return { provider: provider.name, value };
                    } catch (error) {
                        const normalized = asFoodProviderError(error, provider.name);
                        this.recordFailure(provider.name, normalized);
                        throw normalized;
                    }
                },
            ),
        );

        const candidates: FoodCandidate[] = [];
        for (const result of settled) {
            if (result.status === "fulfilled") {
                candidates.push(...result.value.value);
                continue;
            }
            const error = asFoodProviderError(result.reason);
            failures.push({
                provider: error.provider as FoodProviderName,
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
        if (this.circuitOpen(providerName)) {
            const failure = this.circuitFailure(providerName);
            throw new FoodProviderError(failure.code, failure.message, {
                provider: providerName,
                retryAfterSeconds: failure.retryAfterSeconds,
            });
        }
        try {
            const result = await provider.getDetails(input);
            this.recordSuccess(providerName);
            return result;
        } catch (error) {
            const normalized = asFoodProviderError(error, provider.name);
            this.recordFailure(providerName, normalized);
            throw normalized;
        }
    }

    async lookupBarcode(
        input: BarcodeLookupInput,
    ): Promise<AggregatedFoodSearchResult> {
        const failures: FoodProviderFailure[] = [];
        const providers = [...this.providers.values()]
            .filter((provider) => provider.lookupBarcode)
            .filter((provider) => {
                if (!this.circuitOpen(provider.name)) return true;
                failures.push(this.circuitFailure(provider.name));
                return false;
            });
        const settled = await Promise.allSettled(
            providers.map(
                async (
                    provider,
                ): Promise<ProviderCallResult<FoodCandidate | null>> => {
                    try {
                        const value = await provider.lookupBarcode!(input);
                        this.recordSuccess(provider.name);
                        return { provider: provider.name, value };
                    } catch (error) {
                        const normalized = asFoodProviderError(error, provider.name);
                        this.recordFailure(provider.name, normalized);
                        throw normalized;
                    }
                },
            ),
        );
        const candidates: FoodCandidate[] = [];
        for (const result of settled) {
            if (result.status === "fulfilled") {
                if (result.value.value) candidates.push(result.value.value);
            } else {
                const error = asFoodProviderError(result.reason);
                failures.push({
                    provider: error.provider as FoodProviderName,
                    code: error.code,
                    message: error.message,
                    retryAfterSeconds: error.retryAfterSeconds,
                });
            }
        }
        return {
            candidates: rankCandidates({ query: input.barcode }, candidates),
            failures,
        };
    }
}
