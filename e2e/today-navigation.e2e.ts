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

async function setDailyCalorieTarget(page: Page, dailyCalories: number) {
    // The real goals surface (PUT /api/app/goals, the same call the
    // settings goals form makes): confirm is required, and every
    // other target is sent blank so this journey's rendering depends
    // on exactly this one target and nothing an earlier suite left.
    const response = await page.request.put("/api/app/goals", {
        headers: { origin: new URL(page.url()).origin },
        data: {
            confirm: true,
            idempotency_key: `today-nav-range-e2e-goals-${dailyCalories}`,
            daily_calories: dailyCalories,
            daily_protein_g: null,
            daily_carbs_g: null,
            daily_fat_g: null,
            daily_fiber_g: null,
            daily_sugar_g: null,
            daily_alcohol_g: null,
            daily_water_ml: null,
        },
    });
    expect(response.status(), "PUT /api/app/goals").toBe(200);
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

    // This journey sets its own calorie target: the on-target line
    // asserted below exists only when a daily target is set, and no
    // other suite member sets one for the reviewer account. 2,000
    // kcal is a ceiling every seeded day sits under (500 / 400 /
    // 700), so the fully logged two-day span reads 2 of 2 on target.
    await setDailyCalorieTarget(page, 2000);

    // Four-day span, three days seeded (the second project run
    // re-seeds the same idempotency keys, so every assertion below
    // must already hold with all three meals in place).
    const today = new Date().toISOString().slice(0, 10);
    const start = shiftDay(today, -60);
    const middle = shiftDay(today, -59);
    const empty = shiftDay(today, -58);
    const end = shiftDay(today, -57);
    await seedMeal(page, start, "Range seed alpha", "lunch", [
        {
            name: "Range chicken",
            nutrients: { calories: 500, protein_g: 40, carbs_g: 20, fat_g: 10 },
        },
    ]);
    await seedMeal(page, middle, "Range seed middle", "breakfast", [
        {
            name: "Range eggs",
            nutrients: {
                calories: 400,
                protein_g: 130,
                carbs_g: 10,
                fat_g: 20,
            },
        },
    ]);
    await seedMeal(page, end, "Range seed beta", "dinner", [
        {
            name: "Range rice",
            nutrients: { calories: 700, protein_g: 30, carbs_g: 60, fat_g: 15 },
        },
    ]);

    // The range payload: exact totals for the seeded span, judged
    // over the three logged days of the four.
    const payload = await (
        await page.request.get(`/api/app/today/range?start=${start}&end=${end}`)
    ).json();
    expect(payload.aggregate.days).toBe(4);
    expect(payload.aggregate.daysWithMeals).toBe(3);
    expect(payload.aggregate.macros.calories.total).toBe(1600);
    expect(payload.aggregate.macros.calories.dailyAverage).toBe(533.3);
    expect(payload.days[2].date).toBe(empty);
    expect(payload.days[2].meals).toHaveLength(0);

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
    await expect(page.locator(".range-bar")).toContainText("4 days");
    const caloriesTile = page.locator('.macro-tile[data-macro="calories"]');
    await expect(caloriesTile).toContainText("1,600");
    await expect(caloriesTile).toContainText("avg 533");
    // QC-gate F2: the average divides by the 3 LOGGED days, not the
    // 4 calendar days, and the tile discloses that basis in itself
    // (÷4 would read 400 — the undisclosed line read as wrong). The
    // exact average-line grammar is pinned in the unit tests; here
    // the tile must carry the disclosure (and, with the calorie
    // target this journey set in its own setup above, the signed
    // delta form).
    await expect(caloriesTile).toContainText("per logged day");
    // The micro tiles disclose on the same rule.
    await page.locator('[data-action="toggle-micros"]').click();
    await expect(page.locator("#today-micros")).toContainText("per logged day");
    await page.locator('[data-action="toggle-micros"]').click();
    // No on-target line: one day of the four is unlogged.
    await expect(caloriesTile).not.toContainText("On target");

    // Reopening the calendar paints the committed span as one band:
    // solid endpoints, the days between in the soft-green well, and
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
    await expect(dialog.locator(".cal-range-row")).toContainText("4 days");
    // QC-gate F1: with a committed range painted, range mode is
    // active in the sheet, so the header toggle reads ON — pressed,
    // filled with direction C's primary green — not the transparent
    // outline secondary. And the note row carries no duplicate
    // "Clear range" (clearing lives in the range bar's ✕ Clear).
    await expect(rangeToggle).toHaveAttribute("aria-pressed", "true");
    await expect
        .poll(() =>
            rangeToggle.evaluate((el) => getComputedStyle(el).backgroundColor),
        )
        .toBe("rgb(23, 107, 58)");
    await expect(
        dialog.locator('[data-action="calendar-clear-range"]'),
    ).toHaveCount(0);
    await page.screenshot({
        path: `${CAPTURE_DIR}/calendar-range-390.png`,
    });
    await dialog.locator('[data-action="close-dialog"]').click();
    await expect(dialog).toBeHidden();

    // Days collapse to one row each; the unlogged day reads honestly.
    const emptyRow = page.locator(
        `[data-action="toggle-range-day"][data-date="${empty}"]`,
    );
    await expect(emptyRow).toContainText("No meals logged");
    await expect(page.locator(`#range-day-detail-${empty}`)).toContainText(
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

    // The on-target line appears only when every day in the range
    // is logged (frame 4's rule): re-pick the fully logged two-day
    // span start → middle. Both days are under the calorie ceiling.
    await page.locator('[data-action="open-calendar"]').click();
    await dialog.locator('[data-action="calendar-range-mode"]').click();
    await dialog.locator(`.cal-day[data-date="${start}"]`).click();
    await dialog.locator(`.cal-day[data-date="${middle}"]`).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".range-bar")).toContainText("2 days");
    await expect(caloriesTile).toContainText("On target · 2 of 2 days");
    // Fully logged span: logged days ARE the calendar days, so the
    // average line keeps the undisclosed form (QC-gate F2 choice).
    await expect(caloriesTile).not.toContainText("per logged day");
    await page.screenshot({
        path: `${CAPTURE_DIR}/range-on-target-390.png`,
    });

    // Clear returns to the single-day view of today. The range bar's
    // ✕ Clear is the only clear-range action in the app (QC-gate F1
    // removed the calendar note row's duplicate).
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

    // QC-gate F3, frame (a): the hierarchy from the TOP of the
    // surface — heading, range bar, tiles, and the collapsed month
    // rows in frame. (The previous capture was mid-scroll, with the
    // top of the surface out of frame.)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect(page.locator(".today-view .page-heading h2")).toBeInViewport();
    await expect(page.locator(".range-bar")).toBeInViewport();
    await page.screenshot({ path: `${CAPTURE_DIR}/hierarchy-390.png` });

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
    const endDetail = page.locator(`#range-day-detail-${end}`);
    await expect(endDetail).toContainText("Hierarchy seed beta");
    // QC-gate F3, frame (b): scroll so the expanded day's meals sit
    // FULLY above the bottom nav (the previous capture let the nav
    // occlude them) — align the detail's bottom edge to just above
    // the nav, keeping the day row and its nesting in frame — and
    // prove it geometrically before shooting.
    await endDetail.evaluate((el) => {
        const nav = document.querySelector(".mobile-bottom-nav");
        if (!nav) return;
        const detailRect = el.getBoundingClientRect();
        const navRect = nav.getBoundingClientRect();
        // Instant, not the page's smooth scroll: the geometry proof
        // below must measure the settled position.
        window.scrollBy({
            top: detailRect.bottom - navRect.top + 6,
            behavior: "instant",
        });
    });
    const navBox = await page.locator(".mobile-bottom-nav").boundingBox();
    expect(navBox, "bottom nav has a box").not.toBeNull();
    await expect
        .poll(async () => {
            const box = await endDetail.boundingBox();
            return box ? box.y + box.height : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(navBox!.y + 1);
    const detailBox = await endDetail.boundingBox();
    expect(detailBox!.y).toBeGreaterThanOrEqual(0);
    await page.screenshot({
        path: `${CAPTURE_DIR}/hierarchy-expanded-390.png`,
    });
});
