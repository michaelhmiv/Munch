#!/usr/bin/env bun

const [html, js, css, routes, index, appHtml, appStyles, privacy, iosSmoke] =
    await Promise.all([
        Bun.file("public/pantry.html").text(),
        Bun.file("public/pantry.js").text(),
        Bun.file("public/pantry.css").text(),
        Bun.file("src/inventory/routes.ts").text(),
        Bun.file("src/index.ts").text(),
        Bun.file("public/app.html").text(),
        Bun.file("public/styles.css").text(),
        Bun.file("public/privacy.html").text(),
        Bun.file("ios/App/AppUITests/MunchSmokeTests.swift").text(),
    ]);

const requiredHtml = [
    'id="manual-add"',
    'id="pantry-photo"',
    'id="receipt-photo"',
    'id="review"',
    'id="meal-planner"',
    'id="meal-idea-form"',
    'id="meal-goal"',
    'id="meal-staples"',
    'id="meal-ideas"',
    'id="inventory"',
    'name="viewport"',
];
for (const marker of requiredHtml) {
    if (!html.includes(marker)) {
        throw new Error(`Pantry UI omitted required markup: ${marker}`);
    }
}

// Tools-to-top rail + sheets (Nov 11 ruling; missed-work audit
// N1/N2): the four tools ride an icon-only rail in the resolved
// order — Add, Scan pantry, Scan receipt, brain — above the
// inventory; every form lives inside its dialog sheet, never as a
// card under the inventory; and the Pantry chat entry is the brain
// glyph, not the planner card's retired text row.
const requiredRail = [
    'class="tools-rail"',
    'data-open-sheet="sheet-add"',
    'data-open-sheet="sheet-scan"',
    'data-open-sheet="sheet-receipt"',
    'data-open-sheet="sheet-planner"',
    'id="sheet-add"',
    'id="sheet-scan"',
    'id="sheet-receipt"',
    'id="sheet-planner"',
    'data-testid="brain-entry-pantry"',
    'href="/app/chat?surface=pantry"',
];
for (const marker of requiredRail) {
    if (!html.includes(marker)) {
        throw new Error(`Pantry tools rail omitted required markup: ${marker}`);
    }
}
const railOrder = [
    'class="tools-rail"',
    'data-open-sheet="sheet-add"',
    'data-open-sheet="sheet-scan"',
    'data-open-sheet="sheet-receipt"',
    'data-testid="brain-entry-pantry"',
    'id="inventory"',
].map((marker) => html.indexOf(marker));
if (
    railOrder.some(
        (index, i) => index < 0 || (i > 0 && index < railOrder[i - 1]),
    )
) {
    throw new Error(
        "Pantry rail tools are out of order (Add, Scan pantry, Scan receipt, brain) or the rail does not ride above the inventory",
    );
}
for (const [sheet, inner] of [
    ["sheet-add", "manual-add"],
    ["sheet-scan", "pantry-photo"],
    ["sheet-receipt", "receipt-photo"],
    ["sheet-planner", "meal-planner"],
] as const) {
    if (html.indexOf(`id="${inner}"`) < html.indexOf(`id="${sheet}"`)) {
        throw new Error(
            `Pantry form ${inner} is not inside its sheet ${sheet}`,
        );
    }
}
if (
    html.includes('class="grid-two"') ||
    html.includes('data-testid="chat-entry-pantry"') ||
    html.includes('class="entry-row"')
) {
    throw new Error(
        "The retired below-inventory tool cards or the planner-card chat text row resurfaced",
    );
}
if (!js.includes("showModal") || !js.includes("data-open-sheet")) {
    throw new Error("Pantry sheets are not wired to the tools rail");
}
if (!css.includes(".tools-rail") || !css.includes("dialog.sheet")) {
    throw new Error(
        "Pantry stylesheet is missing the tools rail or sheet rules",
    );
}

// Pantry enablement is the Settings feature-module flag only (Nov 11):
// the page's legacy "Use Pantry" switch, its PATCH endpoint, and its
// client wiring must stay gone.
if (
    html.includes("pantry-enabled") ||
    html.includes("Use Pantry") ||
    js.includes("pantry-enabled") ||
    routes.includes('app.patch("/api/app/pantry/settings"')
) {
    throw new Error(
        "The retired per-page Pantry switch resurfaced; the feature-module flag is the only Pantry gate",
    );
}

