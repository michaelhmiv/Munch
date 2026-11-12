const requiredFiles = [
    "public/index.html",
    "public/styles.css",
    "public/app.html",
    "public/app.js",
    "public/app-account.js",
    "public/app-integrity.js",
    "public/account-settings.css",
    "public/app-overrides.css",
    "public/app-patches.js",
    "public/weight-display.js",
    "public/help.html",
    "public/security.html",
    "public/security.txt",
    "public/open-source.html",
    "public/llms.txt",
    "public/robots.txt",
    "public/sitemap.xml",
    "public/app-ads.txt",
];

for (const path of requiredFiles) {
    if (!(await Bun.file(path).exists())) {
        throw new Error(`Missing UI surface: ${path}`);
    }
}

for (const retiredPath of [
    "public/login.html",
    "public/oauth-login.html",
    "public/portal-controls.css",
    "src/portal/routes.ts",
]) {
    if (await Bun.file(retiredPath).exists()) {
        throw new Error(`Retired UI surface still exists: ${retiredPath}`);
    }
}

const homepage = await Bun.file("public/index.html").text();
const normalizedHomepage = homepage.replace(/\s+/g, " ");
for (const stale of [
    "Start free trial",
    "30-day trial",
    "seven-day trial",
    "after trial",
]) {
    if (normalizedHomepage.toLowerCase().includes(stale.toLowerCase())) {
        throw new Error(`Homepage contains stale commercial copy: ${stale}`);
    }
}
if (!normalizedHomepage.includes("$2.99")) {
    throw new Error("Homepage does not state the canonical monthly price");
}
if (
    !normalizedHomepage.includes("Nutrition MCP") ||
    !normalizedHomepage.includes("Alexander Kutishevsky")
) {
    throw new Error("Homepage is missing upstream attribution");
}

const llms = await Bun.file("public/llms.txt").text();
const robots = await Bun.file("public/robots.txt").text();
const sitemap = await Bun.file("public/sitemap.xml").text();
for (const [path, source] of [
    ["public/llms.txt", llms],
    ["public/robots.txt", robots],
    ["public/sitemap.xml", sitemap],
] as const) {
    if (source.includes("munch-production-de3a.up.railway.app")) {
        throw new Error(`${path} contains the retired Railway public hostname`);
    }
}
if (/\btrial\b/i.test(llms)) {
    throw new Error("public/llms.txt contains stale trial billing language");
}
for (const phrase of [
    "permanent Free tier",
    "Premium is $2.99/month",
    "Additional household members are $2/month each",
    "https://munch.business/mcp",
]) {
    if (!llms.includes(phrase)) {
        throw new Error(
            `public/llms.txt is missing canonical product copy: ${phrase}`,
        );
    }
}
if (!robots.includes("Sitemap: https://munch.business/sitemap.xml")) {
    throw new Error("robots.txt does not advertise the canonical sitemap");
}

// ADS-FOUNDATION (Amendment G item 3): /app-ads.txt is the AdMob
// verification file — exactly one line naming the Munch publisher.
const appAds = await Bun.file("public/app-ads.txt").text();
if (appAds !== "google.com, pub-2708638041809482, DIRECT, f08c47fec0942fa0\n") {
    throw new Error(
        "public/app-ads.txt does not contain exactly the AdMob publisher line",
    );
}

const authSurfaces = ["src/auth/email.ts", "src/auth/password-routes.ts"];
const forbiddenAuthWords = [
    "subscription",
    "premium",
    "trial",
    "pricing",
    "checkout",
    "stripe",
    "$2.99",
];
for (const path of authSurfaces) {
    const text = (await Bun.file(path).text()).toLowerCase();
    for (const term of forbiddenAuthWords) {
        if (text.includes(term)) {
            throw new Error(
                `${path} contains protected commerce term: ${term}`,
            );
        }
    }
}

