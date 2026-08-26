import { fetch as wreqFetch } from "node-wreq";

const targets = [
    { site: "Serious Eats", url: "https://www.seriouseats.com/foolproof-pan-pizza-recipe" },
    { site: "Simply Recipes", url: "https://www.simplyrecipes.com/recipes/banana_bread/" },
    { site: "Martha Stewart", url: "https://www.marthastewart.com/336138/basic-chicken-soup" },
    { site: "Food & Wine", url: "https://www.foodandwine.com/recipes/classic-beef-chili" },
    { site: "Maangchi", url: "https://www.maangchi.com/recipe/bibimbap" },
] as const;
const profiles = [
    { profile: "chrome_149", platform: "windows" },
    { profile: "firefox_151", platform: "windows" },
    { profile: "safari_26_4", platform: "macos" },
    { profile: "edge_148", platform: "windows" },
] as const;

for (const target of targets) {
    const attempts: Record<string, unknown>[] = [];
    for (const browser of profiles) {
        const started = performance.now();
        try {
            const response = await wreqFetch(target.url, {
                browser: { ...browser, headers: true, http2: true },
                redirect: "manual",
                timeout: 4_000,
                throwHttpErrors: false,
            });
            const body = await response.text();
            attempts.push({
                browser: `${browser.profile}/${browser.platform}`,
                status: response.status,
                ok: response.ok,
                ms: Number((performance.now() - started).toFixed(2)),
                bytes: Buffer.byteLength(body),
                location: response.headers.get("location"),
            });
            if (response.ok) break;
        } catch (error) {
            attempts.push({
                browser: `${browser.profile}/${browser.platform}`,
                ok: false,
                ms: Number((performance.now() - started).toFixed(2)),
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    console.log(JSON.stringify({
        site: target.site,
        attempts,
        rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    }));
}
