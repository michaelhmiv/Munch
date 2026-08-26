import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchedRecipePage } from "./types.js";

export const MAX_RECIPE_URL_LENGTH = 2_000;
export const MAX_RECIPE_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_RECIPE_REDIRECTS = 3;
export const RECIPE_FETCH_TIMEOUT_MS = 10_000;
export const RECIPE_FALLBACK_FETCH_TIMEOUT_MS = 4_000;
export const RECIPE_IMPORTS_PER_MINUTE = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FALLBACK_STATUSES = new Set([403, 429, 503]);
const CHALLENGE_MARKERS = [
    "__cf_chl",
    "cf-browser-verification",
    "/cdn-cgi/challenge-platform",
    "challenges.cloudflare.com",
    "_incapsula_resource",
    "distil_r_captcha",
    "px-captcha",
    "perimeterx",
    "datadome",
] as const;
const rateBuckets = new Map<string, number[]>();
let activeFetches = 0;
const MAX_ACTIVE_FETCHES = 8;

export class RecipeImportError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly status: number = 400,
    ) {
        super(`Recipe import ${message}`);
        this.name = "RecipeImportError";
    }
}

export type RecipeFallbackProfile = "firefox_151" | "safari_26_4";

export interface RecipeFallbackRequest {
    profile: RecipeFallbackProfile;
    platform: "windows" | "macos";
    timeoutMs: number;
}

export type RecipeFallbackFetcher = (
    url: URL,
    request: RecipeFallbackRequest,
) => Promise<Response>;

export interface RecipeUrlFetchDependencies {
    fetcher?: typeof fetch;
    fallbackFetcher?: RecipeFallbackFetcher;
    fallbackEnabled?: boolean;
    resolver?: (hostname: string) => Promise<Array<{ address: string }>>;
}

interface ResolvedRecipeUrlFetchDependencies {
    fetcher: typeof fetch;
    fallbackFetcher: RecipeFallbackFetcher;
    fallbackEnabled: boolean;
    resolver: (hostname: string) => Promise<Array<{ address: string }>>;
}

interface LoadedRecipeResponse {
    response: Response;
    html: string;
    transport: "native" | RecipeFallbackProfile;
}

function ipv4Number(value: string): number[] | null {
    const octets = value.split(".").map(Number);
    if (
        octets.length !== 4 ||
        octets.some(
            (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
        )
    ) {
        return null;
    }
    return octets;
}

function isPrivateIpv4(value: string): boolean {
    const octets = ipv4Number(value);
    if (!octets) return false;
    const a = octets[0]!;
    const b = octets[1]!;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b! >= 64 && b! <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b! >= 16 && b! <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && b! >= 18 && b! <= 19) ||
        a >= 224
    );
}

function isPrivateIpv6(value: string): boolean {
    const normalized = value.toLowerCase().split("%")[0]!;
    if (normalized === "::" || normalized === "::1") return true;
    if (
        normalized.includes(".") &&
        isPrivateIpv4(normalized.slice(normalized.lastIndexOf(":") + 1))
    ) {
        return true;
    }
    return (
        normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe8") ||
        normalized.startsWith("fe9") ||
        normalized.startsWith("fea") ||
        normalized.startsWith("feb") ||
        normalized.startsWith("ff")
    );
}

export function isPrivateOrReservedAddress(address: string): boolean {
    const normalized = address
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "");
    if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
    if (isIP(normalized) === 6) return isPrivateIpv6(normalized);
    return true;
}

export function assertSafeRecipeUrl(value: string): URL {
    if (typeof value !== "string" || value.length === 0) {
        throw new RecipeImportError("invalid_url", "URL is required.");
    }
    if (value.length > MAX_RECIPE_URL_LENGTH) {
        throw new RecipeImportError("invalid_url", "URL is too long.");
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new RecipeImportError("invalid_url", "URL is invalid.");
    }
    if (url.protocol !== "https:") {
        throw new RecipeImportError(
            "unsafe_url",
            "only HTTPS recipe pages are supported.",
        );
    }
    if (url.username || url.password || !url.hostname) {
        throw new RecipeImportError(
            "unsafe_url",
            "credentials and empty hostnames are not allowed.",
        );
    }
    if (url.port && url.port !== "443") {
        throw new RecipeImportError(
            "unsafe_url",
            "non-standard HTTPS ports are not allowed.",
        );
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname) !== 0 && isPrivateOrReservedAddress(hostname)) {
        throw new RecipeImportError(
            "unsafe_url",
            "private or reserved network addresses are not allowed.",
        );
    }
    if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname === "metadata.google.internal"
    ) {
        throw new RecipeImportError(
            "unsafe_url",
            "local and metadata hosts are not allowed.",
        );
    }
    return url;
}

