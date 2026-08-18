import { afterEach, describe, expect, test } from "bun:test";
import { configurationIssues } from "./config.js";

const original = { ...process.env };
afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
});

function validEnvironment() {
    Object.assign(process.env, {
        NODE_ENV: "production",
        MUNCH_APP_BASE_URL: "https://munch.example",
        BETTER_AUTH_SECRET: "b".repeat(64),
        RESEND_API_KEY: "re_test_key",
        MUNCH_EMAIL_FROM: "Munch <support@munch.example>",
        STRIPE_SECRET_KEY: "sk_test_example",
        STRIPE_WEBHOOK_SECRET: "whsec_example",
        STRIPE_PRICE_ID: "price_example",
        STRIPE_HOUSEHOLD_MEMBER_PRICE_ID: "price_household_example",
        OFF_USER_AGENT: "Munch (support@example.com)",
        USDA_FDC_API_KEY: "usda-example",
        DATABASE_URL: "postgresql://example",
        MUNCH_DB_POOL_SIZE: "10",
    });
}

describe("Munch startup configuration", () => {
    test("accepts canonical Better Auth + Railway PostgreSQL configuration", () => {
        validEnvironment();
        expect(configurationIssues()).toEqual([]);
    });

    test("always requires Railway PostgreSQL", () => {
        validEnvironment();
        delete process.env.DATABASE_URL;
        expect(configurationIssues()).toContainEqual(
            expect.objectContaining({ key: "DATABASE_URL" }),
        );
    });

    test("rejects an insecure or pathful production origin", () => {
        validEnvironment();
        process.env.MUNCH_APP_BASE_URL = "http://munch.example/path";
        expect(configurationIssues()).toContainEqual(
            expect.objectContaining({ key: "MUNCH_APP_BASE_URL" }),
        );
    });

    test("requires Better Auth and Resend configuration", () => {
        validEnvironment();
        delete process.env.BETTER_AUTH_SECRET;
        delete process.env.RESEND_API_KEY;
        delete process.env.MUNCH_EMAIL_FROM;
        const keys = configurationIssues().map((issue) => issue.key);
        expect(keys).toContain("BETTER_AUTH_SECRET");
        expect(keys).toContain("RESEND_API_KEY");
        expect(keys).toContain("MUNCH_EMAIL_FROM");
    });

    test("requires provider and billing configuration", () => {
        validEnvironment();
        delete process.env.USDA_FDC_API_KEY;
        delete process.env.STRIPE_WEBHOOK_SECRET;
        delete process.env.STRIPE_HOUSEHOLD_MEMBER_PRICE_ID;
        const keys = configurationIssues().map((issue) => issue.key);
        expect(keys).toContain("USDA_FDC_API_KEY");
        expect(keys).toContain("STRIPE_WEBHOOK_SECRET");
        expect(keys).toContain("STRIPE_HOUSEHOLD_MEMBER_PRICE_ID");
    });
});
