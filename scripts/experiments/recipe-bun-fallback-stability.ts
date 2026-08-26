import { fetch as wreqFetch } from "node-wreq";

const targets = [
    { site: "Allrecipes", url: "https://www.allrecipes.com/recipe/20144/banana-banana-bread/", repeats: 5 },
    { site: "Serious Eats", url: "https://www.seriouseats.com/the-best-slow-cooked-bolognese-sauce-recipe", repeats: 5 },
    { site: "Simply Recipes", url: "https://www.simplyrecipes.com/recipes/banana_bread/", repeats: 5 },
    { site: "Martha Stewart", url: "https://www.marthastewart.com/336138/basic-chicken-soup", repeats: 5 },
    { site: "Food & Wine", url: "https://www.foodandwine.com/recipes/classic-beef-chili", repeats: 5 },
    { site: "Maangchi", url: "https://www.maangchi.com/recipe/bibimbap", repeats: 5 },
    { site: "Food52", url: "https://food52.com/recipes/27821-julia-child-s-coq-au-vin", repeats: 1 },
] as const;
const profiles = [
    { profile: "firefox_151", platform: "windows" },
    { profile: "safari_26_4", platform: "macos" },
] as const;

for (const target of targets) {
    let successes = 0;
    const rows: Record<string, unknown>[] = [];
    for (let repeat = 1; repeat <= target.repeats; repeat += 1) {
        const attempts: Record<string, unknown>[] = [];
        let succeeded = false;
        for (const browser of profiles) {
            const started = performance.now();
            try {
                const response = await wreqFetch(target.url, {
                    browser: { ...browser, headers: true, http2: true },
                    redirect: "manual",
                    timeout: 4_000,
                    throwHttpErrors: false,
                });
                const body = await response.arrayBuffer();
                const row = {
                    browser: `${browser.profile}/${browser.platform}`,
                    status: response.status,
                    ok: response.ok,
                    ms: Number((performance.now() - started).toFixed(2)),
                    bytes: body.byteLength,
                    location: response.headers.get("location"),
                };
                attempts.push(row);
                if (response.ok) {
                    succeeded = true;
                    successes += 1;
                    break;
                }
                if (response.status === 404 || response.status === 410) break;
            } catch (error) {
                attempts.push({
                    browser: `${browser.profile}/${browser.platform}`,
                    ok: false,
                    ms: Number((performance.now() - started).toFixed(2)),
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        rows.push({ repeat, succeeded, attempts });
    }
    console.log(JSON.stringify({
        site: target.site,
        successes,
        repeats: target.repeats,
        success_rate: successes / target.repeats,
        rows,
        rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    }));
}
