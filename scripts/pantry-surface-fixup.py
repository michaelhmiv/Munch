from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Expected surface marker missing in {path}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


# Make Pantry a normal first-class destination. It intentionally has no
# data-route attribute because it is a dedicated page rather than an SPA route.
app = Path("public/app.html")
text = app.read_text()
desktop_marker = '''                    <a data-route="groceries" href="/app/groceries"
                        ><span class="nav-icon">✓</span
                        ><span>Groceries</span></a
                    >
                    <a data-route="household" href="/app/household"'''
desktop_replacement = '''                    <a data-route="groceries" href="/app/groceries"
                        ><span class="nav-icon">✓</span
                        ><span>Groceries</span></a
                    >
                    <a href="/app/pantry"
                        ><span class="nav-icon">▦</span><span>Pantry</span></a
                    >
                    <a data-route="household" href="/app/household"'''
if desktop_marker in text:
    text = text.replace(desktop_marker, desktop_replacement, 1)
elif text.count('href="/app/pantry"') < 1:
    raise SystemExit("Desktop Pantry navigation marker missing")

mobile_marker = '''            <a data-route="groceries" href="/app/groceries"
                ><span>✓</span><span>Groceries</span></a
            >
            <a data-route="more" href="/app/more"'''
mobile_replacement = '''            <a data-route="groceries" href="/app/groceries"
                ><span>✓</span><span>Groceries</span></a
            >
            <a href="/app/pantry"><span>▦</span><span>Pantry</span></a>
            <a data-route="more" href="/app/more"'''
if mobile_marker in text:
    text = text.replace(mobile_marker, mobile_replacement, 1)
elif text.count('href="/app/pantry"') < 2:
    raise SystemExit("Mobile Pantry navigation marker missing")
app.write_text(text)

styles = Path("public/styles.css")
text = styles.read_text()
mobile_grid = '''        background: rgb(255 255 255 / 0.96);
        backdrop-filter: blur(18px);
        grid-template-columns: repeat(5, 1fr);'''
if mobile_grid in text:
    text = text.replace(
        mobile_grid,
        '''        background: rgb(255 255 255 / 0.96);
        backdrop-filter: blur(18px);
        grid-template-columns: repeat(6, 1fr);''',
        1,
    )
elif "grid-template-columns: repeat(6, 1fr);" not in text:
    raise SystemExit("Mobile navigation grid marker missing")
styles.write_text(text)

pantry_html = Path("public/pantry.html")
text = pantry_html.read_text()
text = text.replace('href="/app/planning"', 'href="/app/plan"')
pantry_html.write_text(text)

privacy = Path("public/privacy.html")
text = privacy.read_text()
text = text.replace(
    "nutrition, recipe, planning, grocery, and household records",
    "nutrition, recipe, planning, grocery, Pantry, and household records",
)
text = text.replace(
    "consumer nutrition, recipe, and meal-planning\n                        service",
    "consumer nutrition, recipe, meal-planning, and Pantry\n                        inventory service",
)
text = text.replace(
    "Last updated: August 11, 2026",
    "Last updated: August 24, 2026",
)
recipe_item = '''                            <li>
                                Recipes, immutable recipe revisions,
                                ingredients, instructions, servings, factual
                                nutrition, source provenance, planned meals, and
                                grocery-list items.
                            </li>'''
if "Optional Premium Pantry inventory" not in text:
    if recipe_item not in text:
        raise SystemExit("Privacy recipe data marker missing")
    text = text.replace(
        recipe_item,
        recipe_item
        + '''
                            <li>
                                Optional Premium Pantry inventory, exact or
                                approximate quantities, storage locations,
                                inventory-event history, and structured
                                purchase or receipt reconciliation results.
                                Munch does not retain raw Pantry or receipt
                                images after the website extraction request is
                                processed.
                            </li>''',
        1,
    )