function checkRateLimit(key: string): void {
    const now = Date.now();
    const cutoff = now - 60_000;
    const existing = (rateBuckets.get(key) ?? []).filter(
        (timestamp) => timestamp > cutoff,
    );
    if (existing.length >= RECIPE_IMPORTS_PER_MINUTE) {
        throw new RecipeImportError(
            "rate_limited",
            "rate limit exceeded; try again shortly.",
            429,
        );
    }
    existing.push(now);
    rateBuckets.set(key, existing);
}

async function resolvePublicHost(
    hostname: string,
    resolver: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<void> {
    const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
    if (isIP(normalizedHostname) !== 0) return;
    let addresses: Array<{ address: string }>;
    try {
        addresses = await resolver(normalizedHostname);
    } catch {
        throw new RecipeImportError(
            "host_unavailable",
            "the recipe host could not be resolved.",
            502,
        );
    }
    if (
        addresses.length === 0 ||
        addresses.some(({ address }) => isPrivateOrReservedAddress(address))
    ) {
        throw new RecipeImportError(
            "unsafe_url",
            "the recipe host resolves to a private or reserved network address.",
        );
    }
}

async function readBoundedBody(response: Response): Promise<string> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_RECIPE_HTML_BYTES
    ) {
        throw new RecipeImportError(
            "response_too_large",
            "the recipe page is too large to import.",
            413,
        );
    }

    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > MAX_RECIPE_HTML_BYTES) {
                await reader.cancel();
                throw new RecipeImportError(
                    "response_too_large",
                    "the recipe page is too large to import.",
                    413,
                );
            }
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function hasSupportedHtmlContentType(response: Response): boolean {
    const contentType = response.headers.get("content-type") ?? "";
    return (
        !contentType ||
        /text\/html|application\/xhtml\+xml/i.test(contentType)
    );
}

function assertHtmlContentType(response: Response): void {
    if (!hasSupportedHtmlContentType(response)) {
        throw new RecipeImportError(
            "unsupported_content",
            "the URL did not return an HTML recipe page.",
            415,
        );
    }
}

export function isRecipeChallengeResponse(
    response: Pick<Response, "status" | "headers">,
    html?: string,
): boolean {
    if (response.status === 403 || response.status === 503) return true;
    if (response.headers.has("cf-mitigated")) return true;
    if (!html) return false;
    const sample = html.slice(0, 4_096).toLowerCase();
    return CHALLENGE_MARKERS.some((marker) => sample.includes(marker));
}

function fallbackEnabledFromEnvironment(): boolean {
    const value = process.env.MUNCH_RECIPE_IMPERSONATED_FETCH_ENABLED
        ?.trim()
        .toLowerCase();
    return value !== "0" && value !== "false" && value !== "off";
}

async function nativeFetchOnce(
    url: URL,
    dependencies: ResolvedRecipeUrlFetchDependencies,
): Promise<Response> {
    await resolvePublicHost(url.hostname, dependencies.resolver);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RECIPE_FETCH_TIMEOUT_MS);
    try {
        return await dependencies.fetcher(url, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
                Accept: "text/html,application/xhtml+xml",
                "User-Agent":
                    "MunchRecipeImporter/1.0 (+https://munch.business)",
            },
        });
    } catch (error) {
        if (error instanceof RecipeImportError) throw error;
        throw new RecipeImportError(
            "fetch_failed",
            "could not fetch the recipe page.",
            502,
        );
    } finally {
        clearTimeout(timer);
    }
}

async function defaultFallbackFetcher(
    url: URL,
    request: RecipeFallbackRequest,
): Promise<Response> {
    const { fetch: wreqFetch } = await import("node-wreq");
    const response = await wreqFetch(url.toString(), {
        browser: {
            profile: request.profile,
            platform: request.platform,
            headers: true,
            http2: true,
        },
        redirect: "manual",
        timeout: request.timeoutMs,
        throwHttpErrors: false,
    });
    return response as unknown as Response;
}

function sourceHttpError(status: number): RecipeImportError {
    if (status === 429) {
        return new RecipeImportError(
            "source_rate_limited",
            "the recipe source is rate-limiting automated access; try again later.",
            502,
        );
    }
    return new RecipeImportError(
        "fetch_failed",
        `the recipe page returned HTTP ${status}.`,
        502,
    );
}

