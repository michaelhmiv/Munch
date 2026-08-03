import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { createOAuthRouter } from "./oauth.js";
import {
    authenticateBearer,
    rateLimit,
    banRepeatAuthFailures,
} from "./middleware.js";
import { handleMcp } from "./mcp.js";
import { startExportCleanup } from "./export.js";
import { getLandingStats, type LandingStats } from "./supabase.js";
import { registerDiscoveryRoutes } from "./discovery.js";
import { maskIp } from "./net.js";
import { warmWidgets } from "./widgets.js";
import { createBillingRouter } from "./billing/routes.js";

const app = new Hono();

// Access log — records route-level operational metadata only. It deliberately
// excludes request and response bodies so nutrition records, account details,
// Stripe payloads, and OAuth credentials never enter routine logs.
app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/health") return next();
    const start = performance.now();
    await next();
    if (c.get("suppressAccessLog")) return;
    const ms = Math.round(performance.now() - start);
    const ip = maskIp(c.req.header("x-forwarded-for"));
    console.log(
        `[req] ${c.req.method} ${path} ${c.res.status} ${ms}ms ip=${ip}`,
    );
});

// Security headers. Munch does not load advertising or behavioral analytics.
app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    if (!c.res.headers.get("Content-Security-Policy")) {
        c.header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self'; frame-ancestors 'none'",
        );
    }
    c.header("Referrer-Policy", "no-referrer");
});

// Body limit
app.use(
    "*",
    bodyLimit({
        maxSize: 1024 * 1024,
        onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
);

// CORS
app.use(
    "*",
    cors({
        origin: (origin) => {
            if (!origin) return null;
            if (
                origin.match(/^https?:\/\/localhost(:\d+)?$/) ||
                origin.match(/^https?:\/\/127\.0\.0\.1(:\d+)?$/)
            ) {
                return origin;
            }
            const allowed =
                process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ??
                [];
            return allowed.includes(origin) ? origin : null;
        },
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: [
            "Content-Type",
            "Authorization",
            "Mcp-Session-Id",
            "Mcp-Protocol-Version",
            "Last-Event-ID",
            "Accept",
            "Stripe-Signature",
        ],
        exposeHeaders: [
            "Mcp-Session-Id",
            "Mcp-Protocol-Version",
            "Content-Type",
        ],
        credentials: false,
        maxAge: 86400,
    }),
);

// OAuth discovery metadata (MCP spec requirement) — protected-resource and
// authorization-server documents, served at the root and at the path-folded
// variants clients derive from the /mcp endpoint. See src/discovery.ts.
registerDiscoveryRoutes(app);

// Commercial platform routes. Checkout and portal endpoints are added after the
// Munch web-session middleware lands; the signed Stripe webhook is active now.
app.route("/", createBillingRouter());

// Inherited OAuth routes remain active until the Railway-native identity and MCP
// OAuth cutover is complete.
app.route("/", createOAuthRouter());

// MCP endpoint (protected). banRepeatAuthFailures runs first so a client stuck
// in a failed-auth retry loop is rejected before any token verification.
app.all(
    "/mcp",
    banRepeatAuthFailures,
    authenticateBearer,
    rateLimit,
    handleMcp,
);

// Aggregate landing-page stats, cached in-memory so page views don't each hit
// the DB. This inherited Supabase-backed route is removed during persistence
// cutover.
const STATS_TTL_MS = 5 * 60 * 1000;
let statsCache: { data: LandingStats; expiresAt: number } | null = null;

app.get("/api/stats", async (c) => {
    try {
        if (!statsCache || statsCache.expiresAt < Date.now()) {
            statsCache = {
                data: await getLandingStats(),
                expiresAt: Date.now() + STATS_TTL_MS,
            };
        }
        return c.json(statsCache.data, 200, {
            "Cache-Control": "public, max-age=300",
        });
    } catch {
        console.error("Failed to load landing stats");
        if (statsCache) return c.json(statsCache.data);
        return c.json({ error: "stats_unavailable" }, 503);
    }
});

// Static world-map data (land dot-matrix + projected timezone coords) for the
// landing page. Generated offline; safe to cache aggressively.
app.get("/map-data.json", async (c) => {
    return c.body(await Bun.file("./public/map-data.json").text(), 200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
    });
});

// Static images (social card + touch icon)
app.get("/og.png", async (c) => {
    return c.body(await Bun.file("./public/og.png").arrayBuffer(), 200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
    });
});
app.get("/apple-touch-icon.png", async (c) => {
    return c.body(
        await Bun.file("./public/apple-touch-icon.png").arrayBuffer(),
        200,
        {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
        },
    );
});

