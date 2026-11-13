import { expect, test, type Page } from "@playwright/test";

// Cross-work slice 4 (brief §4) — pantry draw-down on logging, on
// the real server with the provisioned reviewer account. ONE sign-in
// drives the whole journey (the suite shares a sign-in rate-limit
// budget): a recipe logged with "From my pantry" on draws the pantry
// down by the servings COOKED while the meal itself carries only
// the servings EATEN; the confirmation shows the draw-down summary;
// with the Pantry module off the option is absent entirely.
// Captures go to the munch-pantry-drawdown-captures CI artifact.

const CAPTURE_DIR = "test-results/pantry-drawdown-captures";

const ALL_ON = {
    plan: true,
    recipes: true,
    groceries: true,
    pantry: true,
    cooks: true,
};

async function signIn(page: Page) {
    const email = process.env.MUNCH_REVIEWER_EMAIL;
    const password = process.env.MUNCH_REVIEWER_PASSWORD;
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

async function setFeatures(
    page: Page,
    features: Record<string, boolean>,
): Promise<void> {
    const response = await page.request.put("/api/app/features", {
        headers: { origin: new URL(page.url()).origin },
        data: { features },
    });
    expect(response.status(), "PUT /api/app/features").toBe(200);
}

async function pantryItems(
    page: Page,
): Promise<Array<{ name: string; quantity: number | null }>> {
    const response = await page.request.get("/api/app/pantry");
    expect(response.status(), "GET /api/app/pantry").toBe(200);
    const body = await response.json();
    return body.items ?? [];
}

test("recipe log draws the pantry down by servings cooked, logs only servings eaten", async ({
    page,
}) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    const stamp = Date.now().toString(36);
    const riceName = `Drawdown Rice ${stamp}`;
    const chickenName = `Drawdown Chicken ${stamp}`;
    const saffronName = `Drawdown Saffron ${stamp}`;
    const recipeName = `Drawdown Pilaf ${stamp}`;

    try {
        // The Pantry module flag (PUT /api/app/features via setFeatures) is the
        // only gate: #258 retired the legacy "Use Pantry" switch and
        // deleted its PATCH /api/app/pantry/settings endpoint, so do
        // not re-add a PATCH step here.
        await setFeatures(page, ALL_ON);

        const seeded = await page.request.post("/api/app/pantry/reconcile", {
            headers: { origin: new URL(page.url()).origin },
            data: {
                source_type: "manual",
                idempotency_key: `drawdown-e2e-seed-${stamp}`,
                operations: [
                    {
                        action: "acquire",
                        name: riceName,
                        quantity: 6,
                        unit: "cup",
                        quantity_mode: "exact",
                        location: "pantry",
                    },
                    {
                        action: "acquire",
                        name: chickenName,
                        quantity: 2,
                        unit: "lb",
                        quantity_mode: "approximate",
                        location: "pantry",
                    },
                ],
            },
        });
        expect(seeded.status(), "seed pantry items").toBe(200);

        const recipe = await page.request.post("/api/app/recipes", {
            headers: { origin: new URL(page.url()).origin },
            data: {
                idempotency_key: `drawdown-e2e-recipe-${stamp}`,
                recipe: {
                    name: recipeName,
                    servings: 4,
                    instructions: ["Cook the rice, fold in everything."],
                    source_type: "user_entered",
                    ingredients: [
                        {
                            name: riceName,
                            quantity: 4,
                            unit: "cup",
                            nutrients: { calories: 800, protein_g: 16 },
                            source_type: "user_supplied",
                        },
                        {
                            name: chickenName,
                            quantity: 2,
                            unit: "lb",
                            nutrients: { calories: 400, protein_g: 60 },
                            source_type: "user_supplied",
                        },
                        {
                            name: saffronName,
                            quantity: 1,
                            unit: "g",
                            nutrients: { calories: 4 },
                            source_type: "user_supplied",
                        },
                    ],
                },
            },
        });
        expect(recipe.status(), "seed recipe").toBe(200);

        // Log from the library card: cooked 2, ate 1.
        await page.goto("/app/recipes");
        const card = page.locator(".recipe-panel", { hasText: recipeName });
        await expect(card).toBeVisible();
        await card.locator('[data-action="log-recipe"]').click();
        const dialog = page.locator("#app-dialog");
        const fromPantry = dialog.locator('input[name="from_pantry"]');
        await expect(fromPantry).toBeVisible();
        await expect(fromPantry).not.toBeChecked();
        await fromPantry.check();
        await dialog.locator('input[name="servings_cooked"]').fill("2");
        await dialog.locator('input[name="servings_consumed"]').fill("1");
        await page.screenshot({
            path: `${CAPTURE_DIR}/recipe-log-from-pantry.png`,
        });
        await dialog.getByRole("button", { name: "Log meal" }).click();

        // Confirmation: the draw-down summary, data-shaped rows.
        await expect(dialog.locator("h2")).toHaveText("Pantry draw-down");
        await expect(dialog).toContainText("−2 cup · 4 cup left");
        await expect(dialog).toContainText("−1 lb · about half left");
        await expect(dialog).toContainText("Skipped · not in pantry");
        await page.screenshot({
            path: `${CAPTURE_DIR}/drawdown-summary.png`,
        });
        await dialog.locator(".dialog-close").click();

        // Pantry dropped by the COOKED amount (2 servings of 4):
        // rice 6 − 2 = 4 cups, chicken 2 − 1 = 1 lb.
        const items = await pantryItems(page);
        expect(items.find((item) => item.name === riceName)?.quantity).toBe(4);
        expect(items.find((item) => item.name === chickenName)?.quantity).toBe(
            1,
        );

        // The logged meal carries only the EATEN amount: one serving
        // of (800 + 400 + 4) / 4 = 301 kcal. The window is three days
        // wide so a profile timezone offset can never hide the meal.
        const dayMs = 24 * 60 * 60 * 1000;
        const start = new Date(Date.now() - dayMs).toISOString().slice(0, 10);
        const end = new Date(Date.now() + dayMs).toISOString().slice(0, 10);
        const history = await page.request.get(
            `/api/app/meals?start=${start}&end=${end}`,
        );
        expect(history.status(), "GET meal history").toBe(200);
        const historyBody = await history.json();
        const meal = (historyBody.meals ?? []).find(
            (entry: { description?: string }) =>
                entry.description?.includes(recipeName),
        );
        expect(meal, "the logged recipe meal").toBeTruthy();
        expect(meal.calories).toBe(301);

        // Module off: the option does not appear at all.
        await setFeatures(page, { ...ALL_ON, pantry: false });
        await page.goto("/app/recipes");
        const cardOff = page.locator(".recipe-panel", { hasText: recipeName });
        await expect(cardOff).toBeVisible();
        await cardOff.locator('[data-action="log-recipe"]').click();
        await expect(dialog.locator('input[name="from_pantry"]')).toHaveCount(
            0,
        );
        await expect(
            dialog.locator('input[name="servings_cooked"]'),
        ).toHaveCount(0);
        await dialog.locator(".dialog-close").click();
    } finally {
        await setFeatures(page, ALL_ON).catch(() => {});
    }
});
