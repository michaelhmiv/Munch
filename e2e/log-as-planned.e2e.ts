import { expect, test, type Page, type TestInfo } from "@playwright/test";

// Log as planned (connection option #1) on the real server with a
// provisioned reviewer account. Each project signs in as its OWN
// account (MUNCH_REVIEWER_EMAIL_DESKTOP / _MOBILE, provisioned in
// CI; the shared MUNCH_REVIEWER_* pair is the local fallback): this
// journey rewrites the account's profile timezone, and the server's
// evening-prompt rule reads that timezone — so when the desktop and
// mobile instances run in parallel on one shared account, one
// instance's timezone writes land inside the other's legs and swap
// the very buttons (Log as planned vs Log it / Swap / Skip) it is
// asserting on. Per-project accounts keep the two instances — and
// every other journey on the shared account — out of each other's
// timezone entirely.
//  - a meal planned for today offers Log as planned on Today; the
//    confirm step carries the planned servings, editable; logging
//    lands the meal in Today's meals and the planned row reads
//    Logged with no second log offered;
//  - the Plan view card reads Logged too, with Swap gone;
//  - in a timezone where it is evening, a second unlogged planned
//    meal shows the prompt row (Log it / Swap / Skip) and Skip
//    retires the prompt back to the plain Log as planned button.
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

function dateInZone(zone: string): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

function hourInZone(zone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour: "numeric",
        hourCycle: "h23",
    }).formatToParts(new Date());
    return Number(parts.find((part) => part.type === "hour")?.value ?? 0);
}

async function setTimezone(page: Page, timezone: string) {
    const response = await page.request.put("/api/app/preferences", {
        headers: { origin: new URL(page.url()).origin },
        data: { timezone },
    });
    expect(response.status(), "PUT /api/app/preferences").toBe(200);
}

async function seedPlannedRecipe(
    page: Page,
    name: string,
    stamp: number,
    plannedDate: string,
) {
    const seeded = await page.request.post("/api/app/recipes", {
        headers: { origin: new URL(page.url()).origin },
        data: {
            idempotency_key: `log-as-planned-e2e-recipe-${stamp}-${name.length}`,
            recipe: {
                name,
                servings: 2,
                source_type: "user_entered",
                instructions: ["Cook the rice.", "Sear the salmon."],
                ingredients: [
                    {
                        name: `E2E salmon ${stamp}`,
                        quantity: 2,
                        unit: "fillets",
                        source_type: "user_supplied",
                        source_snapshot: { entered_by_user: true },
                        nutrients: {
                            calories: 400,
                            protein_g: 44,
                            carbs_g: 0,
                            fat_g: 24,
                        },
                    },
                    {
                        name: `E2E rice ${stamp}`,
                        quantity: 300,
                        unit: "g",
                        source_type: "user_supplied",
                        source_snapshot: { entered_by_user: true },
                        nutrients: {
                            calories: 390,
                            protein_g: 8,
                            carbs_g: 84,
                            fat_g: 1,
                        },
                    },
                ],
            },
        },
    });
    expect(seeded.status(), "seed recipe").toBe(200);
    const body = (await seeded.json()) as {
        result: { recipeId: string };
    };
    const planned = await page.request.post(
        `/api/app/recipes/${body.result.recipeId}/plan`,
        {
            headers: { origin: new URL(page.url()).origin },
            data: {
                planned_date: plannedDate,
                meal_slot: "dinner",
                servings: 2,
                idempotency_key: `log-as-planned-e2e-plan-${stamp}-${name.length}`,
            },
        },
    );
    expect(planned.status(), "plan recipe for today").toBe(200);
}

test("planned meals log as planned once, read Logged, and prompt in the evening", async ({
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

    const stamp = Date.now();
    await setTimezone(page, "UTC");
    const recipeName = `E2E Log Planned ${stamp}`;
    await seedPlannedRecipe(page, recipeName, stamp, dateInZone("UTC"));

    // ---- Today: Log as planned -> confirm (servings editable) -> Logged.
    await page.goto("/app");
    const plannedRow = page.locator(".food-row", { hasText: recipeName });
    await expect(plannedRow).toBeVisible();
    await plannedRow.getByRole("button", { name: "Log as planned" }).click();
    const dialog = page.locator("#app-dialog");
    await expect(
        dialog.getByRole("heading", { name: `Log ${recipeName} as planned` }),
    ).toBeVisible();
    const servingsInput = dialog.getByLabel("Servings eaten");
    await expect(servingsInput).toHaveValue("2");
    await servingsInput.fill("1");
    await dialog.getByRole("button", { name: "Log meal" }).click();

    await expect(plannedRow.locator(".macro-chip")).toHaveText("Logged");
    await expect(
        plannedRow.getByRole("button", { name: "Log as planned" }),
    ).toHaveCount(0);
    const loggedMeal = page.locator(".meal-card", { hasText: recipeName });
    await expect(loggedMeal.first()).toBeVisible();

    // ---- Plan view: the card reads Logged and offers no second log.
    await page.goto("/app/plan");
    const planCard = page.locator(".plan-meal-card", {
        hasText: recipeName,
    });
    await expect(planCard).toBeVisible();
    await expect(planCard.locator(".meal-meta")).toContainText("Logged");
    await expect(
        planCard.getByRole("button", { name: "Log as planned" }),
    ).toHaveCount(0);
    await expect(
        planCard.getByRole("button", { name: "Swap recipe" }),
    ).toHaveCount(0);

    // ---- Evening: an unlogged plan for today prompts Log it / Swap /
    // Skip; Skip retires the prompt to the plain button.
    const eveningZone = [
        "Pacific/Auckland",
        "Australia/Sydney",
        "Asia/Tokyo",
        "Asia/Dubai",
        "Europe/London",
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
        "Pacific/Honolulu",
    ].find((zone) => {
        const hour = hourInZone(zone);
        return hour >= 18 && hour <= 22;
    });
    expect(eveningZone, "an evening timezone exists right now").toBeTruthy();
    const eveningName = `E2E Log Planned Evening ${stamp}`;
    await setTimezone(page, eveningZone!);
    await seedPlannedRecipe(
        page,
        eveningName,
        stamp + 1,
        dateInZone(eveningZone!),
    );
    // Re-assert the evening timezone right before reading Today:
    // this account is ours alone (see the header note), so the
    // prompt check reads exactly the timezone set above.
    await setTimezone(page, eveningZone!);
    await page.goto("/app");
    const eveningRow = page.locator(".food-row", { hasText: eveningName });
    await expect(eveningRow).toBeVisible();
    await expect(
        eveningRow.getByRole("button", { name: "Log it" }),
    ).toBeVisible();
    await expect(
        eveningRow.getByRole("button", { name: "Swap", exact: true }),
    ).toBeVisible();
    await eveningRow.getByRole("button", { name: "Skip" }).click();
    await expect(
        eveningRow.getByRole("button", { name: "Log it" }),
    ).toHaveCount(0);
    await expect(
        eveningRow.getByRole("button", { name: "Log as planned" }),
    ).toBeVisible();

    await setTimezone(page, "UTC");
});