// SEO crawl files
app.get("/robots.txt", async (c) => {
    return c.body(await Bun.file("./public/robots.txt").text(), 200, {
        "Content-Type": "text/plain",
    });
});
app.get("/sitemap.xml", async (c) => {
    return c.body(await Bun.file("./public/sitemap.xml").text(), 200, {
        "Content-Type": "application/xml",
    });
});
app.get("/llms.txt", async (c) => {
    return c.body(await Bun.file("./public/llms.txt").text(), 200, {
        "Content-Type": "text/plain; charset=utf-8",
    });
});

// Landing page
app.get("/", async (c) => {
    return c.html(await Bun.file("./public/index.html").text());
});

// Privacy Policy
app.get("/privacy", async (c) => {
    return c.html(await Bun.file("./public/privacy.html").text());
});
app.get("/privacy/", (c) => c.redirect("/privacy", 301));

// Terms of Service
app.get("/terms", async (c) => {
    return c.html(await Bun.file("./public/terms.html").text());
});
app.get("/terms/", (c) => c.redirect("/terms", 301));

// Tools reference — the full list of MCP tools with descriptions and examples.
app.get("/tools", async (c) => {
    return c.html(await Bun.file("./public/tools.html").text());
});
app.get("/tools/", (c) => c.redirect("/tools", 301));

// Inherited comparison pages remain until the Munch public site is replaced.
const ALT_PAGES: Record<string, string> = {
    "/alternatives": "alternatives/index.html",
    "/myfitnesspal-mcp": "alternatives/myfitnesspal.html",
    "/cronometer-mcp": "alternatives/cronometer.html",
    "/lose-it-mcp": "alternatives/lose-it.html",
    "/macrofactor-mcp": "alternatives/macrofactor.html",
    "/yazio-mcp": "alternatives/yazio.html",
    "/lifesum-mcp": "alternatives/lifesum.html",
};
for (const [path, file] of Object.entries(ALT_PAGES)) {
    app.get(path, async (c) =>
        c.html(await Bun.file(`./public/${file}`).text()),
    );
    app.get(`${path}/`, (c) => c.redirect(path, 301));
}

// CSS
app.get("/styles.css", async (c) => {
    const file = Bun.file("./public/styles.css");
    return c.body(await file.text(), 200, { "Content-Type": "text/css" });
});

// Favicon endpoint
app.get("/favicon.ico", async (c) => {
    try {
        const file = Bun.file("./public/favicon.ico");
        return c.body(await file.arrayBuffer(), 200, {
            "Content-Type": "image/x-icon",
        });
    } catch {
        return c.notFound();
    }
});

// Health check
app.get("/health", (c) => c.text("ok"));

// Error handler
app.onError((_err, c) => {
    console.error("Unhandled application error");
    return c.json({ error: "internal_server_error" }, 500);
});

const port = parseInt(process.env.PORT || "8080");

console.log(`Munch server listening on 0.0.0.0:${port}`);

// Assemble every MCP Apps widget from its source partials up front, so a broken
// @include/partial fails fast at boot rather than on a client's first tool call.
await warmWidgets();

// Periodically delete expired meal-export files from the inherited storage
// implementation. This is replaced during Railway persistence cutover.
startExportCleanup();

let shuttingDown = false;
function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default {
    port,
    hostname: "0.0.0.0",
    idleTimeout: 120,
    fetch: app.fetch,
};
