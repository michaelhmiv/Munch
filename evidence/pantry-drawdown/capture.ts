// Phone-width (390px) captures for cross-work slice 4 — pantry
// draw-down on logging (brief §4). Taken against the shipped static
// files (public/) served as-is, with the app API stubbed: the recipe
// log endpoint returns a fixed draw-down summary in the exact shape
// src/inventory/drawdown.ts produces, so the confirmation render is
// the production code path end to end. The script logs measurements
// (both servings fields present and separate, checkbox state per
// entry point, summary rows in the existing food-row style, no
// horizontal overflow) so the review is evidence, not eyeballing.
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

const recipes = [
    {
        recipe_id: "fixture-pilaf",
        revision_id: "fixture-pilaf-r1",
        name: "Chicken & Rice Pilaf",
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
        times_scheduled: 2,
        times_logged: 9,
        last_logged_at: "2026-11-02T12:00:00.000Z",
        created_at: "2026-09-01T00:00:00.000Z",
    },
];

const planning = {
    plannedMeals: [],
    recipes,
    permissions: { personal: true, household: false },
    groceries: [{ scope: "personal", groceryListId: null, items: [] }],
};

// The draw-down the stubbed log returns: cooked 4 servings of the
// 4-serving recipe against Rice 6 cups exact and Chicken ~2 lb
// approximate, plus one ingredient that is not stocked.
const drawdown = {
    status: "applied",
    lines: [
        {
            ingredient: "Rice",
            pantry_item_id: "fixture-rice",
            pantry_name: "Rice",
            status: "applied",
            used_quantity: 4,
            used_unit: "cup",
            remainder_quantity: 2,
            remainder_unit: "cup",
            remainder_text: "2 cup left",
            via: "deterministic",
            reason: null,
        },
        {
            ingredient: "Chicken breast",
            pantry_item_id: "fixture-chicken",
            pantry_name: "Chicken",
            status: "applied",
            used_quantity: 1.5,
            used_unit: "lb",
            remainder_quantity: null,
            remainder_unit: "lb",
            remainder_text: "likely gone",
            via: "ai",
            reason: null,
        },
        {
            ingredient: "Saffron",
            pantry_item_id: null,
            pantry_name: null,
            status: "skipped",
            used_quantity: null,
            used_unit: null,
            remainder_quantity: null,
            remainder_unit: null,
            remainder_text: "",
            via: null,
            reason: "not in pantry",
        },
    ],
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
            if (req.method === "POST" && url.pathname.endsWith("/log")) {
                return Response.json({
                    result: { deduplicated: false },
                    drawdown,
                });
            }
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
        const dialog = document.querySelector("#app-dialog");
        const checkbox =
            dialog?.querySelector<HTMLInputElement>(
                'input[name="from_pantry"]',
            ) ?? null;
        const checkboxRect = checkbox?.getBoundingClientRect();
        const cooked = dialog?.querySelector<HTMLInputElement>(
            'input[name="servings_cooked"]',
        );
        const eaten = dialog?.querySelector<HTMLInputElement>(
            'input[name="servings_consumed"]',
        );
        const rows = [...(dialog?.querySelectorAll(".food-row") ?? [])].map(
            (row) => row.textContent?.replace(/\s+/g, " ").trim(),
        );
        return {
            dialogTitle: dialog?.querySelector("h2")?.textContent,
            fromPantryPresent: Boolean(checkbox),
            fromPantryChecked: checkbox?.checked ?? null,
            checkboxDrawnPx: checkboxRect
                ? Math.round(checkboxRect.width)
                : null,
            cookedField: cooked
                ? {
                      value: cooked.value,
                      hidden: Boolean(
                          cooked.closest("[data-cooked-field]")?.hidden,
                      ),
                  }
                : null,
            eatenField: eaten ? { value: eaten.value } : null,
            summaryRows: rows,
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

// 1 — Library Log flow: unchecked by default; check it, set Cooked 4
// / You ate 1, capture both servings fields.
await page.locator('[data-action="log-recipe"]').first().click();
await page.waitForSelector('#app-dialog input[name="from_pantry"]');
const unchecked = await measure("library-log-unchecked:");
if (unchecked.fromPantryChecked !== false) {
    throw new Error("library Log flow must default from-pantry unchecked");
}
await page.locator('#app-dialog input[name="from_pantry"]').check();
await page.locator('#app-dialog input[name="servings_cooked"]').fill("4");
await page.locator('#app-dialog input[name="servings_consumed"]').fill("1");
const logReport = await measure("library-log-checked:");
if (!logReport.cookedField || logReport.cookedField.hidden) {
    throw new Error("servings cooked must be visible once from-pantry is on");
}
await page.screenshot({
    path: join(outDir, "recipe-log-both-servings-390.png"),
});

// 2 — Submit: the confirmation carries the draw-down summary rows.
await page.locator('#app-dialog button[type="submit"]').click();
await page.waitForFunction(
    () =>
        document.querySelector("#app-dialog h2")?.textContent ===
        "Pantry draw-down",
    { timeout: 15000 },
);
const summaryReport = await measure("drawdown-confirmation:");
if (summaryReport.summaryRows.length !== 3) {
    throw new Error("confirmation must carry one row per ingredient");
}
await page.screenshot({
    path: join(outDir, "drawdown-confirmation-390.png"),
});
await page.locator("#app-dialog .dialog-close").click();

// 3 — Guided-cook end step: the cook finish button carries
// data-from-pantry="1", so the same dialog opens defaulted checked
// with the cooked field already visible.
await page.evaluate(() => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = "log-recipe";
    button.dataset.fromPantry = "1";
    button.dataset.id = "fixture-pilaf";
    button.dataset.revision = "fixture-pilaf-r1";
    button.textContent = "Log recipe";
    document.body.appendChild(button);
    button.click();
});
await page.waitForSelector('#app-dialog input[name="from_pantry"]');
const cookReport = await measure("cook-end-default:");
if (cookReport.fromPantryChecked !== true) {
    throw new Error("guided-cook end step must default from-pantry checked");
}
if (!cookReport.cookedField || cookReport.cookedField.hidden) {
    throw new Error("cook-end dialog must show servings cooked immediately");
}
await page.screenshot({
    path: join(outDir, "cook-end-default-checked-390.png"),
});

if (logReport.overflowX || summaryReport.overflowX || cookReport.overflowX) {
    throw new Error("horizontal overflow at 390px");
}
await browser.close();
server.stop();
console.log("captures written to", outDir);