text = text.replace(
    "recipes, meal-plan instructions, grocery items, or\n                            account instructions.",
    "recipes, meal-plan instructions, grocery items, Pantry\n                            inventory changes, or account instructions.",
)
text = text.replace(
    "grocery lists, household display names, roles, and\n                            factual activity attribution.",
    "grocery lists, shared Pantry inventory, household display\n                            names, roles, and factual activity attribution.",
)
why_marker = '''                        <h3>Why it is stored</h3>'''
if "Pantry and receipt images" not in text:
    if why_marker not in text:
        raise SystemExit("Privacy purpose marker missing")
    text = text.replace(
        why_marker,
        '''                        <h3>Pantry and receipt images</h3>
                        <p>
                            When an eligible Premium user uploads a Pantry,
                            refrigerator, freezer, or grocery-receipt image
                            through the Munch website, Munch sends that image
                            transiently to its configured AI processor to
                            extract structured food or purchase candidates. The
                            raw image is not written to the Munch PostgreSQL
                            database or account export. Uncertain detections are
                            presented for review before they can change Pantry
                            inventory. Images uploaded directly to ChatGPT are
                            handled by ChatGPT under OpenAI's policies; Munch
                            receives only the structured tool arguments ChatGPT
                            sends to the connected Munch app.
                        </p>
''' + why_marker,
        1,
    )
openai_li = '''                            <li>
                                <strong>OpenAI/ChatGPT</strong> processes the
                                conversation and decides what tool arguments to
                                send to Munch.
                            </li>'''
if "<strong>OpenRouter</strong>" not in text:
    if openai_li not in text:
        raise SystemExit("Privacy OpenAI provider marker missing")
    text = text.replace(
        openai_li,
        '''                            <li>
                                <strong>OpenRouter</strong> receives Pantry or
                                receipt images uploaded through the Munch
                                website when AI-assisted extraction is enabled.
                                Munch requests routing with provider data
                                collection disabled. That routing preference is
                                not a promise of zero retention, and the
                                processors selected through OpenRouter remain
                                subject to their applicable privacy and
                                retention practices.
                            </li>
''' + openai_li,
        1,
    )
privacy.write_text(text)

ui_smoke = Path("scripts/pantry-ui-smoke.ts")
text = ui_smoke.read_text()
old_header = '''const [html, js, css, routes, index] = await Promise.all([
    Bun.file("public/pantry.html").text(),
    Bun.file("public/pantry.js").text(),
    Bun.file("public/pantry.css").text(),
    Bun.file("src/inventory/routes.ts").text(),
    Bun.file("src/index.ts").text(),
]);'''
new_header = '''const [html, js, css, routes, index, appHtml, appStyles, privacy] =
    await Promise.all([
        Bun.file("public/pantry.html").text(),
        Bun.file("public/pantry.js").text(),
        Bun.file("public/pantry.css").text(),
        Bun.file("src/inventory/routes.ts").text(),
        Bun.file("src/index.ts").text(),
        Bun.file("public/app.html").text(),
        Bun.file("public/styles.css").text(),
        Bun.file("public/privacy.html").text(),
    ]);'''
if old_header in text:
    text = text.replace(old_header, new_header, 1)
elif "appHtml, appStyles, privacy" not in text:
    raise SystemExit("Pantry UI smoke header marker missing")

footer_marker = '''if (/receipt_image|raw_image|image_bytes/.test(routes)) {
    throw new Error(
        "Pantry route source suggests raw receipt media persistence",
    );
}

console.log("Munch premium Pantry web surface static smoke test passed.");'''
footer_replacement = '''if (/receipt_image|raw_image|image_bytes/.test(routes)) {
    throw new Error(
        "Pantry route source suggests raw receipt media persistence",
    );
}
const pantryLinks = appHtml.match(/href="\\/app\\/pantry"/g) ?? [];
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

console.log("Munch premium Pantry web surface static smoke test passed.");'''
if footer_marker in text:
    text = text.replace(footer_marker, footer_replacement, 1)
elif "Pantry is not discoverable from both desktop" not in text:
    raise SystemExit("Pantry UI smoke footer marker missing")
ui_smoke.write_text(text)
