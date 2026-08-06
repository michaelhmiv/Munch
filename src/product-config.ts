export const PRODUCT_CONFIG = Object.freeze({
    name: "Munch",
    publicBaseUrl: "https://munch.business",
    premiumPriceMonthlyUsd: 4.99,
    trialEnabled: false,
    freeTierEnabled: true,
    freeHistoryDays: 30,
    freeSavedFoodLimit: 25,
    householdMemberLimit: 6,
    supportEmail: "support@munch.business",
    privacyEmail: "support@munch.business",
    legalEmail: "support@munch.business",
    securityEmail: "security@munch.business",
});

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
    "$4.99",
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
    return `$${PRODUCT_CONFIG.premiumPriceMonthlyUsd.toFixed(2)}`;
}
