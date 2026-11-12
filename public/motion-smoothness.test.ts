import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (name: string) =>
    readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

// Motion pass (design-authority-addendum-motion.md). These pins keep
// the three ruled behaviors from silently regressing:
//   1. The two bottom-bar copies (app shell vs standalone Pantry page)
//      carry identical metrics — the Pantry copy once referenced
//      custom properties defined nowhere in its stylesheet and
//      inherited a different font/line-height, and the bar visibly
//      shrank by 2.65px on arrival.
//   2. Startup is the Munch mark on paper; in-view loading is held
//      skeleton layout with the label kept for screen readers only.
//   3. Shared motion tokens drive view/dialog transitions, dialog
//      closes route through one animated helper, and
//      prefers-reduced-motion collapses the scale to instant.

const SERIF = 'font-family: Georgia, "Times New Roman", Times, serif;';

function ruleBody(css: string, selector: string, after?: string): string {
    const from = after ? css.indexOf(after) : 0;
    expect(from, `marker ${after} present`).toBeGreaterThan(-1);
    const start = css.indexOf(selector, from);
    expect(start, `selector ${selector} present`).toBeGreaterThan(-1);
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("shared motion tokens", () => {
    test("styles.css and pantry.css declare the same token scale", () => {
        for (const file of ["styles.css", "pantry.css"]) {
            const css = read(file);
            expect(css).toContain(
                "--motion-ease: cubic-bezier(0.16, 1, 0.3, 1);",
            );
            expect(css).toContain("--motion-fast: 120ms;");
            expect(css).toContain("--motion-view: 200ms;");
            expect(css).toContain("--motion-dialog: 240ms;");
        }
    });

    test("both pages collapse the scale under prefers-reduced-motion", () => {
        for (const file of ["app-overrides.css", "pantry.css"]) {
            const css = read(file);
            const block = css.slice(
                css.indexOf("@media (prefers-reduced-motion: reduce)"),
            );
            expect(block).toContain("--motion-view: 0.01ms;");
            expect(block).toContain("--motion-dialog: 0.01ms;");
        }
    });
});

describe("bottom-bar metric parity (addendum rule 1)", () => {
    const overrides = read("app-overrides.css");
    const pantry = read("pantry.css");

    test("pantry.css references no undefined custom properties", () => {
        const code = stripComments(pantry);
        const defined = new Set(
            [...code.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
        );
        const referenced = new Set(
            [...code.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]),
        );
        for (const name of referenced) {
            expect(defined.has(name), `var(${name}) is defined`).toBe(true);
        }
    });

    test("the pantry bar paints the shell's border and ground literally", () => {
        const nav = ruleBody(
            pantry,
            ".mobile-bottom-nav {",
            "@media (max-width: 899px)",
        );
        expect(nav).toContain("border-top: 1px solid #d8cdb6;");
        expect(nav).toContain("background: #fffdf7;");
        expect(nav).toContain(
            "grid-template-columns: repeat(6, minmax(0, 1fr));",
        );
    });

    test("both bars show at the same phone breakpoint", () => {
        expect(pantry).not.toContain("@media (max-width: 900px)");
        expect(pantry).toContain("@media (max-width: 899px)");
    });

    test("pantry anchors declare the shell's font, line-height, color", () => {
        const anchor = ruleBody(pantry, ".mobile-bottom-nav a {");
        expect(anchor).toContain(SERIF);
        expect(anchor).toContain("line-height: 1.6;");
        expect(anchor).toContain("color: #5d5344;");
        expect(anchor).toContain("font-size: 11px;");
    });

    test("shell anchors pin line-height instead of inheriting it", () => {
        const anchor = ruleBody(overrides, ".mobile-bottom-nav a {");
        expect(anchor).toContain(SERIF);
        expect(anchor).toContain("line-height: 1.6;");
        expect(anchor).toContain("color: #5d5344;");
    });

    test("shell stylesheet fallback columns match the six-destination model", () => {
        const nav = ruleBody(
            overrides,
            ".mobile-bottom-nav {",
            "(3b) Bottom nav",
        );
        expect(nav).toContain(
            "grid-template-columns: repeat(6, minmax(0, 1fr));",
        );
    });
});

describe("boot surface (addendum rule 2)", () => {
    const appHtml = read("app.html");
    const appJs = read("app.js");
    const pantryJs = read("pantry.js");

    test("app.html boots on the Munch mark, not skeleton + loading text", () => {
        expect(appHtml).toContain('class="boot-state"');
        expect(appHtml).toContain('src="/brand/munch-mark.svg"');
        expect(appHtml).not.toContain("Loading your Munch workspace…");
        expect(appHtml).toContain('content="#f6f1e7"');
    });

    test("the 12s startup watchdog still sees the boot/loading states", () => {
        expect(appHtml).toContain('".boot-state, .loading-state"');
    });

    test("setLoading keeps the label for screen readers only", () => {
        const setLoading = appJs.slice(
            appJs.indexOf("function setLoading"),
            appJs.indexOf("function errorState"),
        );
        expect(setLoading).toContain('class="sr-only" role="status"');
        expect(setLoading).not.toContain('<p class="spacer-top">');
    });

    test("pantry's first load holds skeleton rows, not a text announcement", () => {
        expect(pantryJs).not.toContain('status("Loading Pantry…")');
        expect(pantryJs).toContain("function renderInventorySkeleton()");
        expect(pantryJs).toContain("inventory-skeleton");
    });
});

describe("transitions (addendum rule 3)", () => {
    const overrides = read("app-overrides.css");
    const appJs = read("app.js");

    test("view switches animate on the shared tokens", () => {
        expect(overrides).toContain("@keyframes munch-view-in");
        const view = ruleBody(overrides, ".operate-view {");
        expect(view).toContain(
            "animation: munch-view-in var(--motion-view) var(--motion-ease);",
        );
    });

    test("dialogs animate in, and out via the .is-closing hook", () => {
        expect(overrides).toContain("@keyframes munch-dialog-in");
        expect(overrides).toContain("@keyframes munch-dialog-out");
        expect(overrides).toContain("dialog.is-closing .auth-card");
        expect(overrides).toContain("dialog.is-closing::backdrop");
    });

    test("every dialog close routes through closeAppDialog", () => {
        expect(appJs).toContain("function closeAppDialog()");
        // The only dialog.close() calls left are the helper's own two
        // (immediate path + deferred path).
        const bare = appJs.match(/dialog\.close\(\)/g) || [];
        expect(bare.length).toBe(2);
        expect(appJs).toContain('dialog.addEventListener("cancel"');
    });
});
