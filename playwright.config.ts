import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
    testDir: "./e2e",
    testMatch: "**/*.e2e.ts",
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? "line" : "list",
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [
        {
            name: "desktop-chromium",
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "mobile-chromium",
            use: { ...devices["Pixel 7"] },
        },
    ],
    webServer: {
        command: "bun run start",
        url: baseURL + "/health/live",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
    },
});
