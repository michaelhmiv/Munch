// Phone-width (390px) captures for the Design Authority Direction C
// pass (cross-work slice 1), taken against the shipped static files
// (public/) served as-is, with the app API stubbed by the same
// fixture shapes e2e/mobile-parity.e2e.ts uses. The script also logs
// computed-style measurements for the Direction C spec (secondary
// border/fill, drawn button height, dialog field wells, checkbox
// size, one green primary per screen, no horizontal overflow) so the
// review is evidence, not eyeballing alone.
import { chromium } from "playwright";
import { join } from "node:path";

const publicDir = join(import.meta.dir, "..", "..", "public");
const outDir = import.meta.dir;

function mondayOfCurrentWeek(): string {
    const today = new Date().toISOString().slice(0, 10);
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
}
const monday = mondayOfCurrentWeek();

const bootstrap = {
    profile: { timezone: "UTC", preferred_weight_unit: "lb" },
    productPolicy: {
        premiumPriceMonthlyCents: 300,
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
    },
];

const recipeDetail = {
    recipe: {
        id: "fixture-salmon",
        revision_id: "fixture-salmon-r3",
        revision_number: 3,
        version: 3,
        name: "Sheet-Pan Salmon & Broccoli",
        servings: 4,
        nutrition_status: "complete",
        nutrition_per_serving: {
            calories: 412,
            protein_g: 36,
            carbs_g: 9,
            fat_g: 25,
        },
        ingredients: [
            {
                name: "Atlantic salmon fillets",
                quantity: 680,
                unit: "g",
                nutrients: { calories: 1416 },
                source_type: "usda",
            },
            {
                name: "Broccoli florets",
                quantity: 600,
                unit: "g",
                nutrients: { calories: 204 },
                source_type: "usda",
            },
            {
                name: "Olive oil",
                quantity: 2,
                unit: "tbsp",
                nutrients: { calories: 239 },
                source_type: "usda",
            },
        ],
        instructions: [
            "Heat the oven to 425°F and line a sheet pan.",
            "Toss broccoli with olive oil, garlic, and lemon juice; spread on the pan.",
            "Place salmon on top; roast 14–16 minutes, until it flakes.",
        ],
    },
};

const planning = {
    plannedMeals: [
        {
            planned_meal_id: "fixture-planned-meal",
            planned_date: monday,
            recipe_id: "fixture-lemon-chicken",
            recipe_name: "Lemon Herb Chicken & Rice",
            meal_slot: "dinner",
            ownership: "personal",
            created_by: null,
            servings: 2,
            version: 3,
            nutrition_per_serving: { calories: 512, protein_g: 44 },
        },
    ],
    recipes,
    permissions: { personal: true, household: false },
    groceries: [
        {
            scope: "personal",
            groceryListId: "fixture-grocery-list",
            items: [
                {
                    grocery_item_id: "fixture-grocery-spinach",
                    name: "Baby spinach",
                    quantity: 1,
                    unit: "bag",
                    note: null,
                    purchased_at: null,
                    source_recipe_id: null,
                    source_planned_meal_id: "fixture-planned-meal",
                    added_by: null,
                    version: 1,
                },
                {
                    grocery_item_id: "fixture-grocery-rice",
                    name: "Jasmine rice",
                    quantity: 4,
                    unit: "lb",
                    note: null,
                    purchased_at: null,
                    source_recipe_id: "fixture-lemon-chicken",
                    source_planned_meal_id: null,
                    added_by: null,
                    version: 1,
                },
                {
                    grocery_item_id: "fixture-grocery-eggs",
                    name: "Eggs",
                    quantity: 18,
                    unit: "ct",
                    note: null,
                    purchased_at: "2026-11-09T12:00:00.000Z",
                    source_recipe_id: null,
                    source_planned_meal_id: null,
                    added_by: null,
                    version: 2,
                },
                {
                    grocery_item_id: "fixture-grocery-milk",
                    name: "Oat milk",
                    quantity: 2,
                    unit: "carton",
                    note: null,
                    purchased_at: null,
                    source_recipe_id: null,
                    source_planned_meal_id: null,
                    added_by: null,
                    version: 1,
                },
            ],
        },
    ],
};

