#!/usr/bin/env bun

process.env.MUNCH_RAILWAY_DATA_ENABLED = "true";
process.env.MUNCH_RAILWAY_AUTH_ENABLED = "true";
process.env.MUNCH_APP_BASE_URL = "https://munch.example";
process.env.MUNCH_SESSION_SECRET =
    "portal-smoke-session-secret-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_portal_smoke";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_portal_smoke";
process.env.STRIPE_PRICE_ID = "price_portal_smoke";
process.env.STRIPE_HOUSEHOLD_MEMBER_PRICE_ID = "price_household_portal_smoke";

const { Hono } = await import("hono");
const { createAccountRouter } = await import("../src/accounts/routes.js");
const { createAppRouter } = await import("../src/app/routes.js");
const { consumeLoginChallenge, createLoginChallenge } =
    await import("../src/accounts/repository.js");
const { MUNCH_SESSION_COOKIE } = await import("../src/accounts/session.js");
const { replaceSubscriptionItems, upsertSubscription } =
    await import("../src/billing/repository.js");
const {
    acceptHouseholdInvitation,
    createHousehold,
    createHouseholdInvitation,
} = await import("../src/households/repository.js");
const {
    authorizeSession,
    createAuthorizationSession,
    exchangeAuthorizationCode,
    issueAuthorizationCode,
    registerOAuthClient,
} = await import("../src/oauth-platform/repository.js");
const { codeChallengeForVerifier } =
    await import("../src/oauth-platform/pkce.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");
const { listOAuthConnections } = await import("../src/portal/repository.js");
const storage = await import("../src/storage.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for account app smoke tests");
}

async function createUser(prefix: string) {
    const challenge = await createLoginChallenge(
        `${prefix}-${crypto.randomUUID()}@example.test`,
    );
    const session = await consumeLoginChallenge(challenge.token);
    if (!session) throw new Error("Unable to activate account app smoke user");
    return { ...challenge, session };
}

const owner = await createUser("settings-owner");
const member = await createUser("settings-member");
const userId = owner.userId;

const stripeSubscriptionId = `sub_settings_${crypto.randomUUID().replaceAll("-", "")}`;
await upsertSubscription({
    userId,
    stripeSubscriptionId,
    stripePriceId: "price_portal_smoke",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
});
const household = await createHousehold({
    userId,
    name: "Settings Household",
    displayName: "Owner",
});
const invitation = await createHouseholdInvitation({
    userId,
    householdId: household.householdId,
    email: member.email,
    role: "member",
});
await acceptHouseholdInvitation({
    userId: member.userId,
    token: invitation.rawToken,
    displayName: "Member",
});
await replaceSubscriptionItems(stripeSubscriptionId, [
    {
        stripeSubscriptionItemId: "si_household_settings_smoke",
        stripePriceId: "price_household_portal_smoke",
        quantity: 1,
    },
]);
const pendingEmail = `pending-${crypto.randomUUID()}@example.test`;
await createHouseholdInvitation({
    userId,
    householdId: household.householdId,
    email: pendingEmail,
    role: "viewer",
});

const client = await registerOAuthClient({
    clientName: "Settings smoke client",
    redirectUris: ["http://127.0.0.1:4567/callback"],
    tokenEndpointAuthMethod: "none",
});
const verifier = "settings-smoke-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
const authorization = await createAuthorizationSession({
    clientId: client.clientId,
    redirectUri: client.redirectUris[0]!,
    state: "settings-smoke-state",
    codeChallenge: codeChallengeForVerifier(verifier),
});
if (!(await authorizeSession(authorization.id, userId))) {
    throw new Error("Unable to authorize settings smoke connection");
}
const code = await issueAuthorizationCode(authorization.id, userId);
await exchangeAuthorizationCode({
    code: code.code,
    clientId: client.clientId,
    redirectUri: client.redirectUris[0]!,
    codeVerifier: verifier,
});

await storage.upsertProfile(userId, {
    timezone: "America/New_York",
    preferred_weight_unit: "kg",
});
await storage.insertMeal(userId, {
    description: "Settings export smoke meal",
    meal_type: "lunch",
    calories: 500,
    protein_g: 30,
    carbs_g: 55,
    fat_g: 18,
    logged_at: "2026-08-03T18:00:00.000Z",
});
await storage.insertMeal(userId, {
    description: "Settings zero calorie boundary meal",
    meal_type: "snack",
    calories: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
    logged_at: "2026-08-05T03:30:00.000Z",
    notes: "This instant is August 4 at 11:30 p.m. in America/New_York.",
});

