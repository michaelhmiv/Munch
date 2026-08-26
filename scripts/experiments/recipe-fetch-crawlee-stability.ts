#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { PlaywrightCrawler } from "crawlee";

const BLOCKERS = [
    {
        site: "Allrecipes",
        url: "https://www.allrecipes.com/recipe/20144/banana-banana-bread/",
    },
    {
        site: "Serious Eats",
        url: "https://www.seriouseats.com/the-best-slow-cooked-bolognese-sauce-recipe",
    },
    {
        site: "Simply Recipes",
        url: "https://www.simplyrecipes.com/recipes/banana_bread/",
    },
    {
        site: "Martha Stewart",
        url: "https://www.marthastewart.com/336138/basic-chicken-soup",
    },
    {
        site: "Food & Wine",
        url: "https://www.foodandwine.com/recipes/classic-beef-chili",
    },
    {
        site: "Maangchi",
        url: "https://www.maangchi.com/recipe/bibimbap",
    },
    {
        site: "Allrecipes Extra",
        url: "https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/",
    },
] as const;

const REPEATS = 5;
const CONCURRENCY = Math.max(
    1,
    Math.min(2, Number(process.env.CRAWLEE_STABILITY_CONCURRENCY ?? "1")),
);

type ProcessMemory = {
    bunMb: number;
    chromiumMb: number;
    combinedMb: number;
};

function recipeUsable(html: string): boolean {
    return (
        /["']@type["']\s*:\s*(?:["']Recipe["']|\[[^\]]*["']Recipe["'])/i.test(
            html,
        ) &&
        /recipeIngredient/i.test(html) &&
        /recipeInstructions/i.test(html)
    );
}

function processMemory(): ProcessMemory {
    const bunMb = process.memoryUsage().rss / 1024 / 1024;
    let chromiumMb = 0;
    try {
        const ps = execFileSync("ps", ["-eo", "rss=,comm="], {
            encoding: "utf8",
        });
        for (const line of ps.split("\n")) {
            const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
            if (!match) continue;
            const command = match[2]!.toLowerCase();
            if (!/(chrome|chromium)/.test(command)) continue;
            chromiumMb += Number(match[1]) / 1024;
        }
    } catch {
        chromiumMb = 0;
    }
    return {
        bunMb: Number(bunMb.toFixed(1)),
        chromiumMb: Number(chromiumMb.toFixed(1)),
        combinedMb: Number((bunMb + chromiumMb).toFixed(1)),
    };
}

const requests = BLOCKERS.flatMap((entry) =>
    Array.from({ length: REPEATS }, (_, index) => ({
        url: entry.url,
        uniqueKey: `${entry.site}-repeat-${index + 1}`,
        userData: {
            site: entry.site,
            attempt: index + 1,
        },
    })),
);

const runStartedAt = performance.now();
let firstNavigationStartedAt: number | null = null;
let peakCombinedMb = 0;
let peakChromiumMb = 0;
let peakBunMb = 0;

const crawler = new PlaywrightCrawler({
    maxConcurrency: CONCURRENCY,
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
            const started = performance.now();
            request.userData.navigationStartedAt = started;
            firstNavigationStartedAt ??= started;
            gotoOptions.waitUntil = "domcontentloaded";
            await page.route("**/*", async (route) => {
                const type = route.request().resourceType();
                if (["image", "media", "font"].includes(type)) {
                    await route.abort();
                    return;
                }
                await route.continue();
            });
        },
    ],
    async requestHandler({ request, page, response }) {
        await page.waitForTimeout(500);
        const html = await page.content();
        const memory = processMemory();
        peakCombinedMb = Math.max(peakCombinedMb, memory.combinedMb);
        peakChromiumMb = Math.max(peakChromiumMb, memory.chromiumMb);
        peakBunMb = Math.max(peakBunMb, memory.bunMb);
        const started = Number(request.userData.navigationStartedAt);
        console.log(
            JSON.stringify({
                type: "row",
                site: String(request.userData.site),
                attempt: Number(request.userData.attempt),
                url: request.url,
                ok: recipeUsable(html),
                status: response?.status() ?? null,
                finalUrl: request.loadedUrl ?? page.url(),
                navigationMs: Number(
                    (performance.now() -
                        (Number.isFinite(started) ? started : performance.now())).toFixed(
                        2,
                    ),
                ),
                bytes: Buffer.byteLength(html),
                ...memory,
            }),
        );
    },
    async failedRequestHandler({ request, error }) {
        const memory = processMemory();
        peakCombinedMb = Math.max(peakCombinedMb, memory.combinedMb);
        peakChromiumMb = Math.max(peakChromiumMb, memory.chromiumMb);
        peakBunMb = Math.max(peakBunMb, memory.bunMb);
        const started = Number(request.userData.navigationStartedAt);
        console.log(
            JSON.stringify({
                type: "row",
                site: String(request.userData.site),
                attempt: Number(request.userData.attempt),
                url: request.url,
                ok: false,
                status: null,
                finalUrl: request.loadedUrl ?? null,
                navigationMs: Number(
                    (performance.now() -
                        (Number.isFinite(started) ? started : performance.now())).toFixed(
                        2,
                    ),
                ),
                bytes: 0,
                error: error instanceof Error ? error.message : String(error),
                ...memory,
            }),
        );
    },
});

await crawler.run(requests);

console.log(
    JSON.stringify({
        type: "summary",
        requests: requests.length,
        sites: BLOCKERS.length,
        repeats: REPEATS,
        concurrency: CONCURRENCY,
        wallMs: Number((performance.now() - runStartedAt).toFixed(2)),
        browserStartupMs:
            firstNavigationStartedAt === null
                ? null
                : Number((firstNavigationStartedAt - runStartedAt).toFixed(2)),
        peakBunMb: Number(peakBunMb.toFixed(1)),
        peakChromiumMb: Number(peakChromiumMb.toFixed(1)),
        peakCombinedMb: Number(peakCombinedMb.toFixed(1)),
    }),
);
