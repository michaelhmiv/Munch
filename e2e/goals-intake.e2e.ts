import { expect, test, type Page } from "@playwright/test";

// Goals intake (goals intake brief) on the real server with the
// provisioned reviewer account. ONE sign-in drives the whole journey
// (the suite shares a sign-in rate-limit budget): the More page
// carries the Your goals card even with every feature module off
// (the intake is core context, never a toggle), the form saves the
// stated goal + answers through the real API, a reload shows them
// persisted, and clearing them back to "No answer" / blank persists
// as unset — the intake is skippable end to end.

const ALL_ON = {
    plan: true,
    recipes: true,
    groceries: true,
    pantry: true,
    cooks: true,
};
const ALL_OFF = {
    plan: false,
    recipes: false,
    groceries: false,
    pantry: false,
    cooks: false,
};
const EMPTY_INTAKE = {
    stated_goal: null,
    activity_band: null,
    eating_pattern: null,
    hardest_meal: null,
    never_suggest: [],
    allergies: [],
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

async function putIntake(
    page: Page,
    intake: Record<string, unknown>,
): Promise<void> {
    const response = await page.request.put("/api/app/goals-intake", {
        headers: { origin: new URL(page.url()).origin },
        data: { intake },
    });
    expect(response.status(), "PUT /api/app/goals-intake").toBe(200);
}

async function getIntake(page: Page): Promise<Record<string, unknown>> {
    const response = await page.request.get("/api/app/goals-intake");
    expect(response.status(), "GET /api/app/goals-intake").toBe(200);
    const body = await response.json();
    return body.intake;
}

test("goals intake: More card is core, answers persist, clearing persists as unset", async ({
    page,
}) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    try {
        await setFeatures(page, ALL_ON);
        await putIntake(page, EMPTY_INTAKE);

        // The card survives every module being off — the intake is
        // context for the whole app, not a feature module.
        await setFeatures(page, ALL_OFF);
        await page.goto("/app/more");
        await expect(
            page.locator('a.more-card[href="/app/goals"]'),
        ).toBeVisible();
        await setFeatures(page, ALL_ON);

        await page.locator('a.more-card[href="/app/goals"]').click();
        await expect(page).toHaveURL(/\/app\/goals$/);
        const form = page.locator("#goals-intake-form");
        await expect(form).toBeVisible();

        await form
            .locator('textarea[name="stated_goal"]')
            .fill("Lower my fat intake at dinner");
        await form.getByText("30–60 min", { exact: true }).click();
        await form.getByText("A mix", { exact: true }).click();
        await form.getByText("Dinner", { exact: true }).click();
        await form
            .locator('input[name="never_suggest"]')
            .fill("cilantro, protein shakes");
        await form
            .locator('input[name="allergies"]')
            .fill("peanuts, shellfish");
        await form.getByRole("button", { name: "Save" }).click();
        await expect(form.locator(".settings-save-status")).toHaveText("Saved");

        // The API round-trip carries exactly what the form sent.
        expect(await getIntake(page)).toEqual({
            stated_goal: "Lower my fat intake at dinner",
            activity_band: "30_to_60",
            eating_pattern: "mix",
            hardest_meal: "dinner",
            never_suggest: ["cilantro", "protein shakes"],
            allergies: ["peanuts", "shellfish"],
        });

        // A fresh page load renders the persisted answers.
        await page.goto("/app/goals");
        await expect(
            page.locator('#goals-intake-form textarea[name="stated_goal"]'),
        ).toHaveValue("Lower my fat intake at dinner");
        await expect(
            page.locator('input[name="activity_band"][value="30_to_60"]'),
        ).toBeChecked();
        await expect(
            page.locator('input[name="hardest_meal"][value="dinner"]'),
        ).toBeChecked();
        await expect(
            page.locator('#goals-intake-form input[name="allergies"]'),
        ).toHaveValue("peanuts, shellfish");

        // Clearing is a first-class state: No answer + blank fields
        // save back to fully unset.
        const clearedForm = page.locator("#goals-intake-form");
        await clearedForm.locator('textarea[name="stated_goal"]').fill("");
        await clearedForm
            .locator('input[name="activity_band"][value=""]')
            .check({ force: true });
        await clearedForm.locator('input[name="never_suggest"]').fill("");
        await clearedForm.locator('input[name="allergies"]').fill("");
        await clearedForm.getByRole("button", { name: "Save" }).click();
        await expect(clearedForm.locator(".settings-save-status")).toHaveText(
            "Saved",
        );
        const cleared = await getIntake(page);
        expect(cleared.stated_goal).toBeNull();
        expect(cleared.activity_band).toBeNull();
        expect(cleared.never_suggest).toEqual([]);
        expect(cleared.allergies).toEqual([]);
    } finally {
        await putIntake(page, EMPTY_INTAKE).catch(() => {});
        await setFeatures(page, ALL_ON).catch(() => {});
    }
});