const app = new Hono();
app.route("/", createAccountRouter());
app.route("/", createAppRouter());
const ownerCookie = `${MUNCH_SESSION_COOKIE}=${owner.session.sessionToken}`;
const memberCookie = `${MUNCH_SESSION_COOKIE}=${member.session.sessionToken}`;
const mutationHeaders = {
    cookie: ownerCookie,
    origin: "https://munch.example",
    "content-type": "application/json",
};

const legacyPortal = await app.request("https://munch.example/account/portal", {
    headers: { cookie: ownerCookie },
});
if (
    legacyPortal.status !== 303 ||
    legacyPortal.headers.get("location") !== "/app/settings" ||
    legacyPortal.headers.get("cache-control") !== "private, no-store"
) {
    throw new Error(
        "Legacy account portal did not redirect into unified settings",
    );
}

for (const path of [
    "/app/settings",
    "/app/settings/profile",
    "/app/settings/goals",
    "/app/settings/billing",
    "/app/settings/connections",
    "/app/settings/data",
    "/app/settings/account",
    "/app/household",
    "/app/more",
]) {
    const response = await app.request(`https://munch.example${path}`, {
        headers: { cookie: ownerCookie },
    });
    if (
        response.status !== 200 ||
        !(await response.text()).includes("app-content")
    ) {
        throw new Error(`App shell route failed: ${path}`);
    }
}

const accountModule = await app.request("https://munch.example/app-account.js");
const accountCss = await app.request(
    "https://munch.example/account-settings.css",
);
if (
    accountModule.status !== 200 ||
    !accountModule.headers.get("content-type")?.includes("text/javascript") ||
    !(await accountModule.text()).includes("settings-profile-form") ||
    accountCss.status !== 200 ||
    !accountCss.headers.get("content-type")?.includes("text/css") ||
    !(await accountCss.text()).includes("@media (max-width: 620px)")
) {
    throw new Error(
        "Unified account module or responsive stylesheet is unavailable",
    );
}

const settingsResponse = await app.request(
    "https://munch.example/api/app/settings",
    { headers: { cookie: ownerCookie } },
);
if (settingsResponse.status !== 200) {
    throw new Error(`Settings API returned ${settingsResponse.status}`);
}
const settings = (await settingsResponse.json()) as any;
if (
    settings.user?.email !== owner.email ||
    settings.profile?.timezone !== "America/New_York" ||
    settings.capabilities?.tier !== "premium" ||
    settings.capabilities?.entitlementSource === "household_subscription" ||
    settings.connections?.length !== 1 ||
    settings.connections[0]?.clientName !== "Settings smoke client"
) {
    throw new Error(
        "Settings API omitted identity, entitlement, profile, or connection data",
    );
}

const householdResponse = await app.request(
    "https://munch.example/api/app/household/manage",
    { headers: { cookie: ownerCookie } },
);
if (householdResponse.status !== 200) {
    throw new Error(
        `Household management API returned ${householdResponse.status}`,
    );
}
const householdView = (await householdResponse.json()) as any;
if (
    householdView.household?.householdName !== "Settings Household" ||
    householdView.household?.role !== "owner" ||
    householdView.members?.length !== 2 ||
    householdView.activeNonOwnerCount !== 1 ||
    householdView.billedSeatQuantity !== 1 ||
    householdView.seatCoverage !== true ||
    householdView.canInvite !== true ||
    householdView.pendingInvitations?.length !== 1 ||
    householdView.pendingInvitations[0]?.email !== pendingEmail
) {
    throw new Error(
        "Household management API did not reconcile roster, billing, or pending invitations",
    );
}

const memberHouseholdResponse = await app.request(
    "https://munch.example/api/app/household/manage",
    { headers: { cookie: memberCookie } },
);
const memberHousehold = (await memberHouseholdResponse.json()) as any;
if (
    memberHouseholdResponse.status !== 200 ||
    memberHousehold.entitlementSource !== "household_subscription" ||
    memberHousehold.tier !== "premium" ||
    memberHousehold.pendingInvitations?.length !== 0 ||
    memberHousehold.household?.role !== "member"
) {
    throw new Error(
        "Household member view exposed owner-only data or lost inherited Premium",
    );
}

const preferences = await app.request(
    "https://munch.example/api/app/preferences",
    {
        method: "PUT",
        headers: mutationHeaders,
        body: JSON.stringify({
            timezone: "America/New_York",
            preferred_weight_unit: "lb",
            widgets_enabled: false,
            alcohol_tracking_enabled: true,
            preferred_drink_unit: "us",
        }),
    },
);
if (preferences.status !== 200) {
    throw new Error(`Settings preference save returned ${preferences.status}`);
}
const profile = await storage.getProfile(userId);
if (
    profile?.timezone !== "America/New_York" ||
    profile.preferred_weight_unit !== "lb" ||
    profile.widgets_enabled !== false ||
    profile.alcohol_tracking_enabled !== true ||
    profile.preferred_drink_unit !== "us"
) {
    throw new Error("Unified profile preferences were not persisted");
}

