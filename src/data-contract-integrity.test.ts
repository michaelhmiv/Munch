import { describe, expect, test } from "bun:test";
import {
    FREE_HISTORY_DAYS,
    FREE_SAVED_FOOD_LIMIT,
} from "./billing/capabilities.js";
import {
    HOUSEHOLD_MEMBER_MONTHLY_CENTS,
    MAX_ADDITIONAL_HOUSEHOLD_MEMBERS,
    PREMIUM_MONTHLY_CENTS,
    householdMonthlyTotalCents,
} from "./billing/household-seats.js";
import { PRODUCT_CONFIG } from "./product-config.js";

describe("single-source product policy", () => {
    test("capability aliases resolve from PRODUCT_CONFIG", () => {
        expect(FREE_HISTORY_DAYS).toBe(PRODUCT_CONFIG.freeHistoryDays);
        expect(FREE_SAVED_FOOD_LIMIT).toBe(PRODUCT_CONFIG.freeSavedFoodLimit);
    });

    test("billing aliases and arithmetic resolve from PRODUCT_CONFIG", () => {
        expect(PREMIUM_MONTHLY_CENTS).toBe(
            PRODUCT_CONFIG.premiumPriceMonthlyCents,
        );
        expect(HOUSEHOLD_MEMBER_MONTHLY_CENTS).toBe(
            PRODUCT_CONFIG.householdMemberPriceMonthlyCents,
        );
        expect(MAX_ADDITIONAL_HOUSEHOLD_MEMBERS).toBe(
            PRODUCT_CONFIG.householdMemberLimit - 1,
        );
        expect(householdMonthlyTotalCents(3)).toBe(
            PRODUCT_CONFIG.premiumPriceMonthlyCents +
                3 * PRODUCT_CONFIG.householdMemberPriceMonthlyCents,
        );
    });

    test(
        "legacy billing renderer cannot silently drift from product policy",
        async () => {
            const source = await Bun.file("public/app-account.js").text();
            expect(source).toContain(
                String(PRODUCT_CONFIG.premiumPriceMonthlyCents),
            );
            expect(source).toContain(
                String(PRODUCT_CONFIG.householdMemberPriceMonthlyCents),
            );
            expect(source).toContain(
                `$${(PRODUCT_CONFIG.premiumPriceMonthlyCents / 100).toFixed(2)}`,
            );
            expect(source).toContain(
                `$${(PRODUCT_CONFIG.householdMemberPriceMonthlyCents / 100).toFixed(2)}`,
            );
        },
    );
});

describe("website data-contract surfaces", () => {
    test("Foods is retired from navigation and legacy URL redirects", async () => {
        const html = await Bun.file("public/app.html").text();
        const adapter = await Bun.file("public/app-integrity.js").text();
        expect(html).not.toContain('data-route="foods"');
        expect(html).toContain('src="/app-integrity.js"');
        expect(adapter).toContain('location.pathname === "/app/foods"');
        expect(adapter).toContain('location.replace("/app/log")');
    });

    test(
        "Insights visibly binds targets to the canonical goals contract",
        async () => {
            const adapter = await Bun.file("public/app-integrity.js").text();
            expect(adapter).toContain(
                'requestPath(args[0]) === "/api/app/insights"',
            );
            expect(adapter).toContain(
                'card.dataset.goalSource = "nutrition_goals"',
            );
            expect(adapter).toContain("latestInsights?.goals");
        },
    );
});