// Amendment D (2026-11-09) exception, deliberately narrow: the OAuth
// consent route must state plainly that MCP access is part of Premium and
// refuse approval for a Free account, so "premium" language is allowed in
// connect-routes.ts. Selling still is not: checkout, Stripe, trial, and
// the canonical price stay banned there — Premium starts only on the
// website, never inside the connection flow.
const connectRoutesText = (
    await Bun.file("src/auth/connect-routes.ts").text()
).toLowerCase();
for (const term of ["checkout", "stripe", "trial", "$2.99"]) {
    if (connectRoutesText.includes(term)) {
        throw new Error(
            `src/auth/connect-routes.ts contains protected commerce term: ${term}`,
        );
    }
}
if (!connectRoutesText.includes("mcp access is part of")) {
    throw new Error(
        "src/auth/connect-routes.ts is missing the consent Premium statement (Amendment D)",
    );
}

const accountRoutes = await Bun.file("src/accounts/routes.ts").text();
if (
    !accountRoutes.includes('account.get("/account/login"') ||
    !accountRoutes.includes("/connect/sign-in?return_to=")
) {
    throw new Error(
        "Account login compatibility route does not redirect into Better Auth sign-in",
    );
}

const connectRoutes = await Bun.file("src/auth/connect-routes.ts").text();
for (const route of [
    'connect.get("/connect/sign-in"',
    'connect.post("/connect/request"',
    'connect.get("/connect/confirm"',
    'connect.post("/connect/confirm"',
    'connect.get("/connect/consent"',
    'connect.get("/connect/error"',
]) {
    if (!connectRoutes.includes(route)) {
        throw new Error(`Better Auth connection UI is missing route: ${route}`);
    }
}
const passwordRoutes = await Bun.file("src/auth/password-routes.ts").text();
for (const route of [
    'router.get("/account/password"',
    'router.get("/account/password/reset"',
    "/api/auth/sign-up/email",
    "/api/auth/sign-in/username",
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
]) {
    if (!passwordRoutes.includes(route)) {
        throw new Error(`Password authentication surface is missing: ${route}`);
    }
}
for (const copy of [
    "Connect Munch to ChatGPT",
    "Connected Munch account",
    "Approve connection",
    "You can revoke this connection later from your Munch account.",
]) {
    if (!connectRoutes.includes(copy)) {
        throw new Error(`Better Auth connection UI is missing copy: ${copy}`);
    }
}

const indexSource = await Bun.file("src/index.ts").text();
for (const route of [
    "createAppRouter()",
    '"/help"',
    '"/help/connect-chatgpt"',
    '"/security"',
    '"/open-source"',
    '"/.well-known/security.txt"',
    '"/app-integrity.js"',
    '"/app-ads.txt"',
]) {
    if (!indexSource.includes(route)) {
        throw new Error(`Server is missing required route wiring: ${route}`);
    }
}

