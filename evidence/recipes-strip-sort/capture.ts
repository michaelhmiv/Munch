// Phone-width (390px) captures for cross-work slice 2 — Recipes
// library: divided View · Log · Plan card strip + real library
// sorting. Taken against the shipped static files (public/) served
// as-is, with the app API stubbed by the same fixture shapes
// e2e/mobile-parity.e2e.ts uses (extended with last_logged_at /
// created_at, the fields the sorts read). The script logs
// computed-style measurements for the direction-C strip spec
// (transparent bar, rule border, hairline dividers, 31px drawn
// segments, no label overflow, no horizontal overflow) and the
// rendered title order under two sorts, so the review is evidence,
// not eyeballing alone.
import { chromium } from "playwright";
import { join } from "node:path";

const publicDir = join(import.meta.dir, "..", "..", "public");
const outDir = import.meta.dir;

const bootstrap = {
    profile: { timezone: "UTC", preferred_weight_unit: "lb" },
    productPolicy: {
        premiumPriceMonthlyCents: 299,
        householdMemberPriceMonthlyCents: 200,
        householdMemberLimit: 6,
    },
    features: {
        plan: true,
        recipes: true,
        groceries: true,
        pantry: true,
        cooks: true,
    },
    capabilities: {
        entitlementSource: "android_free_baseline",
        tier: "free",
        recipeWrite: true,
        householdRecipeWrite: false,
    },
    household: null,
    ads: { enabled: false },
    user: { email: "capture@example.test" },
    androidEntitlements: { adFree: false },
};

// Payload order is deliberately NOT any sorted order: Lemon (9
// logged) ships first, so a leading Overnight Oats (11 logged) in
// the default capture proves the Most-cooked sort ran.
const recipes = [
    {
        recipe_id: "fixture-lemon-chicken",
        revision_id: "fixture-lemon-chicken-r1",
        name: "Lemon Herb Chicken & Rice",
        version: 1,
        ownership: "personal",
        servings: 4,
        nutrition_status: "complete",
        nutrition_per_serving: {
            calories: 512,
            protein_g: 44,
            carbs_g: 48,
            fat_g: 15,
        },
        times_scheduled: 6,
        times_logged: 9,
        last_logged_at: "2026-11-02T12:00:00.000Z",
        created_at: "2026-09-01T00:00:00.000Z",
    },
    {
        recipe_id: "fixture-overnight-oats",
        revision_id: "fixture-overnight-oats-r1",
        name: "Overnight Oats",
        version: 1,
        ownership: "personal",
        servings: 2,
        nutrition_status: "complete",
        nutrition_per_serving: {
            calories: 385,
            protein_g: 14,
            carbs_g: 52,
            fat_g: 13,
        },
        times_scheduled: 3,
        times_logged: 11,
        last_logged_at: "2026-11-10T12:00:00.000Z",
        created_at: "2026-11-01T00:00:00.000Z",
    },
    {
        recipe_id: "fixture-turkey-chili",
        revision_id: "fixture-turkey-chili-r1",
        name: "Turkey Chili",
        version: 1,
        ownership: "household",
        servings: 6,
        nutrition_status: "complete",
        nutrition_per_serving: {
            calories: 428,
            protein_g: 32,
            carbs_g: 38,
            fat_g: 16,
        },
        times_scheduled: 2,
        times_logged: 4,
        last_logged_at: "2026-11-08T12:00:00.000Z",
        created_at: "2026-10-01T00:00:00.000Z",
    },
    {
        recipe_id: "fixture-salmon",
        revision_id: "fixture-salmon-r3",
        name: "Sheet-Pan Salmon & Broccoli",
        version: 3,
        ownership: "personal",
        servings: 4,
        nutrition_status: "complete",
        nutrition_per_serving: {
            calories: 412,
            protein_g: 36,
            carbs_g: 9,
            fat_g: 25,
        },
        times_scheduled: 4,
        times_logged: 5,
        last_logged_at: "2026-11-05T12:00:00.000Z",
        created_at: "2026-08-01T00:00:00.000Z",
    },
];

