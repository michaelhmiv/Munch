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
    'id="pantry-photo"',
    'id="receipt-photo"',
    'id="review"',
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
    "/api/app/pantry/scan-preview",
    "/api/app/purchases/receipt-preview",
    "/api/app/purchases/reconcile",
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
if (!routes.includes('capabilities.tier !== "premium"')) {
    throw new Error(
        "Pantry web surface is missing premium entitlement enforcement",
    );
}
if (!routes.includes("8 * 1024 * 1024")) {
    throw new Error("Pantry image handlers are missing their 8 MB bound");
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
    !privacy.includes("<strong>OpenRouter</strong>") ||
    !privacy.includes("not a promise of zero retention")
) {
    throw new Error("Pantry image-processing privacy disclosure is incomplete");
}

console.log("Munch premium Pantry web surface static smoke test passed.");