const appRouterSource = await Bun.file("src/app/routes.ts").text();
const normalizedAppRouterSource = appRouterSource.replace(/\s+/g, " ");
const exportRouterSource = await Bun.file(
    "src/account-export-routes.ts",
).text();
const appSource = await Bun.file("public/app.js").text();
if (
    !appSource.includes('data-action="trends-range"') ||
    !appSource.includes('action === "trends-range"') ||
    !appSource.includes("state.trendsRangeKey") ||
    !appSource.includes('key: "ytd"') ||
    !appSource.includes('key: "all"')
) {
    throw new Error(
        "Trends Week/Month/3 Mo/YTD/All time controls are rendered without a working range handler",
    );
}
const browserEntryPoints = [
    "public/app.js",
    "public/app-account.js",
    "public/app-patches.js",
];
for (const entryPoint of browserEntryPoints) {
    const source = await Bun.file(entryPoint).text();
    for (const match of source.matchAll(/from\s+["']\.\/([^"']+\.js)["']/g)) {
        const moduleName = match[1];
        const publicPath = `public/${moduleName}`;
        const route = `/${moduleName}`;
        if (!(await Bun.file(publicPath).exists())) {
            throw new Error(
                `${entryPoint} imports missing browser module ${publicPath}`,
            );
        }
        if (!appRouterSource.includes(`app.get("${route}"`)) {
            throw new Error(
                `${entryPoint} imports ${route}, but the app router does not serve it`,
            );
        }
    }
}
if (!appRouterSource.includes('app.get("/account-settings.css"')) {
    throw new Error(
        "App router does not serve the account settings stylesheet",
    );
}
if (!appRouterSource.includes('"/api/app/household/manage"')) {
    throw new Error(
        "App router is missing the household management read model",
    );
}
if (!exportRouterSource.includes('"/api/app/export/meals"')) {
    throw new Error("Focused meal export route is missing");
}
for (const route of [
    'app.get("/api/app/food-search"',
    'app.post("/api/app/foods"',
    '"/api/app/foods/:id"',
    'app.get("/api/app/food-details"',
    'app.get("/api/app/food-barcode"',
    'app.post("/api/app/meals"',
    'app.post("/api/app/import/parse"',
    'app.post("/api/app/import"',
    'app.get("/api/app/insights"',
    'app.get("/api/app/trends"',
    'app.get("/api/app/trends/layout"',
    'app.put("/api/app/trends/layout"',
    'app.get("/api/app/trends/day"',
    'app.get("/api/app/trends/contributors"',
    'app.patch("/api/app/water/:id"',
    'app.delete("/api/app/water/:id"',
    'app.patch("/api/app/weight/:id"',
    'app.delete("/api/app/weight/:id"',
    'app.get("/api/app/meals/:id"',
    'app.patch(\n        "/api/app/meals/:mealId/items/:itemId"',
    'app.post("/api/app/meals/:mealId/items"',
    'app.post("/api/app/meal-drafts"',
    'app.post("/api/app/recipes"',
    'app.post(\n        "/api/app/recipes/import-preview"',
    'app.post("/api/app/recipes/compose"',
    'app.post("/api/app/groceries/items"',
    '"/api/app/groceries/items/:id"',
    '"/api/app/groceries/items/:id/purchased"',
    '"/api/app/groceries/clear-purchased"',
    'app.get("/api/app/meal-drafts/:id"',
    '"/api/app/meal-drafts/:id/items"',
    '"/api/app/meal-drafts/:id/confirm"',
    '"/api/app/meal-drafts/:id/cancel"',
]) {
    if (!normalizedAppRouterSource.includes(route.replace(/\s+/g, " "))) {
        throw new Error(`App meal composer is missing route: ${route}`);
    }
}
for (const behavior of [
    'data-action="add-meal"',
    'data-action="select-meal-option"',
    'data-action="lookup-food-barcode"',
    "mealComposerPayload",
    'api("/api/app/meals"',
    "meal-draft-create-form",
    'api("/api/app/meal-drafts"',
    "web-import-file-form",
    "web-import-map-form",
    'api("/api/app/import/parse"',
    'api("/api/app/import"',
    'data-action="web-import-commit"',
    'data-action="view-meal-details"',
    'data-action="meal-history-range"',
    "meal-history-search-form",
    'data-action="clear-meal-search"',
    'data-action="trends-range"',
    "digest.trends",
    "digest.patterns",
    'data-action="edit-water"',
    'data-action="delete-water"',
    'data-action="edit-weight"',
    'data-action="delete-weight"',
    "edit-water-form",
    "edit-weight-form",
    "waterEntryRows",
    "trendsLineChart",
    "api(`/api/app/water/${encodeURIComponent",
    "api(`/api/app/weight/${encodeURIComponent",
    'data-action="open-meal-draft"',
    'data-action="start-meal-draft"',
    'data-action="manage-saved-foods"',
    'data-action="select-saved-food-candidate"',
    'data-action="delete-saved-food"',
    "saved-food-form",
    'data-action="confirm-meal-draft"',
    'data-action="cancel-meal-draft"',
    'data-action="create-recipe"',
    'data-action="import-recipe-url"',
    "Import recipe from a website",
    "Create manually",
    'data-action="compose-recipe"',
    'data-action="select-recipe-food-option"',
    'data-action="add-recipe-ingredient"',
    'data-action="add-recipe-grocery"',
    'data-action="remove-recipe-grocery"',
    "recipePayloadFromForm",
    "recipe-import-url-form",
    "recipe-import-progress",
    "Checking the URL",
    "Parsing recipe details",
    "Matching ingredients",
    "Preparing your review",
    "setRecipeImportProgressError",
    'api("/api/app/recipes/import-preview"',
    "openRecipeImportReview",
    "recipeGroceryItemsPayload",
    'api("/api/app/recipes"',
    'api("/api/app/recipes/compose"',
    'data-action="add-grocery"',
    'data-action="edit-grocery"',
    'data-action="toggle-grocery-purchased"',
    'data-action="clear-purchased"',
    "grocery-add-form",
]) {
    if (!appSource.includes(behavior)) {
        throw new Error(`App meal composer is missing behavior: ${behavior}`);
    }
}
if (!appRouterSource.includes("serializeMealDraftForApp")) {
    throw new Error(
        "App draft routes do not use the canonical draft serializer",
    );
}
if (appSource.includes("Continue this draft in ChatGPT")) {
    throw new Error("Pending drafts still redirect users to ChatGPT");
}

