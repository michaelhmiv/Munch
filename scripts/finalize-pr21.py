from __future__ import annotations

import re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, value: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value)


def replace_once(path: str, old: str, new: str) -> None:
    value = read(path)
    if old not in value:
        raise RuntimeError(f"Expected text not found in {path}: {old[:80]!r}")
    write(path, value.replace(old, new, 1))


# Runtime/type environment and CI gates.
replace_once(
    "tsconfig.json",
    '"lib": ["ESNext"],',
    '"lib": ["ESNext", "DOM"],\n        "types": ["bun", "node"],',
)

ci = read(".github/workflows/ci.yml")
if "Run brand check" not in ci:
    ci = ci.replace(
        "      - name: Typecheck server\n        run: bun run typecheck\n",
        "      - name: Check public brand\n        run: bun run brand:check\n\n"
        "      - name: Typecheck server\n        run: bun run typecheck\n",
    )
write(".github/workflows/ci.yml", ci)

# Remove inherited support identity from the in-chat importer.
widget = read("public/widgets/src/templates/import-meals.html")
widget = widget.replace(
    '// depersonalize.ts strips this block; keep the marker comments.\n'
    '            /* support-contact:start */\n'
    '            const SUPPORT_EMAIL = "anton@nutrition-mcp.com";\n'
    '            /* support-contact:end */',
    '// Munch does not embed a maintainer email inside the sandboxed widget.\n'
    '            const SUPPORT_EMAIL = "";',
)
write("public/widgets/src/templates/import-meals.html", widget)

# Preserve the provider identity when an already-classified provider error is wrapped.
errors = read("src/food-providers/errors.ts")
errors = errors.replace(
    "    if (error instanceof FoodProviderError) return error;",
    "    if (error instanceof FoodProviderError) {\n"
    "        if (error.provider || !provider) return error;\n"
    "        return new FoodProviderError(error.code, error.message, {\n"
    "            provider,\n"
    "            retryAfterSeconds: error.retryAfterSeconds,\n"
    "            cause: error.cause,\n"
    "        });\n"
    "    }",
)
write("src/food-providers/errors.ts", errors)

# Brand assets.
brand_svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" role="img" aria-labelledby="title"><title id="title">Munch</title><path fill="#0B8F4D" d="M28 160V39c0-11 9-20 20-20 7 0 13 3 17 9l31 45 31-45c4-6 10-9 17-9 11 0 20 9 20 20v121c0 9-7 16-16 16s-16-7-16-16V83l-23 33c-3 5-8 7-13 7s-10-2-13-7L60 83v77c0 9-7 16-16 16s-16-7-16-16Z"/><circle cx="154" cy="40" r="20" fill="#FCFDF9"/><circle cx="171" cy="27" r="7" fill="#A8D90F"/><circle cx="178" cy="49" r="6" fill="#A8D90F"/><circle cx="170" cy="68" r="5" fill="#A8D90F"/></svg>'''
brand_dark = brand_svg.replace("#FCFDF9", "#16221B")
brand_white = brand_svg.replace("#0B8F4D", "#FFFFFF").replace("#FCFDF9", "#07502F")
write("public/brand/munch-mark.svg", brand_svg)
write("public/brand/munch-mark-dark.svg", brand_dark)
write("public/brand/munch-mark-white.svg", brand_white)


