import { describe, expect, test } from "bun:test";
import {
    RecipeImportError,
    fetchRecipePage,
    isRecipeChallengeResponse,
    resetRecipeImportFetchState,
    type RecipeFallbackRequest,
} from "./recipe-import/fetch.js";

const PUBLIC_DNS = async () => [{ address: "93.184.216.34" }];
const HTML_HEADERS = { "content-type": "text/html" };

function httpError(status: number): Response {
    return new Response(`<html>HTTP ${status}</html>`, {
        status,
        headers: HTML_HEADERS,
    });
}

describe("recipe fetch fallback", () => {
    test("keeps native fetch as the fast path", async () => {
        resetRecipeImportFetchState();
        let fallbackCalls = 0;
        const page = await fetchRecipePage("https://example.com/recipe", {
            resolver: PUBLIC_DNS,
            fetcher: async () =>
                new Response("<html>native recipe</html>", {
                    status: 200,
                    headers: HTML_HEADERS,
                }),
            fallbackFetcher: async () => {
                fallbackCalls += 1;
                return new Response("<html>fallback</html>", {
                    status: 200,
                    headers: HTML_HEADERS,
                });
            },
            fallbackEnabled: true,
        });

        expect(page.html).toContain("native recipe");
        expect(fallbackCalls).toBe(0);
    });

    test("recovers a 403 with the Firefox fingerprint first", async () => {
        resetRecipeImportFetchState();
        const requests: RecipeFallbackRequest[] = [];
        const page = await fetchRecipePage("https://example.com/recipe", {
            resolver: PUBLIC_DNS,
            fetcher: async () => httpError(403),
            fallbackFetcher: async (_url, request) => {
                requests.push(request);
                return new Response("<html>recovered recipe</html>", {
                    status: 200,
                    headers: HTML_HEADERS,
                });
            },
            fallbackEnabled: true,
        });

        expect(page.html).toContain("recovered recipe");
        expect(requests.map(({ profile }) => profile)).toEqual(["firefox_151"]);
    });

    test("escalates from Firefox to Safari only when the challenge persists", async () => {
        resetRecipeImportFetchState();
        const profiles: string[] = [];
        const page = await fetchRecipePage("https://example.com/recipe", {
            resolver: PUBLIC_DNS,
            fetcher: async () => httpError(403),
            fallbackFetcher: async (_url, request) => {
                profiles.push(request.profile);
                if (request.profile === "firefox_151") return httpError(403);
                return new Response("<html>safari recovered</html>", {
                    status: 200,
                    headers: HTML_HEADERS,
                });
            },
            fallbackEnabled: true,
        });

        expect(page.html).toContain("safari recovered");
        expect(profiles).toEqual(["firefox_151", "safari_26_4"]);
    });

    test("uses only one fallback attempt for upstream 429 responses", async () => {
        resetRecipeImportFetchState();
        const profiles: string[] = [];
        let thrown: unknown;
        try {
            await fetchRecipePage("https://example.com/recipe", {
                resolver: PUBLIC_DNS,
                fetcher: async () => httpError(429),
                fallbackFetcher: async (_url, request) => {
                    profiles.push(request.profile);
                    return httpError(429);
                },
                fallbackEnabled: true,
            });
        } catch (error) {
            thrown = error;
        }

        expect(profiles).toEqual(["firefox_151"]);
        expect(thrown).toBeInstanceOf(RecipeImportError);
        expect((thrown as RecipeImportError).code).toBe("source_rate_limited");
    });

    test("does not retry hard 404 responses", async () => {
        resetRecipeImportFetchState();
        let fallbackCalls = 0;
        let thrown: unknown;
        try {
            await fetchRecipePage("https://example.com/missing", {
                resolver: PUBLIC_DNS,
                fetcher: async () => httpError(404),
                fallbackFetcher: async () => {
                    fallbackCalls += 1;
                    return httpError(404);
                },
                fallbackEnabled: true,
            });
        } catch (error) {
            thrown = error;
        }

        expect(fallbackCalls).toBe(0);
        expect(thrown).toBeInstanceOf(RecipeImportError);
        expect((thrown as RecipeImportError).code).toBe("fetch_failed");
    });

    test("recovers a 200 challenge page using body markers", async () => {
        resetRecipeImportFetchState();
        let fallbackCalls = 0;
        const page = await fetchRecipePage("https://example.com/recipe", {
            resolver: PUBLIC_DNS,
            fetcher: async () =>
                new Response(
                    '<html><script src="/cdn-cgi/challenge-platform/a.js"></script></html>',
                    { status: 200, headers: HTML_HEADERS },
                ),
            fallbackFetcher: async () => {
                fallbackCalls += 1;
                return new Response("<html>real recipe</html>", {
                    status: 200,
                    headers: HTML_HEADERS,
                });
            },
            fallbackEnabled: true,
        });

        expect(page.html).toContain("real recipe");
        expect(fallbackCalls).toBe(1);
    });

    test("revalidates redirects returned by the fallback transport", async () => {
        resetRecipeImportFetchState();
        let thrown: unknown;
        try {
            await fetchRecipePage("https://example.com/recipe", {
                resolver: PUBLIC_DNS,
                fetcher: async () => httpError(403),
                fallbackFetcher: async () =>
                    new Response(null, {
                        status: 302,
                        headers: { location: "https://127.0.0.1/internal" },
                    }),
                fallbackEnabled: true,
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(RecipeImportError);
        expect((thrown as RecipeImportError).code).toBe("unsafe_url");
    });

    test("can disable impersonated fallback without changing native behavior", async () => {
        resetRecipeImportFetchState();
        let fallbackCalls = 0;
        let thrown: unknown;
        try {
            await fetchRecipePage("https://example.com/recipe", {
                resolver: PUBLIC_DNS,
                fetcher: async () => httpError(403),
                fallbackFetcher: async () => {
                    fallbackCalls += 1;
                    return new Response("<html>unexpected</html>", {
                        status: 200,
                        headers: HTML_HEADERS,
                    });
                },
                fallbackEnabled: false,
            });
        } catch (error) {
            thrown = error;
        }

        expect(fallbackCalls).toBe(0);
        expect(thrown).toBeInstanceOf(RecipeImportError);
    });

    test("challenge detection is limited to exact response signals", () => {
        expect(
            isRecipeChallengeResponse(
                new Response("ok", { status: 200, headers: HTML_HEADERS }),
                "A normal recipe that mentions Cloudflare generically.",
            ),
        ).toBe(false);
        expect(
            isRecipeChallengeResponse(
                new Response("", {
                    status: 200,
                    headers: { "cf-mitigated": "challenge" },
                }),
            ),
        ).toBe(true);
    });
});