const mealPatchSource = await Bun.file("public/app-patches.js").text();
for (const behavior of [
    "data-patch-item-form",
    "data-patch-new-item-form",
    "data-patch-food-search-form",
    "data-patch-food-option",
    "patch-replace-target",
    "replace_item",
    "Food replaced and totals recalculated.",
]) {
    if (!mealPatchSource.includes(behavior)) {
        throw new Error(`Meal editor is missing behavior: ${behavior}`);
    }
}
if (appSource.includes("Complete recipe JSON")) {
    throw new Error("Recipe editing still requires raw JSON");
}

// S6 slice 4 (Recipes fusion): the library renders inside the shared
// .operate-view Editorial Serif scope, archiving uses slice 1's inline
// confirmation (never the native confirm), and the surface carries no
// ad markup (the app's only ad slot is on Today — final ad law).
for (const pin of [
    "operate-view recipes-view",
    'data-action="confirm-archive-recipe"',
    'data-action="dismiss-archive-recipe"',
    "recipe-panel",
]) {
    if (!appSource.includes(pin)) {
        throw new Error(`Recipes fusion is missing its pin: ${pin}`);
    }
}
if (
    appSource.includes('confirm(\n                "Archive this recipe?') ||
    appSource.includes('confirm("Archive this recipe?')
) {
    throw new Error(
        "Recipe archive still gates on the native confirm() dialog",
    );
}
const appOverridesSource = await Bun.file("public/app-overrides.css").text();
if (!appOverridesSource.includes(".recipes-view .recipe-panel")) {
    throw new Error("Recipes fusion styles are missing from app-overrides.css");
}

// S6 slice 6 (Groceries fusion): the list renders inside the shared
// .operate-view Editorial Serif scope grouped by source, the checkbox
// is the 44px tap target, and both destructive flows (remove item,
// clear purchased) use slice 1's inline confirmation — never the
// native confirm. The surface carries no ad markup (the app's only
// ad slot is on Today — final ad law).
for (const pin of [
    "operate-view groceries-view",
    "confirm-remove-grocery",
    "confirm-clear-purchased",
    "dismiss-grocery-confirm",
    "grocery-item-row",
    "grocery-check-input",
    "groceryItemGroup",
]) {
    if (!appSource.includes(pin)) {
        throw new Error(`Groceries fusion is missing its pin: ${pin}`);
    }
}
for (const stale of [
    'confirm("Remove this grocery item from the list?")',
    'confirm("Remove all purchased items from this list?")',
]) {
    if (appSource.includes(stale)) {
        throw new Error(
            `Groceries still gates a destructive flow on the native confirm(): ${stale}`,
        );
    }
}
for (const pin of [
    ".groceries-view .grocery-item-row",
    ".groceries-view .grocery-check-input",
    ".grocery-inline-confirm",
]) {
    if (!appOverridesSource.includes(pin)) {
        throw new Error(
            `Groceries fusion styles are missing from app-overrides.css: ${pin}`,
        );
    }
}

// S6 slice 5 (Cooks fusion): the list renders inside the shared
// .operate-view Editorial Serif scope, delete + finish use slice 1's
// inline confirmation (never the native confirm), and the surface
// carries no ad markup (the app's only ad slot is on Today).
for (const pin of [
    "operate-view cooks-view",
    'data-action="confirm-delete-cook"',
    'data-action="confirm-finish-cook"',
    'data-action="dismiss-cook-confirm"',
    "cook-panel",
]) {
    if (!appSource.includes(pin)) {
        throw new Error(`Cooks fusion is missing its pin: ${pin}`);
    }
}
if (
    appSource.includes(
        '!confirm(\n                "Delete this cook, its timeline, results, and saved photos? This cannot be undone."',
    )
) {
    throw new Error("Cook delete still gates on the native confirm() dialog");
}
if (!appOverridesSource.includes(".cooks-view .cook-panel")) {
    throw new Error("Cooks fusion styles are missing from app-overrides.css");
}

