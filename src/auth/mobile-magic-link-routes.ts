import { Hono, type Context } from "hono";
import { requireSameOrigin } from "../accounts/csrf.js";
import {
    buildInstalledMagicLinkDeepLink,
    safeInstalledMagicLinkReturnPath,
} from "./magic-link-url.js";

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function validToken(value: unknown): value is string {
    return typeof value === "string" && value.length >= 20 && value.length <= 2048;
}

function privateHtml(c: Context, html: string) {
    c.header("Cache-Control", "no-store, private");
    c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return c.html(html);
}

function confirmationPage(token: string, returnTo: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#176b3a">
<title>Open Munch</title>
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="auth-page">
<main class="auth-main">
<section class="auth-card">
<a class="brand" href="/" aria-label="Munch home"><img class="brand-logo" src="/brand/munch-mark.svg" alt=""><span>Munch</span></a>
<p class="section-kicker spacer-top">Android sign in</p>
<h1>Open Munch to finish signing in.</h1>
<p>This confirmation keeps automated email scanners from consuming your single-use sign-in link. Continue only on a device where you installed Munch.</p>
<form class="auth-form" method="post" action="/mobile/confirm">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
<button class="button button-primary" type="submit">Open Munch</button>
</form>
<p class="auth-footnote">The link is single-use and expires automatically. If you did not request it, close this page.</p>
</section>
</main>
</body>
</html>`;
}

export function createMobileMagicLinkRouter(): Hono {
    const app = new Hono();

    app.get("/mobile/confirm", (c) => {
        const token = c.req.query("token");
        if (!validToken(token)) return c.redirect("/connect/error", 303);
        const returnTo = safeInstalledMagicLinkReturnPath(
            c.req.query("return_to"),
        );
        return privateHtml(c, confirmationPage(token, returnTo));
    });

    app.post("/mobile/confirm", requireSameOrigin, async (c) => {
        const body = await c.req.parseBody();
        const token = body.token;
        if (!validToken(token)) return c.redirect("/connect/error", 303);
        return c.redirect(
            buildInstalledMagicLinkDeepLink({
                token,
                returnTo: safeInstalledMagicLinkReturnPath(body.return_to),
            }),
            303,
        );
    });

    return app;
}
