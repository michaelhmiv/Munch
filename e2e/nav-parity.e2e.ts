import { expect, test, type Page } from "@playwright/test";

// Bottom-bar metric parity (design-authority-addendum-motion rule 1):
// the app shell (public/app.html) and the standalone Pantry page
// (public/pantry.html) each ship a copy of .mobile-bottom-nav. The
// Pantry copy once referenced custom properties defined nowhere in
// its stylesheet and inherited a different font stack/line-height,
// so tapping Pantry shrank the bar 78.59px -> 75.94px. This spec
// measures the computed metrics of both copies in a real browser and
// requires them to be identical.

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
}

type BarMetrics = {
    navHeight: number;
    columns: string;
    background: string;
    borderTop: string;
    anchorHeight: number;
    fontFamily: string;
    fontSize: string;
    lineHeight: string;
    inactiveColor: string;
};

async function measureBar(page: Page): Promise<BarMetrics> {
    return page.evaluate(() => {
        const nav = document.querySelector(".mobile-bottom-nav");
        if (!nav) throw new Error("bottom nav missing");
        const anchors = [...nav.querySelectorAll("a")];
        const inactive =
            anchors.find((a) => !a.classList.contains("is-active")) ||
            anchors[0];
        const navCs = getComputedStyle(nav);
        const aCs = getComputedStyle(inactive);
        return {
            navHeight: nav.getBoundingClientRect().height,
            columns: navCs.gridTemplateColumns,
            background: navCs.backgroundColor,
            borderTop: `${navCs.borderTopWidth} ${navCs.borderTopStyle} ${navCs.borderTopColor}`,
            anchorHeight: inactive.getBoundingClientRect().height,
            fontFamily: aCs.fontFamily,
            fontSize: aCs.fontSize,
            lineHeight: aCs.lineHeight,
            inactiveColor: aCs.color,
        };
    });
}

test.use({ viewport: { width: 390, height: 844 } });

test("the Pantry bottom bar is metric-identical to the shell's", async ({
    page,
}) => {
    await signIn(page);
    await page.waitForSelector(".mobile-bottom-nav a");
    const shell = await measureBar(page);

    await page.goto("/app/pantry");
    await page.waitForSelector(".mobile-bottom-nav a");
    const pantry = await measureBar(page);

    expect(pantry.navHeight).toBeCloseTo(shell.navHeight, 1);
    expect(pantry.anchorHeight).toBeCloseTo(shell.anchorHeight, 1);
    expect(pantry.columns).toBe(shell.columns);
    expect(pantry.background).toBe(shell.background);
    expect(pantry.borderTop).toBe(shell.borderTop);
    expect(pantry.fontFamily).toBe(shell.fontFamily);
    expect(pantry.fontSize).toBe(shell.fontSize);
    expect(pantry.lineHeight).toBe(shell.lineHeight);
    expect(pantry.inactiveColor).toBe(shell.inactiveColor);
});