def mark_image(size: int, background=(0, 0, 0, 0)) -> Image.Image:
    im = Image.new("RGBA", (size, size), background)
    d = ImageDraw.Draw(im)
    s = size / 192
    green = "#0B8F4D"
    lime = "#A8D90F"
    # Rounded vertical stems and central chevrons.
    d.rounded_rectangle((28*s, 19*s, 60*s, 176*s), radius=16*s, fill=green)
    d.rounded_rectangle((132*s, 19*s, 164*s, 176*s), radius=16*s, fill=green)
    d.polygon([(48*s, 28*s), (96*s, 96*s), (83*s, 118*s), (40*s, 60*s)], fill=green)
    d.polygon([(144*s, 28*s), (96*s, 96*s), (109*s, 118*s), (152*s, 60*s)], fill=green)
    # Transparent bite.
    d.ellipse((134*s, 20*s, 174*s, 60*s), fill=background)
    d.ellipse((164*s, 20*s, 178*s, 34*s), fill=lime)
    d.ellipse((172*s, 43*s, 184*s, 55*s), fill=lime)
    d.ellipse((165*s, 63*s, 175*s, 73*s), fill=lime)
    return im

brand_dir = ROOT / "public/brand"
mark_image(192).save(brand_dir / "munch-mark-192.png")
mark_image(512).save(brand_dir / "munch-mark-512.png")
mark_image(180, (252, 253, 249, 255)).save(ROOT / "public/apple-touch-icon.png")
mark_image(256, (252, 253, 249, 255)).save(ROOT / "public/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

og = Image.new("RGB", (1200, 630), "#FCFDF9")
d = ImageDraw.Draw(og)
logo = mark_image(230, (252, 253, 249, 255)).convert("RGB")
og.paste(logo, (92, 190))
try:
    title_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 66)
    body_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 30)
except OSError:
    title_font = body_font = ImageFont.load_default()
d.text((365, 190), "Persistent nutrition", font=title_font, fill="#16221B")
d.text((365, 270), "for ChatGPT", font=title_font, fill="#0B8F4D")
d.text((370, 375), "Secure history, verified food data, and tools", font=body_font, fill="#55635B")
d.text((370, 420), "$4.99/month after a 7-day free trial", font=body_font, fill="#55635B")
og.save(ROOT / "public/og.png")

# Use the native mark on the public site and add a reusable CSS hook.
for page in ["public/index.html", "public/login.html", "public/privacy.html", "public/terms.html", "public/tools.html"]:
    value = read(page)
    value = re.sub(
        r'<span class="brand-mark"[^>]*>M</span>',
        '<img class="brand-logo" src="/brand/munch-mark.svg" alt="">',
        value,
    )
    write(page, value)

css = read("public/styles.css")
if ".brand-logo" not in css:
    css += "\n.brand-logo { width: 36px; height: 36px; flex: 0 0 auto; }\n.auth-brand-panel .brand-logo, .portal-header .brand-logo { filter: none; }\n"
write("public/styles.css", css)

# Serve the native brand files.
index_ts = read("src/index.ts")
if "const BRAND_ASSETS" not in index_ts:
    marker = 'app.get("/robots.txt", async (c) =>\n'
    asset_routes = '''const BRAND_ASSETS: Record<string, { file: string; contentType: string }> = {
    "/brand/munch-mark.svg": { file: "./public/brand/munch-mark.svg", contentType: "image/svg+xml" },
    "/brand/munch-mark-dark.svg": { file: "./public/brand/munch-mark-dark.svg", contentType: "image/svg+xml" },
    "/brand/munch-mark-white.svg": { file: "./public/brand/munch-mark-white.svg", contentType: "image/svg+xml" },
    "/brand/munch-mark-192.png": { file: "./public/brand/munch-mark-192.png", contentType: "image/png" },
    "/brand/munch-mark-512.png": { file: "./public/brand/munch-mark-512.png", contentType: "image/png" },
};
for (const [route, asset] of Object.entries(BRAND_ASSETS)) {
    app.get(route, async (c) =>
        c.body(await Bun.file(asset.file).arrayBuffer(), 200, {
            "Content-Type": asset.contentType,
            "Cache-Control": "public, max-age=86400",
        }),
    );
}

'''
    index_ts = index_ts.replace(marker, asset_routes + marker)
write("src/index.ts", index_ts)