function fixtureJson(pathname: string): unknown {
    if (pathname === "/api/app/bootstrap") return bootstrap;
    if (pathname === "/api/app/planning") return planning;
    if (pathname === "/api/app/recipes/fixture-salmon") return recipeDetail;
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
        // SPA routes (/app, /app/recipes, …) serve the app shell.
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
        const visible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== "hidden" &&
                style.display !== "none"
            );
        };
        const primaries = [
            ...document.querySelectorAll(".button-primary"),
        ].filter(visible);
        const secondary = document.querySelector(
            ".button-secondary:not(.recipe-panel-actions .button-secondary)",
        );
        const secondaryStyle = secondary
            ? getComputedStyle(secondary)
            : null;
        const secondaryRect = secondary?.getBoundingClientRect();
        return {
            greenPrimariesVisible: primaries.length,
            secondary: secondaryStyle
                ? {
                      background: secondaryStyle.backgroundColor,
                      borderColor: secondaryStyle.borderColor,
                      color: secondaryStyle.color,
                      height: Math.round(secondaryRect!.height),
                      borderRadius: secondaryStyle.borderRadius,
                      fontFamily: secondaryStyle.fontFamily,
                  }
                : null,
            overflowX:
                document.documentElement.scrollWidth > window.innerWidth,
        };
    });
    console.log(label, JSON.stringify(report));
    return report;
}

// Recipes library.
await page.goto(`${base}/app/recipes`, { waitUntil: "load" });
await page.waitForSelector(".recipes-view .recipe-panel", {
    timeout: 15000,
});
await measure("recipes:");
await page.screenshot({ path: join(outDir, "recipes-390.png") });

// Recipe detail dialog (a dialog on the Recipes surface).
await page
    .locator(
        '[data-action="view-recipe"][data-id="fixture-salmon"]',
    )
    .first()
    .click();
await page.waitForSelector("dialog[open] .recipe-detail", {
    timeout: 15000,
});
const dialogReport = await page.evaluate(() => {
    const card = document.querySelector("dialog .auth-card");
    const cardStyle = card ? getComputedStyle(card) : null;
    const close = document.querySelector("dialog .dialog-close");
    const closeStyle = close ? getComputedStyle(close) : null;
    const closeRect = close?.getBoundingClientRect();
    return {
        dialogCardBackground: cardStyle?.backgroundColor,
        close: closeStyle
            ? {
                  background: closeStyle.backgroundColor,
                  borderColor: closeStyle.borderColor,
                  color: closeStyle.color,
                  height: Math.round(closeRect!.height),
              }
            : null,
    };
});
console.log("recipe-dialog:", JSON.stringify(dialogReport));
await page.screenshot({ path: join(outDir, "recipe-dialog-390.png") });
await page.keyboard.press("Escape");

// Meal Plan.
await page.goto(`${base}/app/plan`, { waitUntil: "load" });
await page.waitForSelector(".plan-view .meal-groups", { timeout: 15000 });
await measure("plan:");
await page.screenshot({ path: join(outDir, "plan-390.png") });

// Groceries.
await page.goto(`${base}/app/groceries`, { waitUntil: "load" });
await page.waitForSelector(".groceries-view .grocery-item-row", {
    timeout: 15000,
});
await measure("groceries:");
const groceryReport = await page.evaluate(() => {
    const input = document.querySelector(".grocery-check-input");
    const label = document.querySelector(".grocery-check");
    const inputRect = input?.getBoundingClientRect();
    const labelRect = label?.getBoundingClientRect();
    return {
        checkboxDrawn: inputRect
            ? `${Math.round(inputRect.width)}x${Math.round(inputRect.height)}`
            : null,
        checkboxTapArea: labelRect
            ? `${Math.round(labelRect.width)}x${Math.round(labelRect.height)}`
            : null,
    };
});
console.log("groceries-checkbox:", JSON.stringify(groceryReport));
await page.screenshot({ path: join(outDir, "groceries-390.png") });

// Grocery add dialog: fields inside a dialog read as paper wells.
await page.locator('[data-action="add-grocery"]').first().click();
await page.waitForSelector("dialog[open] #grocery-add-form", {
    timeout: 15000,
});
const groceryDialogReport = await page.evaluate(() => {
    const field = document.querySelector(
        '#grocery-add-form input[name="name"]',
    );
    const style = field ? getComputedStyle(field) : null;
    const rect = field?.getBoundingClientRect();
    const submit = document.querySelector(
        '#grocery-add-form button[type="submit"]',
    );
    const submitStyle = submit ? getComputedStyle(submit) : null;
    return {
        fieldBackground: style?.backgroundColor,
        fieldHeight: rect ? Math.round(rect.height) : null,
        fieldBorderRadius: style?.borderRadius,
        submitBackground: submitStyle?.backgroundColor,
    };
});
console.log("grocery-dialog:", JSON.stringify(groceryDialogReport));
await page.screenshot({ path: join(outDir, "grocery-dialog-390.png") });

await browser.close();
server.stop();
console.log("captures written to", outDir);