// Trends (brief T1-T14; the Insights destination retired into it):
// the surface renders inside the shared .operate-view Editorial Serif
// scope, the Digest's weekly check-in request stays windowed to the
// last 7 days (PR #184 — the route rejects wider ranges), chart
// labels are placed collision-aware (trendsPlaceLabel, T14), the
// retired /app/insights route redirects here, water/weight deletes
// use slice 1's inline confirmation (never the native confirm), and
// the surface carries no ad markup (the app's only ad slot is on
// Today, final ad law).
for (const pin of [
    "operate-view trends-view",
    'data-action="confirm-delete-${kind}"',
    'action === "confirm-delete-water"',
    'action === "confirm-delete-weight"',
    'data-action="dismiss-delete-vital"',
    "trendsPlaceLabel",
    "shiftDate(end, -6)",
    'location.pathname === "/app/insights"',
    'data-action="open-trends"',
]) {
    if (!appSource.includes(pin)) {
        throw new Error(`Trends surface is missing its pin: ${pin}`);
    }
}
for (const stale of [
    'confirm("Permanently delete this water entry?")',
    'confirm("Permanently delete this weight entry?")',
]) {
    if (appSource.includes(stale)) {
        throw new Error(
            `A destructive vitals flow still gates on the native confirm(): ${stale}`,
        );
    }
}
if (!appOverridesSource.includes(".trends-card {")) {
    throw new Error("Trends styles are missing from app-overrides.css");
}

const appHtml = await Bun.file("public/app.html").text();
for (const route of [
    "/app/log",
    "/app/trends",
    "/app/recipes",
    "/app/plan",
    "/app/groceries",
    "/app/household",
    "/app/settings",
    "/app/more",
]) {
    if (!appHtml.includes(route)) {
        throw new Error(`App navigation is missing ${route}`);
    }
}
if (appHtml.includes('data-route="foods"')) {
    throw new Error("Retired Foods route is still present in app navigation");
}
if (
    !appHtml.includes('href="/account-settings.css"') ||
    !appHtml.includes('data-route="more" href="/app/more"')
) {
    throw new Error(
        "App shell is missing the unified settings styles or mobile More route",
    );
}

const accountModule = await Bun.file("public/app-account.js").text();
for (const route of [
    "/app/settings/profile",
    "/app/settings/goals",
    "/app/settings/billing",
    "/app/settings/connections",
    "/app/settings/data",
    "/app/settings/account",
]) {
    if (!accountModule.includes(route)) {
        throw new Error(`Unified settings module is missing ${route}`);
    }
}
for (const behavior of [
    "settings-profile-form",
    "settings-goals-form",
    "household-create-form",
    "household-invite-form",
    "household-member-remove",
    "household-role-save",
    "household-leave",
    "household-dissolve",
    "connection-revoke",
    "account-delete",
    "requireProductPolicy",
    "weightFromGrams",
    "Premium through household",
    "Pending invitations",
    'data-action="open-import"',
    'data-action="export-meals"',
    'api("/api/app/export/meals"',
]) {
    if (!accountModule.includes(behavior)) {
        throw new Error(
            `Unified account UI is missing behavior/copy: ${behavior}`,
        );
    }
}
if (accountModule.includes('["/app/foods", "Foods"')) {
    throw new Error("Unified account UI still links to the retired Foods page");
}