# Cohesive OAuth screens using the shared green design system.
oauth = read("src/oauth-platform/routes.ts")
oauth_block = r'''function oauthShell(title: string, content: string): string {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0B8F4D"><title>${escapeHtml(title)} — Munch</title><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/styles.css"></head>
<body class="auth-page"><div class="auth-layout"><aside class="auth-brand-panel"><a class="brand" href="/"><img class="brand-logo" src="/brand/munch-mark-white.svg" alt=""><span>Munch</span></a><div class="auth-brand-copy"><p class="eyebrow">Secure ChatGPT connection</p><h1>Nutrition memory for <span>ChatGPT.</span></h1><p>Munch stores your structured nutrition history and exposes only the tools you authorize.</p></div><p class="tiny">Munch does not train models on your nutrition records. ChatGPT data handling is governed by OpenAI and your ChatGPT settings.</p></aside><main class="auth-main"><section class="auth-card">${content}</section></main></div></body></html>`;
}

function signInPage(sessionId: string): string {
    return oauthShell(
        "Connect Munch",
        `<p class="section-kicker">Step 1 of 2</p><h1>Sign in to Munch</h1><p>Enter your email and use the single-use link we send. You will return here to approve ChatGPT access.</p><form class="auth-form" method="post" action="/oauth/request-login"><input type="hidden" name="session_id" value="${escapeHtml(sessionId)}"><div class="field"><label for="email">Email</label><input id="email" type="email" name="email" autocomplete="email" required maxlength="320"></div><button class="button button-primary" type="submit">Send secure sign-in link</button></form><p class="auth-footnote">By continuing, you agree to the <a href="/terms">Terms</a> and acknowledge the <a href="/privacy">Privacy Policy</a>.</p>`,
    );
}

function checkEmailPage(developmentLoginUrl?: string): string {
    return oauthShell(
        "Check your email",
        `<p class="section-kicker">Secure sign-in</p><h1>Check your email</h1><p>Open the single-use Munch link to continue connecting ChatGPT. The link expires automatically.</p>${
            developmentLoginUrl
                ? `<p class="notice spacer-top">Development only: <a href="${escapeHtml(developmentLoginUrl)}">open sign-in link</a></p>`
                : ""
        }<div class="portal-actions"><a class="button button-secondary" href="/">Return home</a></div>`,
    );
}

function consentPage(input: {
    sessionId: string;
    clientName: string | null;
    redirectUri: string;
}): string {
    const client = input.clientName ?? "ChatGPT or this MCP client";
    return oauthShell(
        "Authorize Munch",
        `<p class="section-kicker">Step 2 of 2</p><h1>Authorize this connection</h1><div class="consent-client"><strong>${escapeHtml(client)}</strong><p>Return destination: ${escapeHtml(new URL(input.redirectUri).origin)}</p></div><p>Approval lets this client call Munch tools to read and write nutrition records on your behalf. It does not grant access to billing credentials or unrelated conversations.</p><form class="consent-actions" method="post" action="/oauth/decision"><input type="hidden" name="session_id" value="${escapeHtml(input.sessionId)}"><button class="button button-primary" type="submit" name="decision" value="approve">Approve connection</button><button class="button button-quiet" type="submit" name="decision" value="deny">Deny</button></form><p class="auth-footnote">You can revoke this connection later from the Munch account portal.</p>`,
    );
}
'''
oauth, count = re.subn(
    r"function signInPage\(sessionId: string\): string \{.*?\nfunction tokenResponse\(",
    oauth_block + "\nfunction tokenResponse(",
    oauth,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError("OAuth page block replacement failed")
write("src/oauth-platform/routes.ts", oauth)

# Compact account/control center, not a standalone nutrition dashboard.
portal = read("src/portal/routes.ts")
portal_function = r'''function page(input: {
    email: string;
    subscriptionStatus: string;
    accessAllowed: boolean;
    timezone: string;
    weightUnit: string | null;
    drinkUnit: string | null;
    widgetsEnabled: boolean;
    alcoholEnabled: boolean;
    connections: Array<{ tokenFamilyId: string; clientName: string | null; clientId: string; expiresAt: string }>;
    savedFoods: Array<{ id: string; label: string; useCount: number }>;
}): string {
    const connections = input.connections.length
        ? input.connections.map((connection) => `<li><div><strong>${escapeHtml(connection.clientName ?? "ChatGPT / MCP client")}</strong><small>${escapeHtml(connection.clientId)} · expires ${escapeHtml(connection.expiresAt)}</small></div><button class="button button-quiet button-small" data-revoke="${escapeHtml(connection.tokenFamilyId)}">Revoke</button></li>`).join("")
        : "<li><div><strong>No active connections</strong><small>Connect Munch from ChatGPT to see it here.</small></div></li>";
    const savedFoods = input.savedFoods.length
        ? input.savedFoods.map((food) => `<li><div><strong>${escapeHtml(food.label)}</strong><small>used ${food.useCount} times</small></div></li>`).join("")
        : "<li><div><strong>No saved foods yet</strong><small>Ask ChatGPT to save a food or recurring meal.</small></div></li>";

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0B8F4D"><title>Munch account</title><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/styles.css"></head><body class="portal-page"><header class="portal-header"><div class="container portal-header-inner"><a class="brand" href="/"><img class="brand-logo" src="/brand/munch-mark-white.svg" alt=""><span>Munch</span></a><button class="button button-quiet button-small" id="logout">Sign out</button></div></header><main class="portal-main"><div class="container"><div class="portal-welcome"><div><p class="section-kicker">Account control center</p><h1>Your Munch account</h1><p>${escapeHtml(input.email)}</p></div><span class="status-pill">${escapeHtml(input.subscriptionStatus)}${input.accessAllowed ? " · ChatGPT access active" : " · access limited"}</span></div><p id="message" class="message-bar" role="status"></p><div class="portal-grid"><section class="portal-card wide"><h2>ChatGPT connections</h2><p>Authorized clients can call Munch nutrition tools. Revoke anything you no longer recognize or use.</p><ul class="portal-list">${connections}</ul></section><section class="portal-card"><h2>Billing</h2><p>One plan: $4.99/month after the seven-day trial. Stripe hosts payment methods, invoices, cancellation, and subscription changes.</p><div class="portal-actions"><button class="button button-primary" id="billing">Manage billing in Stripe</button></div></section><section class="portal-card"><h2>Your data</h2><p>Download your meal history or manage saved foods conversationally through ChatGPT.</p><ul class="portal-list">${savedFoods}</ul><div class="portal-actions"><button class="button button-secondary" id="export">Export meal history</button></div></section><section class="portal-card wide"><h2>Preferences</h2><form id="preferences" class="portal-form"><div class="field"><label for="timezone">Timezone</label><input id="timezone" name="timezone" value="${escapeHtml(input.timezone)}" required></div><div class="field"><label for="weight-unit">Weight unit</label><select id="weight-unit" name="preferred_weight_unit"><option value="">No preference</option><option value="kg"${input.weightUnit === "kg" ? " selected" : ""}>kg</option><option value="lb"${input.weightUnit === "lb" ? " selected" : ""}>lb</option></select></div><label class="checkbox-row"><input type="checkbox" name="widgets_enabled"${input.widgetsEnabled ? " checked" : ""}> Show interactive widgets</label><label class="checkbox-row"><input type="checkbox" name="alcohol_tracking_enabled"${input.alcoholEnabled ? " checked" : ""}> Enable alcohol tracking</label><div class="field"><label for="drink-unit">Drink units</label><select id="drink-unit" name="preferred_drink_unit"><option value="">Default</option><option value="us"${input.drinkUnit === "us" ? " selected" : ""}>US</option><option value="uk"${input.drinkUnit === "uk" ? " selected" : ""}>UK</option><option value="metric"${input.drinkUnit === "metric" ? " selected" : ""}>Metric</option></select></div><button class="button button-primary" type="submit">Save preferences</button></form></section><section class="portal-card wide danger"><h2>Delete account</h2><p>This permanently deletes the account, nutrition history, saved foods, drafts, and active connections. Stripe billing should be cancelled separately before deletion.</p><div class="portal-form"><div class="field"><label for="delete-confirmation">Type DELETE MY MUNCH ACCOUNT</label><input id="delete-confirmation" autocomplete="off"></div><button class="button button-danger" id="delete-account">Permanently delete account</button></div></section></div></div></main><script>
const message=document.getElementById('message');
async function post(url,body={}){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Request failed');return data}
function show(text){message.textContent=text}
document.getElementById('preferences').addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);try{await post('/account/portal/preferences',{timezone:form.get('timezone'),preferred_weight_unit:form.get('preferred_weight_unit')||null,widgets_enabled:form.has('widgets_enabled'),alcohol_tracking_enabled:form.has('alcohol_tracking_enabled'),preferred_drink_unit:form.get('preferred_drink_unit')||null});show('Preferences saved.')}catch(error){show(error.message)}});
document.querySelectorAll('[data-revoke]').forEach(button=>button.addEventListener('click',async()=>{try{await post('/account/portal/connections/revoke',{token_family_id:button.dataset.revoke});button.closest('li').remove();show('Connection revoked.')}catch(error){show(error.message)}}));
document.getElementById('billing').addEventListener('click',async()=>{try{const data=await post('/billing/portal');location.href=data.url}catch(error){show(error.message)}});
document.getElementById('export').addEventListener('click',async()=>{try{const data=await post('/account/portal/export');if(data.url)location.href=data.url;else show('There are no meals to export.')}catch(error){show(error.message)}});
document.getElementById('logout').addEventListener('click',async()=>{try{await post('/account/logout');location.href='/'}catch(error){show(error.message)}});
document.getElementById('delete-account').addEventListener('click',async()=>{try{await post('/account/portal/delete',{confirmation:document.getElementById('delete-confirmation').value});location.href='/?deleted=1'}catch(error){show(error.message)}});
</script></body></html>`;
}
'''
portal, count = re.subn(
    r"function page\(input: \{.*?\n\}\n\nexport function createPortalRouter",
    portal_function + "\nexport function createPortalRouter",
    portal,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError("Portal page replacement failed")
write("src/portal/routes.ts", portal)

# Unit coverage for trial semantics.
trial_test = '''import { afterEach, describe, expect, mock, test } from "bun:test";
import { createStripeCheckoutSession } from "./stripe-client.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.STRIPE_SECRET_KEY;

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalKey;
});

describe("Stripe Checkout", () => {
    test("creates one recurring subscription with a seven-day trial", async () => {
        process.env.STRIPE_SECRET_KEY = "sk_test_munch";
        let encoded = "";
        globalThis.fetch = mock(async (_url, init) => {
            encoded = String(init?.body ?? "");
            return new Response(JSON.stringify({ id: "cs_test_munch", url: "https://checkout.stripe.test/session", customer: null, subscription: null, payment_status: "unpaid", status: "open", client_reference_id: "user-1" }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;

        await createStripeCheckoutSession({ userId: "user-1", customerEmail: "person@example.com", priceId: "price_munch_monthly", successUrl: "https://munch.test/success", cancelUrl: "https://munch.test/cancel" });
        const params = new URLSearchParams(encoded);
        expect(params.get("mode")).toBe("subscription");
        expect(params.get("line_items[0][quantity]")).toBe("1");
        expect(params.get("subscription_data[trial_period_days]")).toBe("7");
        expect(params.get("subscription_data[metadata][munch_user_id]")).toBe("user-1");
    });
});
'''
write("src/billing/stripe-client.test.ts", trial_test)
