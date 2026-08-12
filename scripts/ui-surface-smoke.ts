const requiredFiles = [
    "public/index.html",
    "public/styles.css",
    "public/app.html",
    "public/app.js",
    "public/app-account.js",
    "public/account-settings.css",
    "public/app-overrides.css",
    "public/app-patches.js",
    "public/weight-display.js",
    "public/help.html",
    "public/help-connect.html",
    "public/security.html",
    "public/security.txt",
    "public/open-source.html",
];

for (const path of requiredFiles) {
    if (!(await Bun.file(path).exists())) {
        throw new Error(`Missing UI surface: ${path}`);
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
if (!normalizedHomepage.includes("$4.99")) {
    throw new Error("Homepage does not state the canonical monthly price");
}
if (
    !normalizedHomepage.includes("Nutrition MCP") ||
    !normalizedHomepage.includes("Alexander Kutishevsky")
) {
    throw new Error("Homepage is missing upstream attribution");
}

const authSurfaces = [
    "public/login.html",
    "public/oauth-login.html",
    "public/help-connect.html",
    "src/auth/connect-routes.ts",
    "src/auth/email.ts",
];
const forbiddenAuthWords = [
    "subscription",
    "premium",
    "trial",
    "pricing",
    "checkout",
    "stripe",
    "$4.99",
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

const indexSource = await Bun.file("src/index.ts").text();
for (const route of [
    "createAppRouter()",
    '"/help"',
    '"/help/connect-chatgpt"',
    '"/security"',
    '"/open-source"',
    '"/.well-known/security.txt"',
]) {
    if (!indexSource.includes(route)) {
        throw new Error(`Server is missing required route wiring: ${route}`);
    }
}

const appRouterSource = await Bun.file("src/app/routes.ts").text();
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
    throw new Error("App router does not serve the account settings stylesheet");
}
if (!appRouterSource.includes('"/api/app/household/manage"')) {
    throw new Error("App router is missing the household management read model");
}

const appHtml = await Bun.file("public/app.html").text();
for (const route of [
    "/app/log",
    "/app/insights",
    "/app/foods",
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
if (
    !appHtml.includes('href="/account-settings.css"') ||
    !appHtml.includes('data-route="more" href="/app/more"')
) {
    throw new Error("App shell is missing the unified settings styles or mobile More route");
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
    "$4.99",
    "$2.00",
    "Premium through household",
    "Pending invitations",
]) {
    if (!accountModule.includes(behavior)) {
        throw new Error(`Unified account UI is missing behavior/copy: ${behavior}`);
    }
}
if (accountModule.includes("Advanced account controls")) {
    throw new Error("Unified settings still exposes the legacy advanced account UX");
}

const accountCss = await Bun.file("public/account-settings.css").text();
for (const responsiveRule of [
    "@media (max-width: 980px)",
    "@media (max-width: 840px)",
    "@media (max-width: 620px)",
    "font-size: 16px",
    "min-height: 48px",
    "env(safe-area-inset-bottom)",
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
        throw new Error(`Account settings CSS is missing component: ${component}`);
    }
}

const portalSource = await Bun.file("src/portal/routes.ts").text();
if (
    !portalSource.includes('c.redirect("/app/settings", 303)') ||
    portalSource.includes("Account control center") ||
    portalSource.includes("Advanced account controls")
) {
    throw new Error("Legacy account portal was not cleanly retired");
}

const householdRoutes = await Bun.file("src/households/routes.ts").text();
if (!householdRoutes.includes('c.redirect("/app/household", 303)')) {
    throw new Error("Household invitation acceptance does not return to the new workspace");
}

console.log("UI surface and unified account responsive smoke checks passed.");
