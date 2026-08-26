#!/usr/bin/env bun

import { PlaywrightCrawler } from "crawlee";
import { scrapeRecipe } from "recipe-scrapers";
import { fetchRecipePage, RecipeImportError } from "../../src/recipe-import/fetch.js";
import { RECIPE_IMPORT_CORPUS } from "../../src/recipe-import/fixtures/recipe-corpus.js";
import { EXTRA_RECIPE_FETCH_CORPUS } from "./recipe-fetch-extra-corpus.js";

const EXTRA = [
    ["Half Baked Harvest", "https://www.halfbakedharvest.com/slow-cooker-coq-au-vin/"],
    ["Allrecipes", "https://www.allrecipes.com/recipe/20144/banana-banana-bread/"],
    ["Serious Eats", "https://www.seriouseats.com/the-best-slow-cooked-bolognese-sauce-recipe"],
    ["Sally's Baking Addiction", "https://sallysbakingaddiction.com/chewy-chocolate-chip-cookies/"],
    ["BBC Good Food", "https://www.bbcgoodfood.com/recipes/chicken-tikka-masala"],
    ["Simply Recipes", "https://www.simplyrecipes.com/recipes/banana_bread/"],
] as const;

const CORPUS = [
    ...RECIPE_IMPORT_CORPUS.map((entry) => ({ site: entry.site, url: entry.url })),
    ...EXTRA.map(([site, url]) => ({ site, url })),
    ...EXTRA_RECIPE_FETCH_CORPUS,
];

type Detection = {
    usable: boolean;
    recipeJsonLd: boolean;
    ingredientSignals: number;
    instructionSignals: number;
    title: string | null;
    recipeScrapersOk: boolean;
    recipeScrapersError: string | null;
};

type Row = {
    strategy: "native" | "crawlee";
    site: string;
    url: string;
    ok: boolean;
    status: number | null;
    finalUrl: string | null;
    durationMs: number;
    bytes: number;
    rssMb: number;
    detection?: Detection;
    error?: string;
};

async function detectRecipe(html: string, url: string): Promise<Detection> {
    const recipeJsonLd = /["']@type["']\s*:\s*(?:["']Recipe["']|\[[^\]]*["']Recipe["'])/i.test(html);
    const ingredientSignals = (html.match(/recipeIngredient/gi) ?? []).length;
    const instructionSignals = (html.match(/recipeInstructions/gi) ?? []).length;
    const title =
        /<title\b[^>]*>([\s\S]*?)<\/title>/i
            .exec(html)?.[1]
            ?.replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 180) ?? null;

    let recipeScrapersOk = false;
    let recipeScrapersError: string | null = null;
    try {
        const parsed = (await scrapeRecipe(html, url, { safeParse: true })) as any;
        recipeScrapersOk = parsed?.success === true;
        if (!recipeScrapersOk) {
            recipeScrapersError = String(
                parsed?.error?.code ?? parsed?.error?.message ?? "unknown extraction failure",
            );
        }
    } catch (error) {
        recipeScrapersError = error instanceof Error ? error.message : String(error);
    }

    return {
        usable: Boolean(recipeJsonLd && ingredientSignals > 0 && instructionSignals > 0),
        recipeJsonLd,
        ingredientSignals,
        instructionSignals,
        title,
        recipeScrapersOk,
        recipeScrapersError,
    };
}

function rssMb(): number {
    return Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
}

function output(row: Row): void {
    console.log(JSON.stringify(row));
}

async function runNative(): Promise<void> {
    for (const entry of CORPUS) {
        const started = performance.now();
        try {
            const page = await fetchRecipePage(entry.url);
            const detection = await detectRecipe(page.html, page.finalUrl);
            output({
                strategy: "native",
                site: entry.site,
                url: entry.url,
                ok: detection.usable,
                status: 200,
                finalUrl: page.finalUrl,
                durationMs: Number((performance.now() - started).toFixed(2)),
                bytes: Buffer.byteLength(page.html),
                rssMb: rssMb(),
                detection,
                ...(!detection.usable
                    ? { error: "fetched HTML did not contain complete Recipe JSON-LD" }
                    : {}),
            });
        } catch (error) {
            output({
                strategy: "native",
                site: entry.site,
                url: entry.url,
                ok: false,
                status: error instanceof RecipeImportError ? error.status : null,
                finalUrl: null,
                durationMs: Number((performance.now() - started).toFixed(2)),
                bytes: 0,
                rssMb: rssMb(),
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

function requestStartedAt(request: { userData: Record<string, unknown> }): number {
    const value = Number(request.userData.recipeBenchmarkStartedAt);
    return Number.isFinite(value) ? value : performance.now();
}

async function runCrawlee(): Promise<void> {
    const byUrl = new Map(CORPUS.map((entry) => [entry.url, entry]));

    const crawler = new PlaywrightCrawler({
        maxConcurrency: 2,
        minConcurrency: 1,
        maxRequestRetries: 1,
        navigationTimeoutSecs: 18,
        requestHandlerTimeoutSecs: 25,
        useSessionPool: true,
        persistCookiesPerSession: true,
        launchContext: {
            launchOptions: { headless: true },
        },
        preNavigationHooks: [
            async ({ page, request }, gotoOptions) => {
                request.userData.recipeBenchmarkStartedAt = performance.now();
                gotoOptions.waitUntil = "domcontentloaded";
                await page.route("**/*", async (route) => {
                    const type = route.request().resourceType();
                    if (["image", "media", "font"].includes(type)) await route.abort();
                    else await route.continue();
                });
            },
        ],
        async requestHandler({ request, page, response }) {
            const started = requestStartedAt(request);
            await page.waitForTimeout(750);
            const html = await page.content();
            const detection = await detectRecipe(html, request.loadedUrl ?? page.url());
            const entry = byUrl.get(request.url) ?? {
                site: new URL(request.url).hostname,
                url: request.url,
            };
            output({
                strategy: "crawlee",
                site: entry.site,
                url: entry.url,
                ok: detection.usable,
                status: response?.status() ?? null,
                finalUrl: request.loadedUrl ?? page.url(),
                durationMs: Number((performance.now() - started).toFixed(2)),
                bytes: Buffer.byteLength(html),
                rssMb: rssMb(),
                detection,
                ...(!detection.usable
                    ? { error: "browser HTML did not contain complete Recipe JSON-LD" }
                    : {}),
            });
        },
        async failedRequestHandler({ request, error }) {
            const started = requestStartedAt(request);
            const entry = byUrl.get(request.url) ?? {
                site: new URL(request.url).hostname,
                url: request.url,
            };
            output({
                strategy: "crawlee",
                site: entry.site,
                url: entry.url,
                ok: false,
                status: null,
                finalUrl: request.loadedUrl ?? null,
                durationMs: Number((performance.now() - started).toFixed(2)),
                bytes: 0,
                rssMb: rssMb(),
                error: error instanceof Error ? error.message : String(error),
            });
        },
    });
    await crawler.run(CORPUS.map((entry) => entry.url));
}

const strategies = new Set(
    (process.argv[2] ?? "native,crawlee")
        .split(",")
        .map((value) => value.trim()),
);
if (strategies.has("native")) await runNative();
if (strategies.has("crawlee")) await runCrawlee();
