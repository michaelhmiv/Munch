#!/usr/bin/env bun

const [html, js, css, routes, index, appHtml, appStyles, privacy] =
    await Promise.all([
        Bun.file("public/pantry.html").text(),
        Bun.file("public/pantry.js").text(),
        Bun.file("public/pantry.css").text(),
        Bun.file("src/inventory/routes.ts").text(),
        Bun.file("src/index.ts").text(),
        Bun.file("public/app.html").text(),
        Bun.file("public/styles.css").text(),
        Bun.file("public/privacy.html").text(),
    ]);

const requiredHtml = [
    'id="pantry-enabled"',
    'id="manual-add"',
    'id="inventory"',
    'name="viewport"',
];
for (const marker of requiredHtml) {
    if (!html.includes(marker)) {
        throw new Error(`Pantry UI omitted required markup: ${marker}`);
    }
}

for (const endpoint of [
    "/api/app/pantry/settings",
    "/api/app/pantry/reconcile",
]) {
    if (!routes.includes(endpoint) || !js.includes(endpoint)) {
        throw new Error(
            `Pantry web contract is not wired end-to-end: ${endpoint}`,
        );
    }
}

if (
    !routes.includes("requireWebSession") ||
    !routes.includes("requireSameOrigin")
) {
    throw new Error("Pantry web writes are missing session/CSRF enforcement");
}
const requiredSessionBoundaries = [
    'app.use("/api/app/pantry", requireWebSession)',
    'app.use("/api/app/pantry/*", requireWebSession)',
    'app.use("/api/app/purchases/*", requireWebSession)',
];
for (const boundary of requiredSessionBoundaries) {
    if (!routes.includes(boundary)) {
        throw new Error(`Pantry web auth boundary is missing: ${boundary}`);
    }
}
if (
    routes.includes('app.use("/api/app/pantry*", requireWebSession)') ||
    routes.includes('app.use("/api/app/purchases*", requireWebSession)')
) {
    throw new Error(
        "Pantry web auth must use explicit base and slash-wildcard route patterns",
    );
}
const normalizedRoutes = routes.replace(/\s+/g, " ");
if (
    !normalizedRoutes.includes("resolveRequestMunchCapabilities(c, userId)") ||
    !normalizedRoutes.includes("if (!capabilities.personalPlanningRead)")
) {
    throw new Error(
        "Pantry route is missing surface-specific planning capability enforcement",
    );
}
if (!index.includes("10 * 1024 * 1024")) {
    throw new Error(
        "Global request limit does not admit bounded Pantry image uploads",
    );
}
if (!/@media\s*\(\s*max-width:\s*760px\s*\)/.test(css)) {
    throw new Error(
        "Pantry workspace is missing its mobile responsive treatment",
    );
}
if (/localStorage|sessionStorage/.test(js)) {
    throw new Error(
        "Pantry client must not persist inventory or receipt data in browser storage",
    );
}
if (/receipt_image|raw_image|image_bytes/.test(routes)) {
    throw new Error(
        "Pantry route source suggests raw receipt media persistence",
    );
}
for (const removed of [
    "/api/app/pantry/scan-preview",
    "/api/app/pantry/meal-ideas",
    "/api/app/purchases/receipt-preview",
    "generatePantryMealIdeas",
    "previewInventoryImage",
]) {
    if (routes.includes(removed) || js.includes(removed)) {
        throw new Error(
            `Removed website AI surface is still wired: ${removed}`,
        );
    }
}
const pantryLinks = appHtml.match(/href="\/app\/pantry"/g) ?? [];
if (pantryLinks.length < 2) {
    throw new Error(
        "Pantry is not discoverable from both desktop and mobile app navigation",
    );
}
if (!appStyles.includes("grid-template-columns: repeat(6, 1fr)")) {
    throw new Error("Mobile app navigation was not sized for the Pantry entry");
}
if (
    !privacy.includes("Pantry and receipt images") ||
    !privacy.includes("Pantry meal planning") ||
    !privacy.includes("does not accept Pantry or receipt") ||
    !privacy.includes("does not generate Pantry meal")
) {
    throw new Error("Pantry AI-removal privacy disclosure is incomplete");
}
if (privacy.includes("<strong>OpenRouter</strong>")) {
    throw new Error(
        "Privacy policy still lists OpenRouter as a website data recipient",
    );
}

console.log("Munch premium Pantry web surface static smoke test passed.");
