#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
    bunRssMb: number;
    chromiumRssMb: number;
    combinedRssMb: number;
    bunPssMb: number;
    chromiumPssMb: number;
    combinedPssMb: number;
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

function pssKb(pid: number): number {
    try {
        const smaps = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
        const match = /^Pss:\s+(\d+)\s+kB$/m.exec(smaps);
        return match ? Number(match[1]) : 0;
    } catch {
        return 0;
    }
}

function processMemory(): ProcessMemory {
    const bunRssMb = process.memoryUsage().rss / 1024 / 1024;
    const bunPssMb = pssKb(process.pid) / 1024;
    let chromiumRssMb = 0;
    let chromiumPssMb = 0;
    try {
        const ps = execFileSync("ps", ["-eo", "pid=,rss=,comm="], {
            encoding: "utf8",
        });
        for (const line of ps.split("\n")) {
            const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
            if (!match) continue;
            const command = match[3]!.toLowerCase();
            if (!/(chrome|chromium)/.test(command)) continue;
            const pid = Number(match[1]);
            chromiumRssMb += Number(match[2]) / 1024;
            chromiumPssMb += pssKb(pid) / 1024;
        }
    } catch {
        chromiumRssMb = 0;
        chromiumPssMb = 0;
    }
    return {
        bunRssMb: Number(bunRssMb.toFixed(1)),
        chromiumRssMb: Number(chromiumRssMb.toFixed(1)),
        combinedRssMb: Number((bunRssMb + chromiumRssMb).toFixed(1)),
        bunPssMb: Number(bunPssMb.toFixed(1)),
        chromiumPssMb: Number(chromiumPssMb.toFixed(1)),
        combinedPssMb: Number((bunPssMb + chromiumPssMb).toFixed(1)),
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
let peakCombinedRssMb = 0;
let peakChromiumRssMb = 0;
let peakBunRssMb = 0;
let peakCombinedPssMb = 0;
let peakChromiumPssMb = 0;
let peakBunPssMb = 0;

function recordPeaks(memory: ProcessMemory): void {
    peakCombinedRssMb = Math.max(peakCombinedRssMb, memory.combinedRssMb);
    peakChromiumRssMb = Math.max(peakChromiumRssMb, memory.chromiumRssMb);
    peakBunRssMb = Math.max(peakBunRssMb, memory.bunRssMb);
    peakCombinedPssMb = Math.max(peakCombinedPssMb, memory.combinedPssMb);
    peakChromiumPssMb = Math.max(peakChromiumPssMb, memory.chromiumPssMb);
    peakBunPssMb = Math.max(peakBunPssMb, memory.bunPssMb);
}

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
        recordPeaks(memory);
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
        recordPeaks(memory);
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
        peakBunRssMb: Number(peakBunRssMb.toFixed(1)),
        peakChromiumRssMb: Number(peakChromiumRssMb.toFixed(1)),
        peakCombinedRssMb: Number(peakCombinedRssMb.toFixed(1)),
        peakBunPssMb: Number(peakBunPssMb.toFixed(1)),
        peakChromiumPssMb: Number(peakChromiumPssMb.toFixed(1)),
        peakCombinedPssMb: Number(peakCombinedPssMb.toFixed(1)),
    }),
);
