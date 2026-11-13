import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Recipe experience (R1–R3 + cross-work slice 3 photo import) on the
// real server with the provisioned reviewer account. ONE sign-in
// drives the whole journey (the suite shares a sign-in rate-limit
// budget):
//  R1 — a recipe seeded with plain typed lines shows its unmatchable
//       ingredient flagged "Not resolved"; Calculate nutrition writes
//       a new revision (the meta line moves to revision 2) and the
//       unmatchable ingredient stays flagged — never zeroed.
//  R3 — Add to grocery list reports added counts with a jump to the
//       list; a second pass reports merges, not duplicates.
//  R2 — Start cook opens cook mode: ingredient + step checklists,
//       the current step marked "Up next"; checks persist across a
//       close/reopen; checking the last step offers Log recipe and
//       Finish cook.
// Captures go to the munch-recipe-experience-captures CI artifact.
// Provider-dependent values (which real ingredients resolve under the
// DEMO_KEY pool) are deliberately NOT asserted — revision movement,
// flags, counts, and persistence are.

const CAPTURE_DIR = "test-results/recipe-experience-captures";
mkdirSync(CAPTURE_DIR, { recursive: true });

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

test("recipe heals visibly, stocks groceries with merge counts, and cooks in checklist mode", async ({
    page,
}) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    const features = await page.request.put("/api/app/features", {
        headers: { origin: new URL(page.url()).origin },
        data: { features: ALL_ON },
    });
    expect(features.status(), "PUT /api/app/features").toBe(200);

    // Seed the pre-resolver shape: plain typed lines saved through
    // the app API, one deliberately unmatchable, one optional.
    const stamp = Date.now();
    const recipeName = `E2E Heal Stew ${stamp}`;
    // Ingredient names are stamped too: the desktop and mobile
    // projects share this reviewer account within a job, and grocery
    // merging is by name+unit — unstamped names would merge into the
    // sibling project's list on the first pass.
    const butterName = `Zebra butter ${stamp}`;
    const milkName = `Zebra milk ${stamp}`;
    const flakesName = `Unobtainium flakes ${stamp}`;
    const oilName = `Zebra truffle oil ${stamp}`;
    const seeded = await page.request.post("/api/app/recipes", {
        headers: { origin: new URL(page.url()).origin },
        data: {
            idempotency_key: `recipe-experience-e2e-${stamp}`,
            recipe: {
                name: recipeName,
                servings: 2,
                source_type: "user_entered",
                instructions: [
                    "Brown the butter.",
                    "Stir in the milk.",
                    "Serve warm.",
                ],
                ingredients: [
                    {
                        name: butterName,
                        quantity: 0.5,
                        unit: "cup",
                        source_type: "user_supplied",
                    },
                    {
                        name: milkName,
                        quantity: 1,
                        unit: "cup",
                        source_type: "user_supplied",
                    },
                    {
                        name: flakesName,
                        quantity: 3,
                        unit: "cups",
                        source_type: "user_supplied",
                    },
                    {
                        name: oilName,
                        quantity: 1,
                        unit: "tbsp",
                        optional: true,
                        source_type: "user_supplied",
                    },
                ],
            },
        },
    });
    expect(seeded.status(), "seed recipe").toBe(200);

    // ---- Recipe detail: the new actions + the unresolved flag (R1).
    await page.goto("/app/recipes");
    const card = page.locator(".recipe-panel", { hasText: recipeName });
    await expect(card).toBeVisible();
    // Cross-work slice 2: the card strip is View · Log · Plan only —
    // "Add to grocery list" left the card; R3 lives on the detail
    // view (asserted below), which keeps its own grocery action.
    await expect(card.locator('[data-action="recipe-groceries"]')).toHaveCount(
        0,
    );
    await card.getByRole("button", { name: "View", exact: true }).click();
    const dialog = page.locator("#app-dialog");
    await expect(
        dialog.locator('[data-action="start-recipe-cook"]'),
    ).toBeVisible();
    await expect(
        dialog.locator('[data-action="recipe-groceries"]'),
    ).toBeVisible();
    const unobtainiumRow = dialog.locator(".recipe-ingredient-row", {
        hasText: flakesName,
    });
    await expect(unobtainiumRow.locator(".recipe-unresolved")).toHaveText(
        "Not resolved",
    );
    await expect(
        dialog.locator('[data-action="calculate-recipe-nutrition"]'),
    ).toBeVisible();
    await page.screenshot({
        path: `${CAPTURE_DIR}/recipe-detail-before-heal.png`,
    });

    // ---- R1: Calculate nutrition writes a NEW revision; the
    // unmatchable ingredient is still flagged afterwards.
    await dialog.locator('[data-action="calculate-recipe-nutrition"]').click();
    await expect(dialog.locator(".recipe-meta")).toContainText("revision 2");
    await expect(unobtainiumRow.locator(".recipe-unresolved")).toHaveText(
        "Not resolved",
    );
    await page.screenshot({
        path: `${CAPTURE_DIR}/recipe-detail-after-heal.png`,
    });

    // ---- R3: first pass adds, second pass merges.
    await dialog.locator('[data-action="recipe-groceries"]').click();
    const groceryForm = page.locator("#recipe-groceries-form");
    await expect(groceryForm).toBeVisible();
    await expect(groceryForm.locator('[name="servings"]')).toHaveValue("2");
    await groceryForm
        .getByRole("button", { name: "Add to grocery list" })
        .click();
    const firstToast = page.locator(".toast-action");
    await expect(firstToast).toContainText("3 items added");
    await firstToast.getByRole("button", { name: "View list" }).click();
    await expect(page).toHaveURL(/\/app\/groceries/);
    await expect(
        page.locator(".grocery-item-row", { hasText: butterName }),
    ).toHaveCount(1);

    await page.goto("/app/recipes");
    await page
        .locator(".recipe-panel", { hasText: recipeName })
        .getByRole("button", { name: "View", exact: true })
        .click();
    await dialog.locator('[data-action="recipe-groceries"]').click();
    await page
        .locator("#recipe-groceries-form")
        .getByRole("button", { name: "Add to grocery list" })
        .click();
    await expect(page.locator(".toast-action")).toContainText(
        "3 merged with items already on the list",
    );

    // ---- R2: cook mode.
    await page
        .locator(".recipe-panel", { hasText: recipeName })
        .getByRole("button", { name: "View", exact: true })
        .click();
    await dialog.locator('[data-action="start-recipe-cook"]').click();
    const cookMode = dialog.locator("[data-cook-mode]");
    await expect(cookMode).toBeVisible();
    await expect(cookMode.locator(".cook-mode-current-tag")).toHaveText(
        "Up next",
    );
    const ingredientBoxes = cookMode.locator(
        '.cook-mode-check[data-kind="ingredients"]',
    );
    const stepBoxes = cookMode.locator('.cook-mode-check[data-kind="steps"]');
    await expect(ingredientBoxes).toHaveCount(4);
    await expect(stepBoxes).toHaveCount(3);
    await ingredientBoxes.nth(0).check();
    await stepBoxes.nth(0).check();
    await expect(cookMode.locator("[data-cook-mode-progress]")).toContainText(
        "1 of 4 ingredients · 1 of 3 steps",
    );
    await page.screenshot({ path: `${CAPTURE_DIR}/cook-mode-mid.png` });

    // Persistence: close, reopen from the Cooks list, state survives.
    await page.locator(".dialog-close").click();
    await page.goto("/app/cooks");
    const cookCard = page.locator(".cook-card", { hasText: recipeName });
    await expect(cookCard).toBeVisible();
    await cookCard.locator('[data-action="open-cook"]').click();
    const reopened = dialog.locator("[data-cook-mode]");
    await expect(reopened).toBeVisible();
    await expect(
        reopened.locator('.cook-mode-check[data-kind="ingredients"]').nth(0),
    ).toBeChecked();
    await expect(
        reopened.locator('.cook-mode-check[data-kind="steps"]').nth(0),
    ).toBeChecked();
    await expect(reopened.locator("[data-cook-mode-progress]")).toContainText(
        "1 of 4 ingredients · 1 of 3 steps",
    );

    // Finishing the last step offers Log recipe + Finish cook.
    await reopened
        .locator('.cook-mode-check[data-kind="steps"]')
        .nth(1)
        .check();
    await reopened
        .locator('.cook-mode-check[data-kind="steps"]')
        .nth(2)
        .check();
    await expect(reopened.locator(".cook-mode-finish")).toContainText(
        "Every step is checked off.",
    );
    await expect(
        reopened
            .locator(".cook-mode-finish")
            .getByRole("button", { name: "Log recipe" }),
    ).toBeVisible();
    await expect(
        reopened
            .locator(".cook-mode-finish")
            .getByRole("button", { name: "Finish cook" }),
    ).toBeVisible();
    await page.screenshot({ path: `${CAPTURE_DIR}/cook-mode-finish.png` });
    await page.locator(".dialog-close").click();

    // ---- Cross-work slice 3: photo recipe import. The header shows
    // the three doors (Import · Photo · Create); the Photo door opens
    // the shared capture control; a fixture recipe-card photo lands
    // in the SAME import-review dialog as the URL importer,
    // populated and editable, with the partly-illegible warnings
    // visible; saving creates the recipe through the existing save
    // path. The vision read itself is intercepted with the recorded
    // fixture draft (the e2e job carries no OpenRouter key — the
    // recorded-response contract is covered by the ai-fixture lane);
    // the save below is the real API.
    const photoName = `E2E Photo Tomato Soup ${stamp}`;
    const photoDraft = {
        schema_version: 2,
        status: "partial",
        requires_review: true,
        parser: { strategy: "photo_vision", version: "photo-vision-1.0.0" },
        source: {
            submitted_url: null,
            final_url: null,
            canonical_url: null,
            title: null,
            site_name: null,
            author: null,
        },
        recipe: {
            name: photoName,
            servings: 1,
            instructions: ["Simmer everything for 30 minutes."],
            cooking_minutes: 30,
            source_type: "imported",
            ingredients: [
                {
                    name: "crushed tomatoes",
                    quantity: 2,
                    unit: "cup",
                    source_type: "model_estimate",
                    confidence: 0.93,
                    source_snapshot: { resolution_layer: "recipe_photo" },
                },
                {
                    name: "onion",
                    quantity: 1,
                    preparation: "diced",
                    source_type: "model_estimate",
                    confidence: 0.55,
                    source_snapshot: { resolution_layer: "recipe_photo" },
                },
            ],
        },
        nutrition: {
            status: "unavailable",
            total: {},
            per_serving: {},
        },
        ingredient_review: [
            {
                position: 0,
                raw_text: "2 cups crushed tomatoes",
                resolution: "assumed",
                candidates: [],
            },
            {
                position: 1,
                raw_text: "1 onion, diced",
                resolution: "assumed",
                candidates: [],
            },
        ],
        assumptions: [],
        warnings: [
            {
                code: "photo_text_uncertain",
                message: "The servings line is cut off in the photo.",
                severity: "warning",
            },
            {
                code: "photo_text_uncertain",
                message: "The onion quantity is smudged.",
                severity: "warning",
            },
        ],
    };
    await page.route("**/api/app/recipes/import-photo-preview", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                draft: photoDraft,
                transient_media: true,
                photo_retained: false,
            }),
        }),
    );
    await page.goto("/app/recipes");
    // Three doors must fit the phone width — the actions row wraps,
    // nothing clips off-screen.
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const doors = page.locator(".recipes-view .recipe-actions .button");
    await expect(doors).toHaveCount(3);
    await expect(doors.nth(0)).toHaveText("Import recipe from website");
    await expect(doors.nth(1)).toHaveText("Photo");
    await expect(doors.nth(2)).toHaveText("Create recipe");
    await page.screenshot({
        path: `${CAPTURE_DIR}/recipes-header-three-doors.png`,
    });
    await doors.nth(1).click();
    await expect(page.locator("#recipe-photo-file")).toBeAttached();
    await page
        .locator("#recipe-photo-file")
        .setInputFiles("e2e/fixtures/recipe-card-partly-illegible.png");
    await page.getByRole("button", { name: "Read recipe photo" }).click();
    const reviewDialog = page.locator("#app-dialog");
    await expect(reviewDialog.locator('input[name="name"]')).toHaveValue(
        photoName,
    );
    await expect(reviewDialog).toContainText("Review warnings");
    await expect(reviewDialog).toContainText(
        "The servings line is cut off in the photo.",
    );
    await expect(reviewDialog).toContainText("Recipe photo");
    // Editable before save: correct the servings the photo cut off.
    await reviewDialog.locator('input[name="servings"]').fill("4");
    await page.screenshot({
        path: `${CAPTURE_DIR}/recipe-photo-review.png`,
    });
    await reviewDialog
        .getByRole("button", { name: "Save imported recipe" })
        .click();
    await expect(page.locator(".toast")).toContainText(
        "Imported recipe saved.",
    );
    await page.unroute("**/api/app/recipes/import-photo-preview");
    await page.goto("/app/recipes");
    await expect(
        page.locator(".recipe-panel", { hasText: photoName }),
    ).toBeVisible();
});
