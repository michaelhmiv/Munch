import { expect, test, type Page } from "@playwright/test";

// Today navigation (brief items 1–6) on the real server with the
// provisioned reviewer account: the calendar icon replaces the day
// buttons, dots come from one month-summary request per displayed
// month, the 2x2 macro tiles open the meal→ingredient breakdown
// sheet, and History is reached through its two doors. Captures go
// to the munch-today-navigation-captures CI artifact.

const CAPTURE_DIR = "test-results/today-navigation-captures";

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
    items: { name: string; nutrients: Record<string, number> }[],
) {
    const response = await page.request.post("/api/app/meals", {
        headers: { origin: new URL(page.url()).origin },
        data: {
            description,
            meal_type: mealType,
            logged_at: `${date}T12:00:00.000Z`,
            idempotency_key: `today-nav-e2e-${description}`,
            items: items.map((item) => ({
                name: item.name,
                quantity: 1,
                portion_label: "1 serving",
                gram_weight: 100,
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

test("calendar replaces the day buttons, dots mark logged days, macros break down by ingredient, History has two doors", async ({
    page,
}) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    const today = new Date().toISOString().slice(0, 10);
    const target = shiftDay(today, -3);
    const targetMonth = target.slice(0, 7);
    await seedMeal(page, target, "Nav seed bowl", "lunch", [
        {
            name: "Grilled chicken",
            nutrients: {
                calories: 248,
                protein_g: 46,
                carbs_g: 0,
                fat_g: 5,
                sodium_mg: 74,
            },
        },
        {
            name: "Jasmine rice",
            nutrients: {
                calories: 222,
                protein_g: 4,
                carbs_g: 45,
                fat_g: 1,
                sodium_mg: 4,
            },
        },
    ]);

    // The month summary itself: the seeded day is present with its
    // meal counted, and it names at least one genuinely empty day in
    // the same month to check the no-dot state against.
    const summaryResponse = await page.request.get(
        `/api/app/calendar/month?month=${targetMonth}`,
    );
    expect(summaryResponse.status()).toBe(200);
    const summary = await summaryResponse.json();
    const dottedDates = new Set(
        (summary.days as { date: string }[]).map((day) => day.date),
    );
    expect(dottedDates.has(target)).toBe(true);
    const [targetYear, targetMon] = targetMonth.split("-").map(Number);
    const nextMonthFirst =
        targetMon === 12
            ? `${targetYear + 1}-01-01`
            : `${targetYear}-${String(targetMon + 1).padStart(2, "0")}-01`;
    const monthLength = Number(shiftDay(nextMonthFirst, -1).slice(8, 10));
    const emptyDay = Array.from(
        { length: monthLength },
        (_, i) => `${targetMonth}-${String(i + 1).padStart(2, "0")}`,
    ).find((date) => !dottedDates.has(date) && date !== today);
    expect(emptyDay, "an empty day exists in the target month").toBeTruthy();

    const monthRequests: string[] = [];
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/api/app/calendar/month") {
            monthRequests.push(url.searchParams.get("month") ?? "");
        }
    });

    // Item 1: the header carries the calendar icon (beside Trends)
    // and no Previous / Today / Next buttons; the filler subtitle is
    // gone (addendum 9).
    const heading = page.locator(".today-view .page-heading");
    await expect(
        heading.locator('[data-action="open-calendar"]'),
    ).toBeVisible();
    await expect(heading.locator('[data-action="open-trends"]')).toBeVisible();
    for (const name of ["Previous", "Today", "Next"]) {
        await expect(
            heading.getByRole("button", { name, exact: true }),
        ).toHaveCount(0);
    }
    await expect(heading.getByText("structured nutrition record")).toHaveCount(
        0,
    );

    // Items 4+6: six bottom-nav destinations at phone width.
    const nav = page.locator(".mobile-bottom-nav");
    await expect(nav.locator("a")).toHaveCount(6);
    await expect(nav.locator('a[href="/app/recipes"]')).toBeVisible();
    await expect(nav.locator('a[href="/app/log"]')).toHaveCount(0);
    await expect(nav.locator('a[href="/app/cooks"]')).toHaveCount(0);

    // Item 5: the 2x2 tile grid is Today's macros block now.
    await expect(page.locator(".macro-tile")).toHaveCount(4);
    await page.screenshot({ path: `${CAPTURE_DIR}/today-390.png` });

    // Items 1–3: open the calendar, step to the seeded month, and
    // check the dot states. One summary request per displayed month;
    // stepping back to a seen month refetches nothing.
    await heading.locator('[data-action="open-calendar"]').click();
    const dialog = page.locator("#app-dialog");
    await expect(dialog.locator(".cal-grid")).toBeVisible();
    const monthsBack =
        (Number(today.slice(0, 4)) - Number(target.slice(0, 4))) * 12 +
        (Number(today.slice(5, 7)) - Number(target.slice(5, 7)));
    for (let i = 0; i < monthsBack; i++) {
        await dialog.locator('[data-action="calendar-prev-month"]').click();
    }
    const dottedCell = dialog.locator(`.cal-day[data-date="${target}"]`);
    await expect(dottedCell.locator(".cal-dot")).toHaveCount(1);
    await expect(
        dialog.locator(`.cal-day[data-date="${emptyDay}"] .cal-dot`),
    ).toHaveCount(0);
    // Today is highlighted in its own month; the viewed day (today)
    // starts selected.
    await expect(dottedCell).toBeVisible();
    const fetchedMonths = new Set(monthRequests);
    expect(fetchedMonths.size).toBe(monthRequests.length);
    const fetchesBeforeReturn = monthRequests.length;
    for (let i = 0; i < monthsBack; i++) {
        await dialog.locator('[data-action="calendar-next-month"]').click();
    }
    if (monthsBack > 0) {
        // Back in the current month — served from the cache.
        expect(monthRequests.length).toBe(fetchesBeforeReturn);
        for (let i = 0; i < monthsBack; i++) {
            await dialog.locator('[data-action="calendar-prev-month"]').click();
        }
        expect(monthRequests.length).toBe(fetchesBeforeReturn);
    }
    await page.screenshot({ path: `${CAPTURE_DIR}/calendar-390.png` });

    // Item 1: tapping the dotted day lands Today on that date — the
    // one canonical day view — with the day's meals rendered.
    await dottedCell.click();
    await expect(page.locator("#app-content")).toContainText("Nav seed bowl");
    await expect(page.locator(".today-view .page-heading h2")).toContainText(
        new Intl.DateTimeFormat("en-US", {
            month: "long",
            timeZone: "UTC",
        }).format(new Date(`${target}T12:00:00Z`)),
    );

    // Item 5: the Protein tile opens the breakdown sheet — the meal
    // subtotal, each ingredient's own contribution, and the day
    // total pinned at the foot; the page behind never reflows.
    await page.locator('.macro-tile[data-macro="protein"]').click();
    await expect(dialog).toContainText("Nav seed bowl");
    await expect(dialog).toContainText("Grilled chicken");
    await expect(dialog).toContainText("Jasmine rice");
    await expect(dialog.locator(".macro-sheet-foot")).toContainText(
        "Day total",
    );
    await expect(dialog.locator(".macro-sheet-foot")).toContainText("50 g");
    await page.screenshot({
        path: `${CAPTURE_DIR}/breakdown-sheet-390.png`,
    });
    await dialog.locator('[data-action="close-dialog"]').click();

    // The Micronutrients expand sums the day's items (74 + 4 mg).
    await page.locator('[data-action="toggle-micros"]').click();
    await expect(page.locator("#today-micros")).toBeVisible();
    await expect(page.locator("#today-micros")).toContainText("78 mg");

    // Item 6, door (a): the calendar sheet's Search history row.
    await page.locator('[data-action="open-calendar"]').click();
    await dialog.locator('[data-action="calendar-history"]').click();
    await expect(page).toHaveURL(/\/app\/log$/);
    await expect(page).toHaveTitle(/^History — Munch$/);
    await expect(page.locator("#meal-history-search")).toBeVisible();

    // Item 6, door (b): the More list — History and Cooks are there,
    // Recipes is not (it holds a nav slot now).
    await page.goto("/app/more");
    await expect(page.locator('.more-card[href="/app/log"]')).toBeVisible();
    await expect(page.locator('.more-card[href="/app/cooks"]')).toBeVisible();
    await expect(page.locator('.more-card[href="/app/recipes"]')).toHaveCount(
        0,
    );
    await expect
        .poll(() =>
            page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        )
        .toBe(true);
});

test("future day renders the Planned projection; an unplanned future day is honestly empty", async ({
    page,
}) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    const today = new Date().toISOString().slice(0, 10);
    const future = shiftDay(today, 6);
    const emptyFuture = shiftDay(today, 13);
    const origin = { origin: new URL(page.url()).origin };

    // Seed a recipe with known per-serving nutrition and plan two
    // servings of it on the future day.
    const recipeResponse = await page.request.post("/api/app/recipes", {
        headers: origin,
        data: {
            idempotency_key: "forward-view-e2e-soup",
            recipe: {
                name: "Forward View Soup",
                servings: 1,
                instructions: ["Simmer everything for 20 minutes."],
                source_type: "user_entered",
                ingredients: [
                    {
                        name: "Vegetable stock",
                        quantity: 4,
                        unit: "cups",
                        nutrients: {
                            calories: 300,
                            protein_g: 10,
                            carbs_g: 40,
                            fat_g: 12,
                        },
                        source_type: "user_supplied",
                        source_snapshot: { entered_by_user: true },
                    },
                ],
            },
        },
    });
    expect(recipeResponse.status(), "seed recipe").toBe(200);
    const created = await recipeResponse.json();
    const planResponse = await page.request.post(
        `/api/app/recipes/${created.recipe.id}/plan`,
        {
            headers: origin,
            data: {
                planned_date: future,
                meal_slot: "dinner",
                servings: 2,
                idempotency_key: "forward-view-e2e-plan",
            },
        },
    );
    expect(planResponse.status(), "plan recipe").toBe(200);

    // The day payload: future days carry the projection (300 kcal × 2
    // servings), today carries none — actuals only, as before.
    const futureDay = await (
        await page.request.get(`/api/app/today?date=${future}`)
    ).json();
    expect(futureDay.plannedProjection.totals.calories).toBe(600);
    expect(futureDay.plannedProjection.totals.proteinG).toBe(20);
    expect(futureDay.plannedProjection.partial).toBe(false);
    const todayDay = await (
        await page.request.get(`/api/app/today?date=${today}`)
    ).json();
    expect(todayDay.plannedProjection).toBeNull();

    // Navigate through the calendar to the future day.
    const monthsBetween = (from: string, to: string) =>
        (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
        (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
    const dialog = page.locator("#app-dialog");
    const goToDay = async (fromMonthDate: string, target: string) => {
        await page.locator('[data-action="open-calendar"]').click();
        await expect(dialog.locator(".cal-grid")).toBeVisible();
        const steps = monthsBetween(fromMonthDate, target);
        for (let i = 0; i < steps; i++) {
            await dialog.locator('[data-action="calendar-next-month"]').click();
        }
        await dialog.locator(`.cal-day[data-date="${target}"]`).click();
    };

    await goToDay(today, future);
    await expect(page.locator(".day-kind-chip")).toHaveText("Planned");
    await expect(
        page.locator('.macro-tile[data-macro="calories"]'),
    ).toContainText("600");
    await expect(page.locator("#app-content")).toContainText(
        "Forward View Soup",
    );
    await expect(page.locator("#app-content")).toContainText("Planned meals");
    // A future day has no Next up compose and no logged-meals grammar.
    await expect(page.locator('[data-testid="next-up"]')).toHaveCount(0);
    await page.screenshot({ path: `${CAPTURE_DIR}/future-planned-390.png` });

    await goToDay(future, emptyFuture);
    await expect(page.locator(".day-kind-chip")).toHaveText("Planned");
    await expect(page.locator("#app-content")).toContainText(
        "Nothing planned for this day",
    );
    await expect(page.locator(".macro-tile")).toHaveCount(0);
});

test("calendar range re-bases Today: totals over the span, meals grouped by day, clear returns to a single day", async ({
    page,
}) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    const today = new Date().toISOString().slice(0, 10);
    const start = shiftDay(today, -60);
    const middle = shiftDay(today, -59);
    const end = shiftDay(today, -58);
    await seedMeal(page, start, "Range seed alpha", "lunch", [
        {
            name: "Range chicken",
            nutrients: { calories: 500, protein_g: 40, carbs_g: 20, fat_g: 10 },
        },
    ]);
    await seedMeal(page, end, "Range seed beta", "dinner", [
        {
            name: "Range rice",
            nutrients: { calories: 700, protein_g: 30, carbs_g: 60, fat_g: 15 },
        },
    ]);

    // The range payload: exact totals for the seeded span, judged
    // over the two logged days of the three.
    const payload = await (
        await page.request.get(`/api/app/today/range?start=${start}&end=${end}`)
    ).json();
    expect(payload.aggregate.days).toBe(3);
    expect(payload.aggregate.daysWithMeals).toBe(2);
    expect(payload.aggregate.macros.calories.total).toBe(1200);
    expect(payload.aggregate.macros.calories.dailyAverage).toBe(600);
    expect(payload.days[1].date).toBe(middle);
    expect(payload.days[1].meals).toHaveLength(0);

    // Hotel-style picking, entered through the sheet header's Range
    // toggle (a plain tap still means "that day" until it is on):
    // first tap anchors with the start stated, second tap commits.
    const dialog = page.locator("#app-dialog");
    await page.locator('[data-action="open-calendar"]').click();
    await expect(dialog.locator(".cal-grid")).toBeVisible();
    const rangeToggle = dialog.locator('[data-action="calendar-range-mode"]');
    await expect(rangeToggle).toHaveText("Range");
    await expect(rangeToggle).toHaveAttribute("aria-pressed", "false");
    await rangeToggle.click();
    await expect(rangeToggle).toHaveAttribute("aria-pressed", "true");
    const monthsBack =
        (Number(today.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
        (Number(today.slice(5, 7)) - Number(start.slice(5, 7)));
    for (let i = 0; i < monthsBack; i++) {
        await dialog.locator('[data-action="calendar-prev-month"]').click();
    }
    await dialog.locator(`.cal-day[data-date="${start}"]`).click();
    await expect(dialog.locator(".cal-range-row")).toContainText("Start");
    await dialog.locator(`.cal-day[data-date="${end}"]`).click();
    await expect(dialog).toBeHidden();

    await expect(page.locator(".today-view .page-heading h2")).toContainText(
        "–",
    );
    // The range bar carries the full label and the day count; the
    // tile re-bases to the range total with a per-day average line.
    await expect(page.locator(".range-bar")).toContainText("3 days");
    const caloriesTile = page.locator('.macro-tile[data-macro="calories"]');
    await expect(caloriesTile).toContainText("1,200");
    await expect(caloriesTile).toContainText("avg 600");

    // Reopening the calendar paints the committed span as one band:
    // solid endpoints, the day between in the soft-green well, and
    // the note row naming the span. (Today sits on the range start,
    // so the sheet opens on the span's own month.)
    await page.locator('[data-action="open-calendar"]').click();
    await expect(dialog.locator(`.cal-day[data-date="${start}"]`)).toHaveClass(
        /is-range-start/,
    );
    await expect(dialog.locator(`.cal-day[data-date="${middle}"]`)).toHaveClass(
        /is-in-range/,
    );
    await expect(dialog.locator(`.cal-day[data-date="${end}"]`)).toHaveClass(
        /is-range-end/,
    );
    await expect(dialog.locator(".cal-range-row")).toContainText("3 days");
    await page.screenshot({
        path: `${CAPTURE_DIR}/calendar-range-390.png`,
    });
    await dialog.locator('[data-action="close-dialog"]').click();
    await expect(dialog).toBeHidden();
    // Days collapse to one row each; the middle day reads honestly.
    const middleRow = page.locator(
        `[data-action="toggle-range-day"][data-date="${middle}"]`,
    );
    await expect(middleRow).toContainText("No meals logged");
    await expect(page.locator(`#range-day-detail-${middle}`)).toContainText(
        "No meals logged.",
    );
    // Expanding a logged day reveals its meals in place.
    const startRow = page.locator(
        `[data-action="toggle-range-day"][data-date="${start}"]`,
    );
    await startRow.click();
    await expect(startRow).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`#range-day-detail-${start}`)).toContainText(
        "Range seed alpha",
    );
    await expect(page.locator(`#range-day-detail-${end}`)).toBeHidden();
    await page.screenshot({ path: `${CAPTURE_DIR}/range-390.png` });

    // Clear returns to the single-day view of today. (Scoped to the
    // range bar: the closed calendar sheet keeps its own Clear range
    // button in the dialog DOM.)
    await page
        .locator('.range-bar [data-action="calendar-clear-range"]')
        .click();
    await expect(page.locator(".range-bar")).toHaveCount(0);
    await expect(
        page.locator('.macro-tile[data-macro="calories"]'),
    ).toBeVisible();
});

test("mixed range keeps actuals and planned projections apart, each labeled", async ({
    page,
}) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    const today = new Date().toISOString().slice(0, 10);
    const pastDay = shiftDay(today, -1);
    const futureDay = shiftDay(today, 2);
    const origin = { origin: new URL(page.url()).origin };
    await seedMeal(page, pastDay, "Mixed range logged", "lunch", [
        {
            name: "Mixed chicken",
            nutrients: { calories: 400, protein_g: 35, carbs_g: 10, fat_g: 12 },
        },
    ]);
    const recipeResponse = await page.request.post("/api/app/recipes", {
        headers: origin,
        data: {
            idempotency_key: "range-mixed-e2e-soup",
            recipe: {
                name: "Range Mixed Soup",
                servings: 1,
                instructions: ["Simmer everything for 20 minutes."],
                source_type: "user_entered",
                ingredients: [
                    {
                        name: "Vegetable stock",
                        quantity: 4,
                        unit: "cups",
                        nutrients: {
                            calories: 300,
                            protein_g: 10,
                            carbs_g: 40,
                            fat_g: 12,
                        },
                        source_type: "user_supplied",
                        source_snapshot: { entered_by_user: true },
                    },
                ],
            },
        },
    });
    expect(recipeResponse.status(), "seed recipe").toBe(200);
    const created = await recipeResponse.json();
    const planResponse = await page.request.post(
        `/api/app/recipes/${created.recipe.id}/plan`,
        {
            headers: origin,
            data: {
                planned_date: futureDay,
                meal_slot: "dinner",
                servings: 2,
                idempotency_key: "range-mixed-e2e-plan",
            },
        },
    );
    expect(planResponse.status(), "plan recipe").toBe(200);

    const payload = await (
        await page.request.get(
            `/api/app/today/range?start=${pastDay}&end=${futureDay}`,
        )
    ).json();
    const futureEntry = payload.days.find(
        (day: { date: string }) => day.date === futureDay,
    );
    // The future day carries NO actuals — only its projection. The
    // aggregate keeps planned and actual apart: each aggregate total
    // is exactly the sum of its own kind across the days (the
    // reviewer seed may add planned meals of its own inside the
    // window, so absolutes belong to the per-day assertions).
    expect(futureEntry.totals.calories).toBe(0);
    expect(futureEntry.plannedProjection.totals.calories).toBe(600);
    const sumOf = (
        pick: (day: {
            totals: { calories: number };
            plannedProjection: { totals: { calories: number } } | null;
        }) => number,
    ) => payload.days.reduce((sum: number, day: never) => sum + pick(day), 0);
    expect(payload.aggregate.macros.calories.total).toBe(
        sumOf((day) => day.totals.calories),
    );
    expect(payload.aggregate.plannedTotals.calories).toBe(
        sumOf((day) => day.plannedProjection?.totals.calories ?? 0),
    );
    expect(payload.aggregate.plannedTotals.calories).toBeGreaterThanOrEqual(
        600,
    );
    const pastEntry = payload.days.find(
        (day: { date: string }) => day.date === pastDay,
    );
    expect(pastEntry.meals.length).toBeGreaterThan(0);
    expect(pastEntry.plannedProjection).toBeNull();

    // The UI keeps the same line (approved rendering, frame 4): a
    // split row over the tiles, a Logged · Planned line on each
    // tile, no on-target claim, and Planned tags on the future days.
    const dialog = page.locator("#app-dialog");
    await page.locator('[data-action="open-calendar"]').click();
    await dialog.locator('[data-action="calendar-range-mode"]').click();
    const monthsBack =
        (Number(today.slice(0, 4)) - Number(pastDay.slice(0, 4))) * 12 +
        (Number(today.slice(5, 7)) - Number(pastDay.slice(5, 7)));
    for (let i = 0; i < monthsBack; i++) {
        await dialog.locator('[data-action="calendar-prev-month"]').click();
    }
    await dialog.locator(`.cal-day[data-date="${pastDay}"]`).click();
    const monthsForward =
        (Number(futureDay.slice(0, 4)) - Number(pastDay.slice(0, 4))) * 12 +
        (Number(futureDay.slice(5, 7)) - Number(pastDay.slice(5, 7)));
    for (let i = 0; i < monthsForward; i++) {
        await dialog.locator('[data-action="calendar-next-month"]').click();
    }
    await dialog.locator(`.cal-day[data-date="${futureDay}"]`).click();
    await expect(dialog).toBeHidden();

    const split = page.locator(".range-split");
    await expect(split).toContainText("Logged");
    await expect(split).toContainText("Planned");
    await expect(split).toContainText("kcal");
    const caloriesTile = page.locator('.macro-tile[data-macro="calories"]');
    await expect(caloriesTile).toContainText("Logged");
    await expect(caloriesTile).toContainText("Planned");
    await expect(caloriesTile).not.toContainText("On target");
    await expect(
        page.locator(".panel-title", { hasText: "Meals" }),
    ).toContainText("planned");
    const futureRow = page.locator(
        `[data-action="toggle-range-day"][data-date="${futureDay}"]`,
    );
    await expect(futureRow.locator(".day-tag.planned")).toHaveText("Planned");
    await page.screenshot({ path: `${CAPTURE_DIR}/mixed-range-390.png` });
});

test("long range nests month → week → day, and every level reconciles", async ({
    page,
}) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    const today = new Date().toISOString().slice(0, 10);
    const end = shiftDay(today, -35);
    const start = shiftDay(end, -40);
    await seedMeal(page, start, "Hierarchy seed alpha", "lunch", [
        {
            name: "Hierarchy chicken",
            nutrients: { calories: 500, protein_g: 40, carbs_g: 20, fat_g: 10 },
        },
    ]);
    await seedMeal(page, end, "Hierarchy seed beta", "dinner", [
        {
            name: "Hierarchy rice",
            nutrients: { calories: 700, protein_g: 30, carbs_g: 60, fat_g: 15 },
        },
    ]);

    // Reconciliation is asserted on the payload itself: each month
    // is the sum of its weeks, each week the sum of its days, and
    // the months sum to the aggregate's actual total.
    const payload = await (
        await page.request.get(`/api/app/today/range?start=${start}&end=${end}`)
    ).json();
    expect(payload.aggregate.days).toBe(41);
    expect(payload.hierarchy.length).toBeGreaterThanOrEqual(2);
    let hierarchyTotal = 0;
    for (const month of payload.hierarchy) {
        const weekSum = month.weeks.reduce(
            (sum: number, week: { calories: number }) => sum + week.calories,
            0,
        );
        const daySum = month.weeks
            .flatMap((week: { days: { calories: number }[] }) => week.days)
            .reduce(
                (sum: number, day: { calories: number }) => sum + day.calories,
                0,
            );
        expect(weekSum).toBe(month.calories);
        expect(daySum).toBe(month.calories);
        hierarchyTotal += month.calories;
    }
    expect(hierarchyTotal).toBe(payload.aggregate.macros.calories.total);

    // Drive the calendar: toggle Range on, anchor at the start,
    // step forward to the end month, commit.
    const dialog = page.locator("#app-dialog");
    await page.locator('[data-action="open-calendar"]').click();
    await dialog.locator('[data-action="calendar-range-mode"]').click();
    const monthsBack =
        (Number(today.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
        (Number(today.slice(5, 7)) - Number(start.slice(5, 7)));
    for (let i = 0; i < monthsBack; i++) {
        await dialog.locator('[data-action="calendar-prev-month"]').click();
    }
    await dialog.locator(`.cal-day[data-date="${start}"]`).click();
    const monthsForward =
        (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
        (Number(end.slice(5, 7)) - Number(start.slice(5, 7)));
    for (let i = 0; i < monthsForward; i++) {
        await dialog.locator('[data-action="calendar-next-month"]').click();
    }
    await dialog.locator(`.cal-day[data-date="${end}"]`).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".range-bar")).toContainText("41 days");

    // Months start collapsed; open the last month, then its last
    // week, then the seeded end day — each level in place.
    const monthRows = page.locator('[data-action="toggle-range-month"]');
    await expect(monthRows.first()).toBeVisible();
    const lastMonth = monthRows.last();
    await lastMonth.click();
    await expect(lastMonth).toHaveAttribute("aria-expanded", "true");
    // Weeks are scoped to the opened month: earlier months' week
    // rows stay hidden behind their collapsed month rows.
    const monthDetailId = await lastMonth.getAttribute("aria-controls");
    const weekRows = page.locator(
        `#${monthDetailId} [data-action="toggle-range-week"]`,
    );
    await expect(weekRows.first()).toBeVisible();
    const lastWeek = weekRows.last();
    await lastWeek.click();
    const endRow = page.locator(
        `[data-action="toggle-range-day"][data-date="${end}"]`,
    );
    await expect(endRow).toBeVisible();
    await endRow.click();
    await expect(page.locator(`#range-day-detail-${end}`)).toContainText(
        "Hierarchy seed beta",
    );
    await page.screenshot({ path: `${CAPTURE_DIR}/hierarchy-390.png` });
});