// The iOS boot/flow smoke (MunchSmokeTests.swift, Step 6) proves the
// Pantry shell rendered by waiting for the search field's "Search
// Pantry" label, which lives inside #workspace — pantry.js only
// unhides the workspace after the feature-module gate passes. The
// smoke kept waiting for the retired switch's text after #258, which
// failed every post-#258 iOS smoke run while the page itself rendered
// fine (its failure hierarchy showed the full shell). Keep the two
// sides coupled: the marker the smoke waits for must be text the
// shipped page renders, and the retired switch text must never come
// back as a smoke expectation.
if (
    iosSmoke.includes('waitForText("Use Pantry"') ||
    !iosSmoke.includes('waitForText("Search Pantry"') ||
    !html.includes("Search Pantry")
) {
    throw new Error(
        "iOS smoke Pantry shell marker drifted from the shipped Pantry page; update MunchSmokeTests.swift and public/pantry.html together",
    );
}

for (const endpoint of [
    "/api/app/pantry/settings",
    "/api/app/pantry/reconcile",
    "/api/app/pantry/scan-preview",
    "/api/app/pantry/meal-ideas",
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
if (!normalizedRoutes.includes("resolveRequestMunchCapabilities(c, userId)")) {
    throw new Error(
        "Pantry route is missing capability resolution for household scope authorization",
    );
}
if (
    routes.includes("premium_required") ||
    routes.includes("premiumContext") ||
    js.includes("premium-message") ||
    html.includes("premium-message")
) {
    throw new Error(
        "Pantry carries a Premium wall; Pantry is free for every account (Amendment D)",
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
// S6 slice 2 (Amendment F): Pantry is themed in Editorial Serif, voiced
// inside its own stylesheet (the S4 / PR #187 mechanism — editorial.css
// is the flagship/public stylesheet and is NOT loaded by this signed-in
// surface). The old Inter world must stay gone, and the location filter
// is a single-row chip group, not the retired select.
if (!html.includes('href="/pantry.css"') || html.includes("editorial.css")) {
    throw new Error(
        "Pantry must load only its own Serif-voiced pantry.css, not editorial.css",
    );
}
if (
    css.includes("Inter") ||
    css.includes("#f7f7f4") ||
    !css.includes("#f6f1e7") ||
    !css.includes("#fffdf8") ||
    !css.includes("#d8cdb6") ||
    !css.includes("#176b3a") ||
    !css.includes('Georgia, "Times New Roman", Times, serif')
) {
    throw new Error(
        "Pantry stylesheet is not voiced in the Editorial Serif tokens",
    );
}
if (
    !html.includes('id="location-chips"') ||
    html.includes('id="location-filter"')
) {
    throw new Error(
        "Pantry location filter must be the chip row, not the retired select",
    );
}
if (/ad-slot|adsbygoogle|MunchAds|data-ad/.test(html + js + css)) {
    throw new Error(
        "Pantry carries an ad placement; the app's only ad slot is on Today (final ad law)",
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
if (
    !html.includes("whole kitchen") ||
    !html.includes("spices, sauces, condiments") ||
    !routes.includes("generatePantryMealIdeas")
) {
    throw new Error(
        "Pantry meal planning does not preserve the deliberate full-kitchen contract",
    );
}
if (
    js.includes("mealIdeasEl.innerHTML") ||
    js.includes("candidate.description}`")
) {
    throw new Error(
        "AI meal-idea strings must be rendered with safe text nodes",
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
// The disclosure phrases are prose: HTML line wrapping (Prettier) may split
// them across lines, so match prose phrases against whitespace-collapsed
// text. The <strong> markup check stays against the raw HTML.
const privacyProse = privacy.replace(/\s+/g, " ");
if (
    !privacyProse.includes("Pantry and receipt images") ||
    !privacyProse.includes("Pantry meal planning") ||
    !privacy.includes("<strong>OpenRouter</strong>") ||
    !privacyProse.includes("not a promise of zero retention")
) {
    throw new Error("Pantry image-processing privacy disclosure is incomplete");
}

console.log("Munch Pantry web surface static smoke test passed.");