const planning = {
    plannedMeals: [],
    recipes,
    permissions: { personal: true, household: false },
    groceries: [{ scope: "personal", groceryListId: null, items: [] }],
};

function fixtureJson(pathname: string): unknown {
    if (pathname === "/api/app/bootstrap") return bootstrap;
    if (pathname === "/api/app/planning") return planning;
    if (pathname === "/api/app/today") {
        return {
            totals: { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
            meals: [],
            water: { entries: [], totalMl: 0 },
            weight: [],
            goals: {},
            drafts: [],
            plannedMeals: [],
        };
    }
    return {};
}

const server = Bun.serve({
    port: 0,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/api/")) {
            return Response.json(fixtureJson(url.pathname));
        }
        const direct = Bun.file(join(publicDir, url.pathname));
        if (await direct.exists()) return new Response(direct);
        if (url.pathname.startsWith("/app")) {
            return new Response(Bun.file(join(publicDir, "/app.html")));
        }
        return new Response("not found", { status: 404 });
    },
});
const base = `http://127.0.0.1:${server.port}`;

const browser = await chromium.launch();
const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
});
page.on("pageerror", (error) => console.log("PAGEERROR:", error.message));

async function measure(label: string) {
    const report = await page.evaluate(() => {
        const titles = [
            ...document.querySelectorAll(".recipe-panel .recipe-title"),
        ].map((el) => el.textContent);
        const bar = document.querySelector(".recipe-panel-actions");
        const barStyle = bar ? getComputedStyle(bar) : null;
        const barRect = bar?.getBoundingClientRect();
        const segments = [
            ...document.querySelectorAll(".recipe-panel-actions .button"),
        ].slice(0, 3);
        const segmentReports = segments.map((el) => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return {
                text: el.textContent,
                height: Math.round(rect.height),
                background: style.backgroundColor,
                color: style.color,
                dividerLeft:
                    style.borderLeftWidth + " " + style.borderLeftColor,
                labelOverflow: el.scrollWidth > el.clientWidth,
            };
        });
        const sort = document.querySelector<HTMLSelectElement>("#recipe-sort");
        const sortStyle = sort ? getComputedStyle(sort) : null;
        const sortRect = sort?.getBoundingClientRect();
        return {
            sortValue: sort?.value,
            sortHeight: sortRect ? Math.round(sortRect.height) : null,
            sortBorder: sortStyle
                ? sortStyle.borderTopWidth + " " + sortStyle.borderTopColor
                : null,
            titles,
            bar: barStyle
                ? {
                      background: barStyle.backgroundColor,
                      border:
                          barStyle.borderTopWidth +
                          " " +
                          barStyle.borderTopColor,
                      borderRadius: barStyle.borderRadius,
                      height: barRect ? Math.round(barRect.height) : null,
                  }
                : null,
            segments: segmentReports,
            groceryActionsOnCards: document.querySelectorAll(
                '.recipe-panel [data-action="recipe-groceries"]',
            ).length,
            overflowX: document.documentElement.scrollWidth > window.innerWidth,
        };
    });
    console.log(label, JSON.stringify(report, null, 1));
    return report;
}

await page.goto(`${base}/app/recipes`, { waitUntil: "load" });
await page.waitForSelector(".recipes-view .recipe-panel", {
    timeout: 15000,
});
const defaultReport = await measure("recipes-most-cooked:");
await page.screenshot({
    path: join(outDir, "recipes-most-cooked-390.png"),
    fullPage: true,
});

await page.locator("#recipe-sort").selectOption("a-z");
await page.waitForFunction(
    () =>
        document
            .querySelector(".recipe-panel .recipe-title")
            ?.textContent?.startsWith("Lemon"),
    { timeout: 15000 },
);
const azReport = await measure("recipes-a-z:");
await page.screenshot({
    path: join(outDir, "recipes-a-z-390.png"),
    fullPage: true,
});

if (JSON.stringify(defaultReport.titles) === JSON.stringify(azReport.titles)) {
    throw new Error("sort did not change the rendered order");
}
await browser.close();
server.stop();
console.log("captures written to", outDir);
