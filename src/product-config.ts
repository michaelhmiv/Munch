export const PRODUCT_CONFIG = Object.freeze({
    name: "Munch",
    publicBaseUrl: "https://munch.business",
    premiumPriceMonthlyCents: 299,
    householdMemberPriceMonthlyCents: 200,
    // No free trial is offered (Michael, 2026-11-13: "no 7 day free
    // trial anymore — so much free stuff is offered now"). Checkout
    // never passed trial parameters itself; the trial previously lived
    // as a default on the Stripe price and is removed there separately.
    // Subscriptions already trialing when the offer ended are
    // grandfathered: entitlement code still honors the "trialing"
    // status until each existing trial runs out.
    trialEnabled: false,
    freeTierEnabled: true,
    freeHistoryDays: 30,
    householdMemberLimit: 6,
    googlePlayPackageName: "business.munch.app",
    googlePlayPremiumProductId: "munch_premium_monthly",
    googlePlayPremiumBasePlanId: "monthly",
    supportEmail: "support@munch.business",
    privacyEmail: "support@munch.business",
    legalEmail: "support@munch.business",
    securityEmail: "security@munch.business",
});

export interface PublicProductPolicy {
    premiumPriceMonthlyCents: number;
    householdMemberPriceMonthlyCents: number;
    freeHistoryDays: number;
    householdMemberLimit: number;
}

export function getPublicProductPolicy(): PublicProductPolicy {
    return {
        premiumPriceMonthlyCents: PRODUCT_CONFIG.premiumPriceMonthlyCents,
        householdMemberPriceMonthlyCents:
            PRODUCT_CONFIG.householdMemberPriceMonthlyCents,
        freeHistoryDays: PRODUCT_CONFIG.freeHistoryDays,
        householdMemberLimit: PRODUCT_CONFIG.householdMemberLimit,
    };
}

export const PROTECTED_COMMERCE_TERMS = Object.freeze([
    "start free trial",
    "free trial",
    "trial period",
    "trial ends",
    "subscribe to continue",
    "subscription required",
    "upgrade to continue",
    "upgrade your plan",
    "premium required",
    "premium plan",
    "premium subscription",
    "stripe checkout",
    "billing portal",
    "pricing plan",
    "$2.99",
]);

export const PROTECTED_COMMERCE_PATHS = Object.freeze([
    "public/login.html",
    "public/oauth-login.html",
    "src/auth/connect-routes.ts",
    "src/auth/email.ts",
    "src/accounts/login-delivery.ts",
    "src/mcp.ts",
    "src/mcp-runtime.ts",
    "src/*-tools.ts",
    "src/**/*-tools.ts",
    "public/widgets/**/*.{html,ts,js}",
]);

export function formatMonthlyPrice(): string {
    return `$${(PRODUCT_CONFIG.premiumPriceMonthlyCents / 100).toFixed(2)}`;
}

export function formatHouseholdMemberMonthlyPrice(): string {
    return `$${(PRODUCT_CONFIG.householdMemberPriceMonthlyCents / 100).toFixed(2)}`;
}