// S6 slice 8 (Household fusion): the surface renders inside the
// shared .operate-view Editorial Serif scope, every destructive flow
// (remove member, leave, dissolve, revoke invitation) uses slice 1's
// inline confirmation — never the native confirm — and the surface
// carries no ad markup (the app's only ad slot is on Today).
for (const pin of [
    "operate-view household-view",
    "showHouseholdInlineConfirm",
    "dismiss-household-confirm",
    "confirm-household-member-remove",
    "confirm-household-invite-revoke",
    "confirm-household-leave",
    "confirm-household-dissolve",
    "household-invite-revoke",
    'api("/account/household/invite/revoke"',
]) {
    if (!accountModule.includes(pin)) {
        throw new Error(`Household fusion is missing its pin: ${pin}`);
    }
}
for (const stale of [
    "!confirm(\n                `Remove ${name}? Their household-provided Premium ends",
    '!confirm(\n                "Leave this household?',
    '!confirm(\n                "Dissolve this household,',
]) {
    if (accountModule.includes(stale)) {
        throw new Error(
            `Household still gates a destructive flow on the native confirm(): ${stale}`,
        );
    }
}
for (const pin of [
    ".household-view .household-member",
    ".household-view .pending-invite",
    ".household-inline-confirm",
]) {
    if (!appOverridesSource.includes(pin)) {
        throw new Error(
            `Household fusion styles are missing from app-overrides.css: ${pin}`,
        );
    }
}
if (accountModule.includes("Advanced account controls")) {
    throw new Error(
        "Unified settings still exposes the legacy advanced account UX",
    );
}

// S6 slice 9 (Settings fusion): the Settings routes render inside
// the shared .operate-view scope plus .settings-view, the Sign-in
// methods section (Amendment I) consumes PR #207's backend, and this
// surface's destructive flows (connection revoke, sign-in method
// unlink, account deletion, goal-change commit) use slice 1's inline
// confirmation — never the native confirm. (Household's confirm()
// calls live in the same module but belong to slice 8's surface and
// are deliberately not pinned here.)
for (const pin of [
    "operate-view settings-view",
    "Sign-in methods",
    "/api/app/sign-in-methods",
    "sign-in-method-link",
    "sign-in-method-unlink",
    "confirm-sign-in-method-unlink",
    "confirm-connection-revoke",
    "confirm-account-delete",
    "dismiss-settings-confirm",
    "showSettingsInlineConfirm",
    "billing-apple-manage",
]) {
    if (!accountModule.includes(pin)) {
        throw new Error(`Settings fusion is missing its pin: ${pin}`);
    }
}
for (const stale of [
    "if (!confirm(`Revoke ${name}?`))",
    '!confirm(\n                "Permanently delete your Munch account and personal data? This cannot be undone."',
]) {
    if (accountModule.includes(stale)) {
        throw new Error(
            `Settings still gates a destructive flow on the native confirm(): ${stale}`,
        );
    }
}
if (
    appSource.includes(
        'confirm("Confirm and save these exact target changes?")',
    )
) {
    throw new Error(
        "Goal-change commit still gates on the native confirm() dialog",
    );
}
for (const pin of [
    ".settings-view .settings-group",
    ".settings-view .sign-in-method-row",
    ".settings-inline-confirm",
]) {
    if (!appOverridesSource.includes(pin)) {
        throw new Error(`Settings fusion styles are missing: ${pin}`);
    }
}

const accountCss = await Bun.file("public/account-settings.css").text();
for (const responsiveRule of [
    "@media (max-width: 980px)",
    "@media (max-width: 840px)",
    "@media (max-width: 620px)",
    "font-size: 16px",
    "min-height: 48px",
]) {
    if (!accountCss.includes(responsiveRule)) {
        throw new Error(
            `Account settings CSS is missing responsive/accessibility rule: ${responsiveRule}`,
        );
    }
}
for (const component of [
    ".settings-layout",
    ".settings-local-nav",
    ".settings-index-card",
    ".settings-toggle-row",
    ".segmented-control",
    ".connection-card",
    ".household-member",
    ".settings-danger",
]) {
    if (!accountCss.includes(component)) {
        throw new Error(
            `Account settings CSS is missing component: ${component}`,
        );
    }
}

const globalStyles = await Bun.file("public/styles.css").text();
if (
    !globalStyles.includes("env(safe-area-inset-bottom)") ||
    !globalStyles.includes(".mobile-bottom-nav")
) {
    throw new Error(
        "Global app shell is missing mobile safe-area navigation protection",
    );
}

