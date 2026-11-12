import { expect, test, type Page } from "@playwright/test";

// Meal Duplicate (owner request, Nov 11): the meal card's Duplicate
// button used to be a stub toast pointing at the AI assistant. It now
// opens a dialog — quick-pick Today / Tomorrow or a picked date, the
// meal slot pre-set to the original's and changeable — and creates the
// copy through the server's verbatim meal copy (POST /api/app/meals/:id
// /copy). This journey proves, on the real server with the provisioned
// reviewer account (ONE sign-in — the suite shares a sign-in
// rate-limit budget):
//   1. Duplicate to tomorrow with the slot changed: the copy exists on
//      tomorrow with the new slot and items identical to the original
//      (names, quantities, portion labels, gram weights, nutrients).
//   2. Duplicate to a picked past date with the slot untouched: the
//      copy exists on that date with the original slot and items.
//   3. The original meal is byte-for-byte unchanged afterwards.
//   4. The pantry is untouched — a plain duplicate never draws stock
//      down (draw-down lives in the from-pantry log flow).

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

function shiftDay(date: string, days: number): string {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function apiHeaders(page: Page) {
    return { origin: new URL(page.url()).origin };
}

type MealItemProjection = {
    name: string;
    quantity: number | null;
    portionLabel: string | null;
    gramWeight: number | null;
    nutrients: Record<string, number>;
};

function itemProjection(meal: {
    items?: Array<Record<string, unknown>>;
}): MealItemProjection[] {
    return (meal.items ?? [])
        .map((item) => ({
            name: String(item.name),
            quantity: (item.quantity as number | null) ?? null,
            portionLabel: (item.portionLabel as string | null) ?? null,
            gramWeight: (item.gramWeight as number | null) ?? null,
            nutrients: (item.nutrients ?? {}) as Record<string, number>,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function getMeal(page: Page, id: string) {
    const response = await page.request.get(
        `/api/app/meals/${encodeURIComponent(id)}`,
        { headers: apiHeaders(page) },
    );
    expect(response.status(), `GET meal ${id}`).toBe(200);
    return (await response.json()).meal;
}

async function findMealOnDate(page: Page, date: string, description: string) {
    const response = await page.request.get(
        `/api/app/meals?start=${date}&end=${date}`,
        { headers: apiHeaders(page) },
    );
    expect(response.status(), `GET meals on ${date}`).toBe(200);
    const body = await response.json();
    const matches = (body.meals ?? []).filter(
        (meal: { description?: string }) => meal.description === description,
    );
    expect(matches.length, `exactly one "${description}" on ${date}`).toBe(1);
    return matches[0];
}

async function pantryItems(page: Page) {
    const response = await page.request.get("/api/app/pantry", {
        headers: apiHeaders(page),
    });
    expect(response.status(), "GET pantry").toBe(200);
    const body = await response.json();
    return body.items ?? [];
}

async function deleteMeal(page: Page, id: string) {
    await page.request.delete(`/api/app/meals/${encodeURIComponent(id)}`, {
        headers: apiHeaders(page),
    });
}

test("duplicate sends a meal to another day, exactly as logged, original and pantry untouched", async ({
    page,
}) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = shiftDay(today, 1);
    const pastDate = shiftDay(today, -7);
    const description = `Duplicate e2e chili ${Date.now()}`;
    const createdIds: string[] = [];

    try {
        // Seed the source meal on today as dinner, with a quantity-2
        // item so portion carry-over is actually exercised.
        const seedResponse = await page.request.post("/api/app/meals", {
            headers: apiHeaders(page),
            data: {
                description,
                meal_type: "dinner",
                logged_at: `${today}T12:00:00.000Z`,
                idempotency_key: `duplicate-e2e-${Date.now()}`,
                items: [
                    {
                        name: "Leftover chili",
                        quantity: 2,
                        portion_label: "1 bowl",
                        gram_weight: 240,
                        nutrients: {
                            calories: 320,
                            protein_g: 18,
                            carbs_g: 30,
                            fat_g: 14,
                            fiber_g: 9,
                            sodium_mg: 640,
                        },
                        source_type: "user_supplied",
                    },
                    {
                        name: "Cornbread",
                        quantity: 1,
                        portion_label: "1 piece",
                        gram_weight: 60,
                        nutrients: {
                            calories: 190,
                            protein_g: 4,
                            carbs_g: 28,
                            fat_g: 7,
                        },
                        source_type: "user_supplied",
                    },
                ],
            },
        });
        expect(seedResponse.status(), "seed source meal").toBe(200);
        const source = (await seedResponse.json()).meal;
        createdIds.push(source.id);

        const originalBefore = await getMeal(page, source.id);
        const originalItems = itemProjection(originalBefore);
        expect(originalItems).toHaveLength(2);
        const pantryBefore = await pantryItems(page);

        await page.goto("/app");
        const card = page.locator(
            `article.meal-card[data-meal-id="${source.id}"]`,
        );
        await expect(card).toBeVisible();
        const dialog = page.locator("#app-dialog");

        // --- Copy 1: Tomorrow quick-pick (the default), slot changed
        // from dinner to lunch.
        await card.locator('button[data-action="duplicate-meal"]').click();
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('[name="target_date"]')).toHaveValue(
            tomorrow,
        );
        await expect(dialog.locator('[name="meal_type"]')).toHaveValue(
            "dinner",
        );
        await dialog.locator('[name="meal_type"]').selectOption("lunch");
        await dialog.getByRole("button", { name: "Duplicate meal" }).click();
        await expect(
            page.locator(".toast", { hasText: "Duplicated to" }),
        ).toBeVisible();

        const copySummary = await findMealOnDate(page, tomorrow, description);
        createdIds.push(copySummary.id);
        const copy = await getMeal(page, copySummary.id);
        expect(copy.mealType).toBe("lunch");
        expect(String(copy.loggedAt).slice(0, 10)).toBe(tomorrow);
        expect(itemProjection(copy)).toEqual(originalItems);
        expect(copy.calories).toBe(originalBefore.calories);

        // --- Copy 2: a picked past date, slot left at the original's.
        await card.locator('button[data-action="duplicate-meal"]').click();
        await expect(dialog).toBeVisible();
        await dialog.locator('[name="target_date"]').fill(pastDate);
        // A hand-picked date that is neither quick-pick leaves both
        // quick-picks unselected — the highlight never claims a day the
        // field does not hold.
        await expect(
            dialog.locator('[data-action="duplicate-day-choice"].is-selected'),
        ).toHaveCount(0);
        await expect(dialog.locator('[name="meal_type"]')).toHaveValue(
            "dinner",
        );
        await dialog.getByRole("button", { name: "Duplicate meal" }).click();
        await expect(
            page.locator(".toast", { hasText: "Duplicated to" }),
        ).toBeVisible();

        const pastSummary = await findMealOnDate(page, pastDate, description);
        createdIds.push(pastSummary.id);
        const pastCopy = await getMeal(page, pastSummary.id);
        expect(pastCopy.mealType).toBe("dinner");
        expect(String(pastCopy.loggedAt).slice(0, 10)).toBe(pastDate);
        expect(itemProjection(pastCopy)).toEqual(originalItems);

        // --- The original is unchanged, and duplicating never touched
        // the pantry.
        expect(await getMeal(page, source.id)).toEqual(originalBefore);
        expect(await pantryItems(page)).toEqual(pantryBefore);
    } finally {
        for (const id of createdIds) {
            await deleteMeal(page, id);
        }
    }
});
