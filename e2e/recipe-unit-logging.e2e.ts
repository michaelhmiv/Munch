import { expect, test, type Page, type TestInfo } from "@playwright/test";

// Recipe unit logging (owner-approved 2026-11-13) on the real
// server with a provisioned reviewer account:
//  - the recipe detail shows the set yield in its meta line;
//  - the Log dialog's portion picker switches Servings | Amount |
//    Fraction, interpolates the live tiles from the pinned
//    whole-recipe totals, and labels the submit with the entered
//    portion ("Log 1 cup", "Log 1/4 of the recipe");
//  - logging 1 cup of a 12-cup / 12-serving recipe lands a Today
//    card that keeps the entered amount ("1 cup · 1/12 of the
//    recipe"), shows the top three ingredients by calorie
//    contribution (NOT recipe order), and counts "+ 4 more" from
//    the real ingredient count;
//  - Adjust corrects the yield in place (10 cups), the picker
//    re-opens in the remembered Amount mode, a new 1-cup log reads
//    1/10 — and the earlier card still reads 1/12 (snapshots never
//    rewrite history).
// Recipes are seeded through the API with user-supplied nutrition,
// so nothing depends on a food provider. Names are stamped per run.

const ALL_ON = {
    plan: true,
    recipes: true,
    groceries: true,
    pantry: true,
    cooks: true,
};