const goalsResponse = await app.request("https://munch.example/api/app/goals", {
    method: "PUT",
    headers: mutationHeaders,
    body: JSON.stringify({
        daily_calories: "2200",
        daily_protein_g: "160",
        daily_carbs_g: "210",
        daily_fat_g: "75",
        daily_fiber_g: "30",
        daily_sugar_g: "60",
        daily_water_ml: "3000",
        daily_alcohol_g: "0",
        target_weight: "190",
        unit: "lb",
    }),
});
if (goalsResponse.status !== 200) {
    throw new Error(`Nutrition target save returned ${goalsResponse.status}`);
}
const goals = await storage.getNutritionGoals(userId);
if (
    Number(goals?.daily_calories) !== 2200 ||
    Number(goals?.daily_protein_g) !== 160 ||
    Number(goals?.daily_water_ml) !== 3000 ||
    Number(goals?.target_weight_g) < 86100 ||
    Number(goals?.target_weight_g) > 86300
) {
    throw new Error("Expanded nutrition targets were not persisted correctly");
}

const connections = await listOAuthConnections(userId);
const tokenFamilyId = connections[0]?.tokenFamilyId;
if (!tokenFamilyId) throw new Error("Missing OAuth connection for revoke test");
const revokeResponse = await app.request(
    `https://munch.example/api/app/connections/${encodeURIComponent(tokenFamilyId)}`,
    {
        method: "DELETE",
        headers: mutationHeaders,
    },
);
if (
    revokeResponse.status !== 200 ||
    (await listOAuthConnections(userId)).length !== 0
) {
    throw new Error(
        "Unified Connections screen backend could not revoke access",
    );
}

const exportResponse = await app.request(
    "https://munch.example/account/portal/export",
    {
        method: "POST",
        headers: mutationHeaders,
        body: "{}",
    },
);
if (exportResponse.status !== 200) {
    throw new Error(`Account export returned ${exportResponse.status}`);
}
const exported = (await exportResponse.json()) as { url?: string };
if (!exported.url) throw new Error("Account export did not issue a URL");
const downloadResponse = await app.request(exported.url);
const exportDocument = JSON.parse(await downloadResponse.text()) as {
    meals?: Array<{ description?: string }>;
};
if (
    downloadResponse.status !== 200 ||
    downloadResponse.headers.get("cache-control") !== "private, no-store" ||
    !exportDocument.meals?.some(
        (meal) => meal.description === "Settings export smoke meal",
    )
) {
    throw new Error("Account export failed security or content checks");
}

const boundaryResponse = await app.request(
    "https://munch.example/account/portal/meals?date=2026-08-04",
    { headers: { cookie: ownerCookie } },
);
if (boundaryResponse.status !== 200) {
    throw new Error(
        `Compatibility meal history returned ${boundaryResponse.status}`,
    );
}
const boundary = (await boundaryResponse.json()) as {
    date: string;
    timezone: string;
    meals: Array<{
        description: string;
        calories: number | null;
        logged_at: string;
    }>;
};
const zeroMeal = boundary.meals.find(
    (meal) => meal.description === "Settings zero calorie boundary meal",
);
if (
    boundary.date !== "2026-08-04" ||
    boundary.timezone !== "America/New_York" ||
    zeroMeal?.calories !== 0 ||
    zeroMeal.logged_at !== "2026-08-05T03:30:00.000Z"
) {
    throw new Error(
        "Compatibility meal history changed timezone or zero-calorie semantics",
    );
}

const unauthorizedPortal = await app.request(
    "https://munch.example/account/portal",
);
const unauthorizedSettings = await app.request(
    "https://munch.example/api/app/settings",
);
const unauthorizedHousehold = await app.request(
    "https://munch.example/api/app/household/manage",
);
if (
    unauthorizedPortal.status !== 401 ||
    unauthorizedSettings.status !== 401 ||
    unauthorizedHousehold.status !== 401
) {
    throw new Error("Account surfaces allowed access without a web session");
}

await closePlatformDatabase();
console.log(
    "Unified settings, responsive account assets, household billing view, preferences, targets, connections, export, privacy boundaries, and legacy redirect smoke test passed.",
);
process.exit(0);