const householdRoutes = await Bun.file("src/households/routes.ts").text();
if (!householdRoutes.includes('c.redirect("/app/household", 303)')) {
    throw new Error(
        "Household invitation acceptance does not return to the new workspace",
    );
}
// S6 slice 8: owners can revoke a pending invitation, and the
// server-rendered accept page ships in the Editorial Serif connect
// shell (editorial.css), not the legacy styles.css world.
if (!householdRoutes.includes('"/account/household/invite/revoke"')) {
    throw new Error("Household invitation revocation route is missing");
}
if (!householdRoutes.includes('href="/editorial.css"')) {
    throw new Error(
        "Household invitation acceptance page is not in the Editorial Serif shell",
    );
}

// DESIGN AUTHORITY (ratified 2026-11-11) — the mechanically checkable
// subset of the design authority, enforced in CI so compliance stops
// depending on discipline. Authority: design-authority.md (Direction C
// buttons; panel #fffdf8; rule tan #8a7c63; gold reserved). Audit of
// record: parity-program/design-authority-audit-2026-11-11.md.
// Where a check cannot pass on current main because of a recorded
// audit finding, the finding's selectors are enumerated as RECORDED
// EXCEPTIONS below: they are the fix list, not a hiding place — any
// NEW occurrence outside the sanctioned contexts fails this smoke.
const designAuthorityFiles: string[] = [];
for await (const path of new Bun.Glob("public/**/*.{css,js,html,txt}").scan(
    ".",
)) {
    designAuthorityFiles.push(path);
}
const designAuthoritySources = new Map<string, string>();
for (const path of designAuthorityFiles) {
    designAuthoritySources.set(path, await Bun.file(path).text());
}

// Retired colors (authority §1): the beige button tint and the mid-tan
// border appear in no production stylesheet and must never return.
for (const [path, source] of designAuthoritySources) {
    const lower = source.toLowerCase();
    for (const retired of ["#efe9db", "#b8a888"]) {
        if (lower.includes(retired)) {
            throw new Error(
                `Design authority: retired color ${retired} found in ${path}`,
            );
        }
    }
}