async function fallbackFetch(
    url: URL,
    dependencies: ResolvedRecipeUrlFetchDependencies,
    triggerStatus: number,
): Promise<LoadedRecipeResponse | Response> {
    const profiles: RecipeFallbackRequest[] = [
        {
            profile: "firefox_151",
            platform: "windows",
            timeoutMs: RECIPE_FALLBACK_FETCH_TIMEOUT_MS,
        },
        ...(triggerStatus === 429
            ? []
            : [
                  {
                      profile: "safari_26_4" as const,
                      platform: "macos" as const,
                      timeoutMs: RECIPE_FALLBACK_FETCH_TIMEOUT_MS,
                  },
              ]),
    ];
    let lastStatus = triggerStatus;

    for (const request of profiles) {
        await resolvePublicHost(url.hostname, dependencies.resolver);
        const started = performance.now();
        let response: Response;
        try {
            response = await dependencies.fallbackFetcher(url, request);
        } catch (error) {
            if (error instanceof RecipeImportError) throw error;
            console.info(
                `[recipe_fetch] transport=${request.profile} host=${url.hostname} status=error duration_ms=${Math.round(performance.now() - started)}`,
            );
            continue;
        }

        lastStatus = response.status;
        console.info(
            `[recipe_fetch] transport=${request.profile} host=${url.hostname} status=${response.status} duration_ms=${Math.round(performance.now() - started)}`,
        );

        if (REDIRECT_STATUSES.has(response.status)) return response;
        if (response.status === 429) break;
        if (!response.ok) {
            if (isRecipeChallengeResponse(response)) continue;
            throw sourceHttpError(response.status);
        }
        assertHtmlContentType(response);
        const html = await readBoundedBody(response);
        if (isRecipeChallengeResponse(response, html)) continue;
        return {
            response,
            html,
            transport: request.profile,
        };
    }

    throw sourceHttpError(lastStatus);
}

async function loadRecipeResponse(
    url: URL,
    dependencies: ResolvedRecipeUrlFetchDependencies,
): Promise<LoadedRecipeResponse | Response> {
    const response = await nativeFetchOnce(url, dependencies);
    if (REDIRECT_STATUSES.has(response.status)) return response;

    if (!response.ok) {
        if (
            dependencies.fallbackEnabled &&
            FALLBACK_STATUSES.has(response.status)
        ) {
            return fallbackFetch(url, dependencies, response.status);
        }
        throw sourceHttpError(response.status);
    }

    assertHtmlContentType(response);
    const html = await readBoundedBody(response);
    if (
        dependencies.fallbackEnabled &&
        isRecipeChallengeResponse(response, html)
    ) {
        return fallbackFetch(url, dependencies, response.status);
    }
    return { response, html, transport: "native" };
}

export async function fetchRecipePage(
    submittedValue: string,
    options: RecipeUrlFetchDependencies & { rateLimitKey?: string } = {},
): Promise<FetchedRecipePage> {
    if (options.rateLimitKey) checkRateLimit(options.rateLimitKey);
    if (activeFetches >= MAX_ACTIVE_FETCHES) {
        throw new RecipeImportError(
            "busy",
            "the importer is busy; try again shortly.",
            429,
        );
    }
    activeFetches += 1;
    const dependencies: ResolvedRecipeUrlFetchDependencies = {
        fetcher: options.fetcher ?? fetch,
        fallbackFetcher: options.fallbackFetcher ?? defaultFallbackFetcher,
        fallbackEnabled:
            options.fallbackEnabled ?? fallbackEnabledFromEnvironment(),
        resolver:
            options.resolver ??
            (async (hostname) => lookup(hostname, { all: true })),
    };
    try {
        let current = assertSafeRecipeUrl(submittedValue);
        for (let redirect = 0; redirect <= MAX_RECIPE_REDIRECTS; redirect++) {
            const loaded = await loadRecipeResponse(current, dependencies);
            if (loaded instanceof Response) {
                if (redirect === MAX_RECIPE_REDIRECTS) {
                    throw new RecipeImportError(
                        "too_many_redirects",
                        "the recipe page redirected too many times.",
                        502,
                    );
                }
                const location = loaded.headers.get("location");
                if (!location) {
                    throw new RecipeImportError(
                        "invalid_redirect",
                        "the recipe page returned an invalid redirect.",
                        502,
                    );
                }
                current = assertSafeRecipeUrl(
                    new URL(location, current).toString(),
                );
                continue;
            }

            return {
                submittedUrl: submittedValue,
                finalUrl: assertSafeRecipeUrl(
                    loaded.response.url || current.toString(),
                ).toString(),
                html: loaded.html,
            };
        }
        throw new RecipeImportError(
            "fetch_failed",
            "could not fetch the recipe page.",
            502,
        );
    } finally {
        activeFetches -= 1;
    }
}

export function resetRecipeImportFetchState(): void {
    rateBuckets.clear();
    activeFetches = 0;
}
