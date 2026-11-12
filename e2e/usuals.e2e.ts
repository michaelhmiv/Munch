import { expect, test, type Page } from "@playwright/test";

// "Your usuals" in the Add meal composer, on the real server with the
// provisioned reviewer account (one sign-in): a food logged three
// times in the same meal slot and day class surfaces with its median
// portion and one tap adds it to the draft; a one-off food never
// surfaces; yesterday's same-slot meal offers "Same as yesterday".
// Captures go to test-results/usuals-captures.

const CAPTURE_DIR = "test-results/usuals-captures";

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

async function seedMeal(
    page: Page,
    date: string,
    description: string,
    mealType: string,
    items: {
        name: string;
        quantity: number;
        portionLabel: string;
        nutrients: Record<string, number>;
    }[],
) {
    const response = await page.request.post("/api/app/meals", {
        headers: { origin: new URL(page.url()).origin },
        data: {
            description,
            meal_type: mealType,
            logged_at: `${date}T12:00:00.000Z`,
            idempotency_key: `usuals-e2e-${description}`,
            items: items.map((item) => ({
                name: item.name,
                quantity: item.quantity,
                portion_label: item.portionLabel,
                nutrients: item.nutrients,
                source_type: "user_supplied",
            })),
        },
    });
    expect(response.status(), `seed meal ${description}`).toBe(200);
}

function shiftDay(date: string, days: number): string {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function isWeekend(date: string): boolean {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    return day === 0 || day === 6;
}

/** The `count` most recent dates before `today` sharing today's day class. */
function sameClassDates(today: string, count: number): string[] {
    const weekend = isWeekend(today);
    const dates: string[] = [];
    for (let back = 1; dates.length < count && back < 21; back += 1) {
        const candidate = shiftDay(today, -back);
        if (isWeekend(candidate) === weekend) dates.push(candidate);
    }
    return dates;
}

test("usuals surface the habitual breakfast at its median portion, one-offs stay hidden, yesterday's lunch copies", async ({
    page,
}) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = shiftDay(today, -1);

    // The habitual breakfast: the same food on three earlier days of
    // today's day class, always 2 × "1 container" at 150 kcal each, so
    // the usual must read 2 × 1 container / 300 kcal.
    for (const [index, date] of sameClassDates(today, 3).entries()) {
        await seedMeal(
            page,
            date,
            `Usuals e2e breakfast ${index}`,
            "breakfast",
            [
                {
                    name: "Usuals e2e yogurt",
                    quantity: 2,
                    portionLabel: "1 container",
                    nutrients: { calories: 150, protein_g: 17 },
                },
            ],
        );
    }
    // A one-off dinner: below the three-log threshold, never a usual.
    await seedMeal(page, yesterday, "Usuals e2e pasta night", "dinner", [
        {
            name: "Usuals e2e pasta",
            quantity: 1,
            portionLabel: "1 plate",
            nutrients: { calories: 640 },
        },
    ]);
    // Yesterday's lunch, for "Same as yesterday".
    await seedMeal(page, yesterday, "Usuals e2e yesterday lunch", "lunch", [
        {
            name: "Usuals e2e soup",
            quantity: 1,
            portionLabel: "1 bowl",
            nutrients: { calories: 320 },
        },
        {
            name: "Usuals e2e bread",
            quantity: 2,
            portionLabel: "1 slice",
            nutrients: { calories: 80 },
        },
    ]);

    await page.getByRole("button", { name: "Add meal" }).first().click();
    const form = page.locator("#meal-form");
    await expect(form).toBeVisible();

    // Default slot is lunch: yesterday's lunch earns the copy
    // affordance, and copying adds its items to the draft.
    const yesterdayButton = page.getByRole("button", {
        name: "Same as yesterday",
    });
    await expect(yesterdayButton).toBeVisible();
    const itemsBefore = await page
        .locator("#meal-selected-items [data-composer-index]")
        .count();
    await yesterdayButton.click();
    await expect
        .poll(() =>
            page.locator("#meal-selected-items [data-composer-index]").count(),
        )
        .toBeGreaterThan(itemsBefore);

    // Breakfast: the habitual yogurt surfaces at its median portion.
    await page
        .locator('#meal-form select[name="meal_type"]')
        .selectOption("breakfast");
    const usualRow = page.locator('[data-action="select-meal-usual"]', {
        hasText: "Usuals e2e yogurt",
    });
    await expect(usualRow).toBeVisible();
    await expect(usualRow).toContainText("2 × 1 container");
    await expect(usualRow).toContainText("300 kcal");
    await page.screenshot({
        path: `${CAPTURE_DIR}/usuals-breakfast.png`,
        fullPage: true,
    });

    // One tap adds it to the draft at the usual portion, editable
    // like any other draft item.
    await usualRow.click();
    const added = page
        .locator("#meal-selected-items [data-composer-index]")
        .filter({ hasText: "Usuals e2e yogurt" });
    await expect(added).toHaveCount(1);
    await expect(added).toContainText("From your usuals");
    await expect(added.locator('[data-composer-field="name"]')).toHaveValue(
        "Usuals e2e yogurt",
    );
    await expect(added.locator('[data-composer-field="quantity"]')).toHaveValue(
        "2",
    );
    await expect(
        added.locator('[data-composer-field="portion_label"]'),
    ).toHaveValue("1 container");

    // Dinner: the one-off pasta is not a usual, and the breakfast
    // usual does not leak across slots.
    await page
        .locator('#meal-form select[name="meal_type"]')
        .selectOption("dinner");
    await expect(page.locator("#meal-usuals")).not.toContainText(
        "Usuals e2e pasta",
    );
    await expect(page.locator("#meal-usuals")).not.toContainText(
        "Usuals e2e yogurt",
    );
});