async function signIn(page: Page, testInfo: TestInfo) {
    const suffix =
        testInfo.project.name === "mobile-chromium" ? "_MOBILE" : "_DESKTOP";
    const email =
        process.env[`MUNCH_REVIEWER_EMAIL${suffix}`] ??
        process.env.MUNCH_REVIEWER_EMAIL;
    const password =
        process.env[`MUNCH_REVIEWER_PASSWORD${suffix}`] ??
        process.env.MUNCH_REVIEWER_PASSWORD;
    if (!email || !password) {
        throw new Error(
            "MUNCH_REVIEWER_EMAIL and MUNCH_REVIEWER_PASSWORD are required",
        );
    }
    await page.goto("/account/password?return_to=%2Fapp");
    await page.getByLabel("Username or email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app\/?$/);
    await expect(page).toHaveTitle(/^Today — Munch$/);
}

// Ingredient order is deliberate: the logged card must sort its
// visible rows by calorie contribution, so the recipe order starts
// with the SMALLEST contributor. Whole recipe: 6,082.42 kcal.
const INGREDIENTS = [
    {
        name: "flour",
        quantity: 4,
        unit: "tbsp",
        gram_weight: 30,
        calories: 110.1,
    },
    {
        name: "whole milk",
        quantity: 3,
        unit: "cup",
        gram_weight: 732,
        calories: 446.52,
    },
    {
        name: "butter",
        quantity: 4,
        unit: "tbsp",
        gram_weight: 56,
        calories: 409.36,
    },
    {
        name: "heavy cream",
        quantity: 1,
        unit: "cup",
        gram_weight: 240,
        calories: 823.2,
    },
    {
        name: "elbow macaroni",
        quantity: 1,
        unit: "lb",
        gram_weight: 453.59,
        calories: 1619.32,
    },
    {
        name: "sharp cheddar",
        quantity: 12,
        unit: "oz",
        gram_weight: 340.19,
        calories: 1336.96,
    },
    {
        name: "smoked gouda",
        quantity: 12,
        unit: "oz",
        gram_weight: 340.19,
        calories: 1336.96,
    },
] as const;

async function seedRecipe(page: Page, name: string, stamp: number) {
    const seeded = await page.request.post("/api/app/recipes", {
        headers: { origin: new URL(page.url()).origin },
        data: {
            idempotency_key: `unit-logging-e2e-recipe-${stamp}`,
            recipe: {
                name,
                servings: 12,
                yield_volume: { quantity: 12, unit: "cup" },
                source_type: "user_entered",
                instructions: [
                    "Boil the pasta.",
                    "Make the sauce.",
                    "Smoke it.",
                ],
                ingredients: INGREDIENTS.map((ingredient) => ({
                    name: `E2E ${ingredient.name} ${stamp}`,
                    quantity: ingredient.quantity,
                    unit: ingredient.unit,
                    gram_weight: ingredient.gram_weight,
                    source_type: "user_supplied",
                    source_snapshot: { entered_by_user: true },
                    nutrients: {
                        calories: ingredient.calories,
                        protein_g: 10,
                        carbs_g: 20,
                        fat_g: 5,
                    },
                })),
            },
        },
    });
    expect(seeded.status(), "seed recipe").toBe(200);
}

async function openLogDialog(page: Page, recipeName: string) {
    await page.goto("/app/recipes");
    const card = page.locator(".recipe-panel", { hasText: recipeName });
    await expect(card).toHaveCount(1);
    await card.locator('[data-action="view-recipe"]').click();
    const dialog = page.locator("#app-dialog");
    await expect(dialog.locator(".recipe-meta")).toContainText("yield 12 cups");
    await dialog.locator('[data-action="log-recipe"]').click();
    await expect(
        dialog.getByRole("heading", { name: "Log saved recipe" }),
    ).toBeVisible();
    return dialog;
}

test("recipe unit logging: picker, amount log, card order, yield adjust", async ({
    page,
}, testInfo) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, testInfo);

    const features = await page.request.put("/api/app/features", {
        headers: { origin: new URL(page.url()).origin },
        data: { features: ALL_ON },
    });
    expect(features.status(), "PUT /api/app/features").toBe(200);
    const tz = await page.request.put("/api/app/preferences", {
        headers: { origin: new URL(page.url()).origin },
        data: { timezone: "UTC" },
    });
    expect(tz.status(), "PUT /api/app/preferences").toBe(200);

    const stamp = Date.now();
    const recipeName = `E2E Unit Logging Mac ${stamp}`;
    await seedRecipe(page, recipeName, stamp);

    // ---- The picker: servings equivalence, amount tiles, fraction label.
    let dialog = await openLogDialog(page, recipeName);
    const servingsEquiv = dialog.locator('[data-equiv="servings"]');
    await expect(servingsEquiv).toHaveText("= 1 cup of the recipe");

    await dialog.locator('[data-mode="amount"]').click();
    await expect(dialog.locator("[data-yield-text]")).toContainText(
        "Yield: 12 cups",
    );
    await expect(dialog.locator("[data-tiles-label]")).toHaveText(
        "Nutrition · for 1 cup",
    );
    await expect(dialog.locator('[data-tile="calories"]')).toHaveText("507");
    await expect(dialog.locator("[data-log-submit]")).toHaveText("Log 1 cup");
    await expect(dialog.locator('[data-equiv="amount"]')).toHaveText(
        "= 1 cup of 12 cups",
    );
    await page.screenshot({
        path: testInfo.outputPath("picker-amount-390.png"),
    });

    await dialog.locator("[data-amount]").fill("2");
    await expect(dialog.locator('[data-tile="calories"]')).toHaveText("1,014");
    await expect(dialog.locator("[data-log-submit]")).toHaveText("Log 2 cups");

    await dialog.locator('[data-mode="fraction"]').click();
    await dialog.getByRole("button", { name: "1/4", exact: true }).click();
    await expect(dialog.locator("[data-log-submit]")).toHaveText(
        "Log 1/4 of the recipe",
    );
    await page.screenshot({
        path: testInfo.outputPath("picker-fraction-390.png"),
    });

    // ---- Log 1 cup and read the Today card.
    await dialog.locator('[data-mode="amount"]').click();
    await dialog.locator("[data-amount]").fill("1");
    await dialog.locator("[data-log-submit]").click();
    await expect(dialog).toBeHidden();

    await page.goto("/app");
    const mealCard = page.locator(".meal-card", { hasText: recipeName });
    await expect(mealCard).toHaveCount(1);
    await expect(mealCard.locator(".meal-portion-line")).toHaveText(
        "1 cup · 1/12 of the recipe",
    );
    const rows = mealCard.locator(".food-row");
    await expect(rows).toHaveCount(4); // top 3 + the "+ N more" row
    await expect(rows.nth(0)).toContainText(`E2E elbow macaroni ${stamp}`);
    await expect(rows.nth(1)).toContainText(`E2E sharp cheddar ${stamp}`);
    await expect(rows.nth(2)).toContainText(`E2E smoked gouda ${stamp}`);
    await expect(rows.nth(3)).toContainText(
        "+ 4 more ingredients, each scaled to 1/12",
    );
    await page.screenshot({
        path: testInfo.outputPath("logged-card-390.png"),
    });

    // ---- Adjust the yield to 10 cups; the picker remembers Amount.
    dialog = await openLogDialog(page, recipeName);
    await expect(dialog.locator('[data-mode="amount"]')).toHaveAttribute(
        "aria-selected",
        "true",
    );
    await dialog.getByRole("button", { name: "Adjust" }).click();
    await dialog.locator("[data-yield-qty]").fill("10");
    await dialog.locator("[data-yield-save]").click();
    await expect(dialog.locator("[data-yield-text]")).toContainText(
        "Yield: 10 cups",
    );
    await expect(dialog.locator('[data-equiv="amount"]')).toHaveText(
        "= 1 cup of 10 cups",
    );
    await page.screenshot({
        path: testInfo.outputPath("picker-adjusted-390.png"),
    });
    await dialog.locator("[data-log-submit]").click();
    await expect(dialog).toBeHidden();

    // ---- The new log reads 1/10; the first card still reads 1/12.
    await page.goto("/app");
    const cards = page.locator(".meal-card", { hasText: recipeName });
    await expect(cards).toHaveCount(2);
    await expect(
        cards.locator(".meal-portion-line", {
            hasText: "1 cup · 1/10 of the recipe",
        }),
    ).toHaveCount(1);
    await expect(
        cards.locator(".meal-portion-line", {
            hasText: "1 cup · 1/12 of the recipe",
        }),
    ).toHaveCount(1);
});