// Minimal CSS rule reader (comments stripped; media-query nesting
// tracked) so the checks below key on the enclosing selector, which
// is where the authority's context rules live.
function cssRules(css: string): { selector: string; body: string }[] {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules: { selector: string; body: string }[] = [];
    const stack: { selector: string; text: string }[] = [
        { selector: "", text: "" },
    ];
    for (const ch of stripped) {
        const top = stack[stack.length - 1];
        if (ch === "{") {
            const selector = top.text.split(";").pop()?.trim() ?? "";
            stack.push({ selector, text: "" });
            top.text = "";
        } else if (ch === "}") {
            const frame = stack.pop()!;
            if (frame.text.includes(":")) {
                rules.push({ selector: frame.selector, body: frame.text });
            }
        } else {
            top.text += ch;
        }
    }
    return rules;
}
const allCssRules: { path: string; selector: string; body: string }[] = [];
for (const [path, source] of designAuthoritySources) {
    if (!path.endsWith(".css")) continue;
    for (const rule of cssRules(source)) {
        allCssRules.push({ path, ...rule });
    }
}
const GOLD_HEX = "#8a6d3b";
const GOLD_SANCTIONED = [
    /\.mobile-bottom-nav\s+a\.is-active::after/, // active-tab dot
    /\.cal-day\.is-today/, // calendar today marker
    /\.trends-/, // chart accents (bars, rolling line, reference marks)
];
const GOLD_RECORDED_EXCEPTIONS = [
    /\.next-up-kicker/, // audit V1 — Next-up kicker text (surface being removed)
    /\.meal-draft-dirty/, // audit V1 — meal-editor dirty-state text
    /\.recipe-unresolved/, // audit V1 — recipe unresolved badge
];
for (const rule of allCssRules) {
    if (!rule.body.toLowerCase().includes(GOLD_HEX)) continue;
    const sanctioned = GOLD_SANCTIONED.some((re) => re.test(rule.selector));
    const recorded = GOLD_RECORDED_EXCEPTIONS.some((re) =>
        re.test(rule.selector),
    );
    if (!sanctioned && !recorded) {
        throw new Error(
            `Design authority: gold ${GOLD_HEX} used outside its reserved contexts in ${rule.path} [${rule.selector}] — see audit V1`,
        );
    }
}
// In JS, gold may appear only as a data colorway value in an object
// literal (the macro/meal color maps — chart/data accents), never as
// chrome styling.
for (const [path, source] of designAuthoritySources) {
    if (!path.endsWith(".js")) continue;
    for (const line of source.split("\n")) {
        if (!line.toLowerCase().includes(GOLD_HEX)) continue;
        if (!/^\s*[\w"']+\s*:\s*"#8a6d3b"/i.test(line)) {
            throw new Error(
                `Design authority: gold ${GOLD_HEX} used outside a data colorway in ${path}: ${line.trim().slice(0, 80)}`,
            );
        }
    }
}

// Type floor (authority §7): nothing renders below 11px. Sanctioned
// exception: Trends chart annotation selectors ONLY (approved
// renderings). Recorded legacy exceptions are audit V7's fix list.
const FONT_SANCTIONED = [
    /\.trends-(ref-label|daylabels|endlabels|donut|column|months|window-row)/,
];
const FONT_RECORDED_EXCEPTIONS = [
    /\.nutrition-card\.compact/, // audit V7 — ≈9.9px
    /\.metric-tile/, // audit V7 — ≈10.9px
    /status-chip/, // audit V7 — ≈10.9px
    /\.import-native-table/, // audit V7 — ≈10.7px
];
for (const rule of allCssRules) {
    for (const match of rule.body.matchAll(
        /font-size:\s*([0-9.]+)(px|rem|em)\b/g,
    )) {
        const value = parseFloat(match[1]);
        const px = match[2] === "px" ? value : value * 16;
        if (px >= 11) continue;
        const sanctioned = FONT_SANCTIONED.some((re) => re.test(rule.selector));
        const recorded = FONT_RECORDED_EXCEPTIONS.some((re) =>
            re.test(rule.selector),
        );
        if (!sanctioned && !recorded) {
            throw new Error(
                `Design authority: font-size ${match[0]} below the 11px floor in ${rule.path} [${rule.selector}] — see audit V7`,
            );
        }
    }
}

// Button spec, Direction C (authority §4): the base tier rules in
// app-overrides.css carry the spec's exact values.
function ruleBody(selector: string): string {
    const rule = allCssRules.find(
        (r) => r.path === "public/app-overrides.css" && r.selector === selector,
    );
    if (!rule) {
        throw new Error(
            `Design authority: missing base rule ${selector} in public/app-overrides.css`,
        );
    }
    return rule.body.replace(/\s+/g, " ").toLowerCase();
}
const primaryBody = ruleBody(".button-primary");
if (
    !primaryBody.includes("background: #176b3a") ||
    !primaryBody.includes("border-color: #176b3a")
) {
    throw new Error(
        "Design authority: .button-primary no longer carries the Direction C spec (#176b3a fill and border)",
    );
}
if (!ruleBody(".button-primary:hover").includes("#0b3d24")) {
    throw new Error(
        "Design authority: .button-primary:hover no longer uses green-deep #0b3d24",
    );
}
const secondaryBody = ruleBody(".button-secondary");
if (
    !secondaryBody.includes("background: transparent") ||
    !secondaryBody.includes("border-color: #8a7c63") ||
    !secondaryBody.includes("color: #2b2620")
) {
    throw new Error(
        "Design authority: .button-secondary no longer carries the Direction C spec (transparent fill, #8a7c63 border, ink text)",
    );
}

// Dialogs (authority §2): the dialog card is the panel material with a
// hairline border, and no dialog rule paints a dialog white.
const dialogCardPainted = allCssRules
    .filter((r) => r.selector === "dialog .auth-card")
    .some((r) =>
        /background:\s*(#fffdf8|var\(--paper-card\))/.test(
            r.body.replace(/\s+/g, " ").toLowerCase(),
        ),
    );
if (!dialogCardPainted) {
    throw new Error(
        "Design authority: dialog .auth-card no longer uses the panel material (#fffdf8)",
    );
}
for (const rule of allCssRules) {
    if (!/^dialog/.test(rule.selector)) continue;
    if (
        /background:\s*(white|#fff|#ffffff)\b/.test(
            rule.body.replace(/\s+/g, " ").toLowerCase(),
        )
    ) {
        throw new Error(
            `Design authority: dialog rule paints a dialog white in ${rule.path} [${rule.selector}]`,
        );
    }
}

console.log("UI surface and unified account responsive smoke checks passed.");
