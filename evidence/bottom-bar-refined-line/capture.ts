// Phone-width captures of the Refined Line bottom bar, taken against
// the shipped static files (public/) served as-is. The app shell's
// active-tab marking is applied by app.js at runtime; without the
// API the shell cannot finish booting, so for app.html this script
// performs the same two operations app.js performs
// (classList "is-active" + aria-current="page") on the Today anchor
// and screenshots the result. pantry.html ships with its Pantry
// anchor already active, exactly as production serves it.
import { chromium } from "playwright";
import { join } from "node:path";

const publicDir = join(import.meta.dir, "..", "..", "public");
const outDir = import.meta.dir;

const server = Bun.serve({
    port: 0,
    async fetch(req) {
        const url = new URL(req.url);
        const path =
            url.pathname === "/app"
                ? "/app.html"
                : url.pathname === "/app/pantry"
                  ? "/pantry.html"
                  : url.pathname;
        const file = Bun.file(join(publicDir, path));
        if (await file.exists()) return new Response(file);
        return new Response("not found", { status: 404 });
    },
});
const base = `http://127.0.0.1:${server.port}`;

const browser = await chromium.launch();
const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
});

// App shell — active tab: Today.
await page.goto(`${base}/app`, { waitUntil: "load" });
await page.waitForSelector(".mobile-bottom-nav a");
await page.evaluate(() => {
    const link = document.querySelector(
        '.mobile-bottom-nav a[data-route="today"]',
    );
    if (link && !link.classList.contains("is-active")) {
        link.classList.add("is-active");
        link.setAttribute("aria-current", "page");
    }
});
await page
    .locator(".mobile-bottom-nav")
    .screenshot({ path: join(outDir, "app-shell-today-bar.png") });
await page.screenshot({ path: join(outDir, "app-shell-today-full.png") });

// Standalone Pantry page — active tab: Pantry (as shipped).
await page.goto(`${base}/app/pantry`, { waitUntil: "load" });
await page.waitForSelector(".mobile-bottom-nav a.is-active");
await page
    .locator(".mobile-bottom-nav")
    .screenshot({ path: join(outDir, "pantry-bar.png") });
await page.screenshot({ path: join(outDir, "pantry-full.png") });

await browser.close();
server.stop();
console.log("captures written to", outDir);
