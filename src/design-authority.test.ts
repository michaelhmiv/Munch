/**
 * Design authority — enforced law (DESIGN.md, ratified 2026-11-11).
 *
 * Michael's mandate (Nov 11, 2026): "Those design rules need to be LAW."
 * This suite is the enforcement teeth. It parses the production
 * stylesheets (declarations, not screenshots) and FAILS on drift:
 *
 *  (a) Retired values are absent from public/ stylesheets and markup.
 *  (b) The shared button tiers resolve to the Direction C spec values,
 *      and the shared token sets resolve to the authority palette.
 *      Drawn geometry is ENFORCED (punch-list P2, resolved 2026-11-13):
 *      buttons and fields draw at the 31px anchor (31px / 6px 14px /
 *      10px radius, dialog cards 14px) and the >=44px hit area is
 *      delivered by the ::after overlay — never by the drawn box.
 *  (c) Gold #8a6d3b appears ONLY in the allow-listed nav-indicator,
 *      calendar-today, and chart-accent selectors below.
 *  (d) Every button-like class in public/ CSS is either spec-verified
 *      by (b) or allow-listed in the registry below, with a reason.
 *  (e) No font-size below the 11px floor outside the allow-listed
 *      chart-annotation selectors (the Trends chart header records the
 *      sanction: "the 11px floor governs UI type, not chart
 *      annotation").
 *  (f) Dialog material: `dialog .auth-card` resolves to the ONE panel
 *      material (#fffdf8), and no CSS rule whose selector starts with
 *      `dialog` paints a dialog white (#fff / #ffffff / white).
 *      Ported from PR #274's dialog check in
 *      scripts/ui-surface-smoke.ts (branch
 *      feat/design-authority-ci-checks), adapted to this suite's
 *      CSS-parser helpers with the same enforcement strength.
 *  (g) Chart palette confinement (punch-list P3, ratified
 *      2026-11-13): the Trends chart palette named in DESIGN.md
 *      (series green #2e5b34, chart ink #22301f, sage #6e7462, sand
 *      #c9bfa3, wash #e6eddc) is chart-only — CSS uses are confined
 *      to the registered chart surfaces in CHART_CSS_SURFACES below,
 *      JS uses to the two Trends chart color maps, and no chart
 *      value is an authority token variable. P3 changed no values;
 *      the recorded text-only exceptions in the registry are the
 *      whole exception list.
 *  (h) Warning family (punch-list P5, ratified 2026-11-13):
 *      warn-line #b98a00 / warn-text #8a6100 are tokens, not
 *      literals — pantry.css and app-overrides.css both define
 *      --warn-line / --warn-text at those values, warning rules
 *      resolve through them, and the near-duplicate #8a6d00 is
 *      retired (it is in RETIRED below, with #ded5c0 from P6).
 *
 * An exception ships only by amending DESIGN.md and the relevant
 * allow-list here, with the reason recorded, in the same PR.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PUBLIC = join(ROOT, "public");

async function readPublic(name: string): Promise<string> {
    return Bun.file(join(PUBLIC, name)).text();
}

function publicFiles(ext: string): string[] {
    return readdirSync(PUBLIC).filter((name) => name.endsWith(ext));
}

/* ---------------- minimal CSS parser ----------------
 * Strips comments (preserving line numbers), flattens @media/@layer/
 * @supports containers, and returns rules with merged-able selector
 * parts and raw declarations. Good enough for declaration assertions;
 * it intentionally does not evaluate the cascade across files. */

type CssRule = {
    selectors: string[];
    declarations: Map<string, string>;
    line: number;
};

function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, (match) =>
        match.replace(/[^\n]/g, " "),
    );
}

function splitSelectors(prelude: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of prelude) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
            parts.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current);
    return parts
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter(Boolean);
}

function parseDeclarations(body: string): Map<string, string> {
    const declarations = new Map<string, string>();
    for (const chunk of body.split(";")) {
        const colon = chunk.indexOf(":");
        if (colon === -1) continue;
        const prop = chunk.slice(0, colon).trim().toLowerCase();
        const value = chunk.slice(colon + 1).trim();
        if (prop && value) declarations.set(prop, value);
    }
    return declarations;
}

function parseCss(css: string): CssRule[] {
    const rules: CssRule[] = [];
    const walk = (text: string, baseLine: number) => {
        let i = 0;
        let line = baseLine;
        let preludeStart = 0;
        let preludeLine = baseLine;
        while (i < text.length) {
            const ch = text[i];
            if (ch === "\n") line++;
            if (ch === "{") {
                const prelude = text.slice(preludeStart, i).trim();
                // find the matching close brace
                let depth = 1;
                let j = i + 1;
                let bodyLine = line;
                while (j < text.length && depth > 0) {
                    if (text[j] === "{") depth++;
                    if (text[j] === "}") depth--;
                    j++;
                }
                const body = text.slice(i + 1, j - 1);
                const bodyLines = body.split("\n").length;
                if (
                    /^@(media|supports|layer)\b/.test(prelude) ||
                    /^@layer\b/.test(prelude)
                ) {
                    walk(body, bodyLine);
                } else if (prelude) {
                    rules.push({
                        selectors: splitSelectors(prelude),
                        declarations: parseDeclarations(body),
                        line: preludeLine,
                    });
                }
                line += bodyLines - 1;
                i = j;
                preludeStart = j;
                preludeLine = line;
                continue;
            }
            if (ch === "}" || ch === ";") {
                preludeStart = i + 1;
                preludeLine = line;
            }
            i++;
        }
    };
    walk(css, 1);
    return rules;
}

type Sheet = {
    name: string;
    rules: CssRule[];
    vars: Map<string, string>;
};

async function loadSheet(name: string): Promise<Sheet> {
    const rules = parseCss(stripComments(await readPublic(name)));
    const vars = new Map<string, string>();
    for (const rule of rules) {
        if (rule.selectors.includes(":root")) {
            for (const [prop, value] of rule.declarations) {
                if (prop.startsWith("--")) vars.set(prop, value);
            }
        }
    }
    return { name, rules, vars };
}

/** Merged declarations for an exact selector (later rules win). */
function declsFor(sheet: Sheet, selector: string): Map<string, string> {
    const merged = new Map<string, string>();
    for (const rule of sheet.rules) {
        if (rule.selectors.includes(selector)) {
            for (const [prop, value] of rule.declarations) {
                merged.set(prop, value);
            }
        }
    }
    return merged;
}

function resolveVars(value: string, vars: Map<string, string>): string {
    let out = value;
    for (let guard = 0; guard < 10; guard++) {
        const start = out.indexOf("var(");
        if (start === -1) break;
        let depth = 0;
        let end = -1;
        for (let i = start; i < out.length; i++) {
            if (out[i] === "(") depth++;
            if (out[i] === ")") {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        if (end === -1) break;
        const inner = out.slice(start + 4, end);
        const comma = inner.indexOf(",");
        const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
        const fallback = comma === -1 ? "" : inner.slice(comma + 1).trim();
        const replacement = vars.get(name) ?? fallback;
        out = out.slice(0, start) + replacement + out.slice(end + 1);
    }
    return out;
}

function normalizeColor(token: string): string {
    const t = token.trim().toLowerCase();
    if (t === "white") return "#ffffff";
    if (t === "black") return "#000000";
    const short = /^#([0-9a-f]{3})$/.exec(t);
    if (short) {
        return `#${short[1]
            .split("")
            .map((c) => c + c)
            .join("")}`;
    }
    return t;
}

/** First color in a (possibly shorthand) declaration value. */
function colorOf(
    declarations: Map<string, string>,
    vars: Map<string, string>,
    ...props: string[]
): string | null {
    for (const prop of props) {
        const raw = declarations.get(prop);
        if (!raw) continue;
        const resolved = resolveVars(raw, vars).toLowerCase();
        if (resolved.includes("transparent")) return "transparent";
        const hex = /#[0-9a-f]{3,8}\b/.exec(resolved);
        if (hex) return normalizeColor(hex[0]);
        const keyword = /\b(white|black|currentcolor|inherit)\b/.exec(resolved);
        if (keyword) return normalizeColor(keyword[1]);
    }
    return null;
}

/* ---------------- the law ---------------- */

const GOLD = "#8a6d3b";
const GREEN = "#176b3a";
const GREEN_DEEP = "#0b3d24";
const INK = "#2b2620";
const INK_SOFT = "#4a4237";
const RULE = "#8a7c63";
const DANGER = "#8c2f22";
const PANEL = "#fffdf8";
const PAPER = "#f6f1e7";

/** (a) Retired values — DESIGN.md "Retired values" table. */
const RETIRED = [
    "#efe9db",
    "#b8a888",
    "#b3261e",
    "#fffdf7",
    "#fffef9",
    // Punch-list P5 (ratified 2026-11-13): warning-amber
    // near-duplicate, consolidated into warn-text #8a6100.
    "#8a6d00",
    // Punch-list P6 (ratified 2026-11-13): --line fallback hairline
    // variant; the one hairline is #d8cdb6.
    "#ded5c0",
    // Punch-list P4 (2026-11-13): the filled-destructive hover/pressed
    // family retires; destructive is transparent per Direction C.
    "#6e241a",
];

/** (c) The ONLY selectors allowed to carry gold. Every entry: reason. */
const GOLD_CSS_ALLOWLIST = new Map<string, string>([
    // Authority §1: gold is reserved for the active-nav dot (shipped
    // nav, PR #259 — lands in this stack via PR #261; seeded here so
    // the stacked merge stays green).
    [
        ".mobile-bottom-nav a.is-active::after",
        "active-nav gold dot (authority §1, PR #259)",
    ],
    // Authority §1: calendar today marker.
    [".cal-day.is-today", "calendar today marker (authority §1)"],
    [
        ".cal-day.is-today .cal-day-num",
        "calendar today marker, day number (authority §1)",
    ],
    // Authority §1: chart accents.
    [".trends-bar.is-weekend", "chart accent: weekend bars (authority §1)"],
    [".trends-rolling", "chart accent: rolling-average line (authority §1)"],
    // Owner ruling, composer wave C6 (approved 2026-11-11): the
    // meal's contribution delta on the composer totals strip is set
    // in gold — the owner's own item spec for that element, recorded
    // here as the one gold-text exception to §1's reservation.
    [
        ".meal-composer-strip-delta",
        "composer wave C6 (owner ruling 2026-11-11): meal contribution delta on the totals strip",
    ],
]);

/** (c) Gold in JS is confined to Trends chart color maps. */
const GOLD_JS_ALLOWLIST = new Map<string, string>([
    [
        "public/app.js::trendsDonutChart",
        "chart accent: macro donut fat segment (authority §1)",
    ],
    [
        "public/app.js::trendsStackedChart",
        "chart accent: meal-split snack segment (authority §1)",
    ],
]);

/** (d) Button-like class registry. "spec" = asserted in (b). */
const BUTTON_CLASS_REGISTRY = new Map<
    string,
    { status: "spec" | "context" | "allow"; reason: string }
>([
    [
        "button",
        {
            status: "spec",
            reason: "shared base control; editorial base is the primary fill, app tiers asserted below",
        },
    ],
    [
        "button-primary",
        { status: "spec", reason: "Direction C primary, asserted in (b)" },
    ],
    [
        "button-secondary",
        { status: "spec", reason: "Direction C secondary, asserted in (b)" },
    ],
    [
        "button-quiet",
        { status: "spec", reason: "Direction C quiet, asserted in (b)" },
    ],
    [
        "button-danger",
        { status: "spec", reason: "Direction C destructive, asserted in (b)" },
    ],
    [
        "btn",
        {
            status: "spec",
            reason: "editorial public-surface primary; .btn.ghost is the Direction C secondary, asserted in (b)",
        },
    ],
    [
        "copy-btn",
        {
            status: "spec",
            reason: "connect-page primary action, asserted in (b)",
        },
    ],
    [
        "button-small",
        {
            status: "context",
            reason: "size variant of a spec tier; carries no color treatment of its own (styles.css draws it at the 31px anchor geometry, asserted in (b))",
        },
    ],
    [
        "trends-icon-btn",
        {
            status: "context",
            reason: "44px icon sizing for a .button-secondary in markup; opacity-only disabled state",
        },
    ],
    [
        "photo-capture-button",
        {
            status: "context",
            reason: "44px hit-floor sizing only (pantry + app overrides)",
        },
    ],
    [
        "meal-draft-add-text-button",
        {
            status: "context",
            reason: "full-width 48px sizing for the meal-draft add-text submit; color comes from the shared button grammar",
        },
    ],
    [
        "meal-scan-button",
        {
            status: "context",
            reason: "44px icon sizing for a .button-secondary in markup (composer wave C2 scanner icon); color comes from the shared button grammar",
        },
    ],
    [
        "mode-btn",
        {
            status: "context",
            reason: "recipe unit-logging portion picker mode segments (owner-approved renderings, 2026-11-13): 31px Direction C segment geometry with the ::after hit overlay; the selected segment takes the primary green fill",
        },
    ],
    [
        "stepper-btn",
        {
            status: "context",
            reason: "recipe unit-logging servings stepper (owner-approved renderings, 2026-11-13): 31px Direction C square steppers with the ::after hit overlay; glyph-only, ink on transparent with the rule border",
        },
    ],
    [
        "button-google",
        {
            status: "allow",
            reason: "provider control: Google's branding rules set this button (white ground, dark text, multicolour G); only its sizing follows the house grammar",
        },
    ],
    [
        "button-apple",
        {
            status: "allow",
            reason: "provider control: Apple's branding rules set this button (black ground, white text and mark); only its sizing follows the house grammar",
        },
    ],
    [
        "button-light",
        {
            status: "spec",
            reason: "Direction C light-on-dark outline variant (the styles.css button for dark green bands), asserted in (b); its pre-P1 allow-list entry retired with the styles.css re-skin (punch-list P1, ruled 2026-11-13)",
        },
    ],
]);

/** (e) Chart-annotation selectors exempt from the 11px floor. */
const CHART_ANNOTATION_ALLOWLIST = new Map<string, string>([
    [".trends-ref-label", "SVG chart reference label"],
    [".trends-daylabels span", "chart axis day labels"],
    [".trends-endlabels span", "chart axis end labels"],
    [".trends-donut-unit", "SVG donut centre unit label"],
    [".trends-column span", "chart column date labels"],
    [".trends-months span", "heatmap month labels"],
]);

const AUTHORITY_TOKENS: Record<string, string> = {
    "--paper": PAPER,
    "--paper-card": PANEL,
    "--ink": INK,
    "--ink-soft": INK_SOFT,
    "--ink-mute": "#5d5344",
    "--hairline": "#d8cdb6",
    "--rule": RULE,
    "--green": GREEN,
    "--green-deep": GREEN_DEEP,
    "--green-tint": "#eef4ea",
    "--danger": DANGER,
};

/* ---------------- (a) retired values ---------------- */

describe("design authority (a): retired values", () => {
    test("retired hexes are absent from public/ stylesheets and markup", async () => {
        const offenders: string[] = [];
        const files = [
            ...publicFiles(".css"),
            ...publicFiles(".html"),
            ...publicFiles(".js"),
        ];
        for (const name of files) {
            let text = await readPublic(name);
            if (name.endsWith(".css")) text = stripComments(text);
            for (const retired of RETIRED) {
                const pattern = new RegExp(`${retired}(?![0-9a-f])`, "gi");
                for (const match of text.matchAll(pattern)) {
                    const line = text.slice(0, match.index).split("\n").length;
                    offenders.push(
                        `public/${name}:${line} uses retired ${retired}`,
                    );
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

/* ---------------- (b) Direction C spec resolution ---------------- */

describe("design authority (b): Direction C spec resolution", () => {
    test("DESIGN.md carries the ratified law (anchor, floor, retired, copy law)", async () => {
        const design = await Bun.file(join(ROOT, "DESIGN.md")).text();
        for (const pin of [
            "Direction C",
            "#176b3a",
            "#8a7c63",
            "#4a4237",
            "#8c2f22",
            "#8a6d3b",
            "31px",
            "6px 14px",
            "10px",
            "11px",
            "#efe9db",
            "#b8a888",
            // Punch-list rulings (ratified 2026-11-13): P3 chart
            // palette, P5 warning family, P5/P6 retired values.
            "#2e5b34",
            "#b98a00",
            "#8a6100",
            "#8a6d00",
            "#ded5c0",
            "NO FILLER",
            "enforced law",
        ]) {
            expect(design).toContain(pin);
        }
    });

    test("editorial.css tokens resolve to the authority palette", async () => {
        const sheet = await loadSheet("editorial.css");
        for (const [token, hex] of Object.entries(AUTHORITY_TOKENS)) {
            expect(
                normalizeColor(
                    resolveVars(sheet.vars.get(token) ?? "", sheet.vars),
                ),
            ).toBe(hex);
        }
    });

    test("pantry.css tokens resolve to the authority palette", async () => {
        const sheet = await loadSheet("pantry.css");
        for (const [token, hex] of Object.entries(AUTHORITY_TOKENS)) {
            expect(
                normalizeColor(
                    resolveVars(sheet.vars.get(token) ?? "", sheet.vars),
                ),
            ).toBe(hex);
        }
    });

    test("app-overrides.css shared tiers resolve to Direction C", async () => {
        const sheet = await loadSheet("app-overrides.css");
        const primary = declsFor(sheet, ".button-primary");
        expect(
            colorOf(primary, sheet.vars, "background", "background-color"),
        ).toBe(GREEN);
        expect(colorOf(primary, sheet.vars, "border-color")).toBe(GREEN);

        const primaryHover = declsFor(sheet, ".button-primary:hover");
        expect(
            colorOf(primaryHover, sheet.vars, "background", "background-color"),
        ).toBe(GREEN_DEEP);
        expect(colorOf(primaryHover, sheet.vars, "border-color")).toBe(
            GREEN_DEEP,
        );

        const secondary = declsFor(sheet, ".button-secondary");
        expect(
            colorOf(secondary, sheet.vars, "background", "background-color"),
        ).toBe("transparent");
        expect(colorOf(secondary, sheet.vars, "border-color")).toBe(RULE);
        expect(colorOf(secondary, sheet.vars, "color")).toBe(INK);

        const quiet = declsFor(sheet, ".button-quiet");
        expect(colorOf(quiet, sheet.vars, "color")).toBe(INK_SOFT);
        // Quiet carries no fill: any background it declares is transparent.
        const quietFill = colorOf(
            quiet,
            sheet.vars,
            "background",
            "background-color",
        );
        expect(quietFill === null || quietFill === "transparent").toBe(true);

        for (const selector of [
            ".settings-view .button-danger",
            ".household-view .button-danger",
        ]) {
            const danger = declsFor(sheet, selector);
            expect(
                colorOf(danger, sheet.vars, "background", "background-color"),
                selector,
            ).toBe("transparent");
            expect(colorOf(danger, sheet.vars, "color"), selector).toBe(DANGER);
            expect(
                colorOf(danger, sheet.vars, "border-color", "border"),
                selector,
            ).toBe(DANGER);
        }
    });

    test("app geometry (P2): buttons draw at the 31px anchor, hit area via ::after overlay", async () => {
        const sheet = await loadSheet("app-overrides.css");
        // The closing P2 section is the cascade winner for the shared
        // .button grammar: drawn box is the anchor, never the hit box.
        const button = declsFor(sheet, ".button");
        expect(button.get("height")).toBe("31px");
        expect(button.get("min-height")).toBe("31px");
        expect(button.get("padding")).toBe("6px 14px");
        expect(button.get("border-radius")).toBe("10px");
        expect(button.get("font-size")).toBe("0.9rem");
        // Hit floor delivered by the invisible overlay (31 + 2x7 = 45px).
        const overlay = declsFor(sheet, ".button::after");
        expect(overlay.get("content")).toBe('""');
        expect(overlay.get("position")).toBe("absolute");
        expect(overlay.get("inset")).toBe("-7px -4px");
        // Dialog close follows the same anchor + overlay.
        const close = declsFor(sheet, ".dialog-close");
        expect(close.get("min-height")).toBe("31px");
        expect(declsFor(sheet, ".dialog-close::after").get("inset")).toBe(
            "-7px -4px",
        );
        // Fields/selects draw at the anchor (dialog + app-content scope
        // resolves through the same closing-section rule).
        const field = declsFor(sheet, ".input");
        expect(field.get("height")).toBe("31px");
        expect(field.get("min-height")).toBe("31px");
        expect(field.get("padding")).toBe("5px 12px");
        expect(field.get("border-radius")).toBe("10px");
        // Dialog cards take the board's 14px radius; the mobile sheet
        // keeps its 24px top radius. The parser flattens @media, so
        // assert both radii exist as dialog rules rather than a merged
        // winner (the media rule legitimately wins at <=620px).
        const dialogRadii = sheet.rules
            .filter((rule) => rule.selectors.includes("dialog"))
            .map((rule) => rule.declarations.get("border-radius"));
        expect(dialogRadii).toContain("14px");
        expect(dialogRadii).toContain("24px 24px 0 0");
        const cardRadii = sheet.rules
            .filter((rule) => rule.selectors.includes("dialog .auth-card"))
            .map((rule) => rule.declarations.get("border-radius"));
        expect(cardRadii).toContain("14px");
        expect(cardRadii).toContain("24px 24px 0 0");
        // Shared tiers carry the anchor radius, not the 4px variant.
        for (const tier of [
            ".button-primary",
            ".button-secondary",
            ".button-quiet",
        ]) {
            expect(declsFor(sheet, tier).get("border-radius"), tier).toBe(
                "10px",
            );
        }
        // Checkbox law: 22px drawn inside the 44px tap area.
        const check = declsFor(sheet, ".groceries-view .grocery-check-input");
        expect(check.get("width")).toBe("22px");
        expect(check.get("height")).toBe("22px");
        expect(
            declsFor(sheet, ".groceries-view .grocery-check").get("min-width"),
        ).toBe("44px");
    });

    test("app destructive (P4): confirms are Direction C transparent, hover included", async () => {
        const sheet = await loadSheet("app-overrides.css");
        for (const selector of [
            ".meal-draft-abandon-confirm",
            ".recipe-archive-confirm",
            ".plan-inline-confirm-danger",
            ".cook-delete-confirm",
            ".grocery-inline-confirm-danger",
            ".settings-inline-danger",
            ".household-inline-confirm-danger",
        ]) {
            const decls = declsFor(sheet, selector);
            expect(
                colorOf(decls, sheet.vars, "background", "background-color"),
                selector,
            ).toBe("transparent");
            expect(colorOf(decls, sheet.vars, "border-color"), selector).toBe(
                DANGER,
            );
            expect(colorOf(decls, sheet.vars, "color"), selector).toBe(DANGER);
            const hover = declsFor(sheet, `${selector}:hover`);
            expect(
                colorOf(hover, sheet.vars, "background", "background-color"),
                `${selector}:hover`,
            ).toBe("transparent");
            expect(
                colorOf(hover, sheet.vars, "border-color"),
                `${selector}:hover`,
            ).toBe(DANGER);
        }
    });

    test("editorial.css buttons resolve to Direction C", async () => {
        const sheet = await loadSheet("editorial.css");
        const base = declsFor(sheet, ".button");
        expect(
            colorOf(base, sheet.vars, "background", "background-color"),
        ).toBe(GREEN);

        const primary = declsFor(sheet, ".button-primary");
        expect(
            colorOf(primary, sheet.vars, "background", "background-color"),
        ).toBe(GREEN);
        expect(colorOf(primary, sheet.vars, "color")).toBe("#ffffff");
        const primaryHover = declsFor(sheet, ".button-primary:hover");
        expect(
            colorOf(primaryHover, sheet.vars, "background", "background-color"),
        ).toBe(GREEN_DEEP);

        // Quiet is a true quiet tier: no fill, no visible border, ink-soft.
        const quiet = declsFor(sheet, ".button-quiet");
        expect(
            colorOf(quiet, sheet.vars, "background", "background-color"),
        ).toBe("transparent");
        expect(colorOf(quiet, sheet.vars, "border-color")).toBe("transparent");
        expect(colorOf(quiet, sheet.vars, "color")).toBe(INK_SOFT);

        // .btn is the public-surface primary; .btn.ghost is the
        // Direction C secondary under the public grammar's name.
        const btn = declsFor(sheet, ".btn");
        expect(colorOf(btn, sheet.vars, "background", "background-color")).toBe(
            GREEN,
        );
        const btnHover = declsFor(sheet, ".btn:hover");
        expect(
            colorOf(btnHover, sheet.vars, "background", "background-color"),
        ).toBe(GREEN_DEEP);
        const ghost = declsFor(sheet, ".btn.ghost");
        expect(
            colorOf(ghost, sheet.vars, "background", "background-color"),
        ).toBe("transparent");
        expect(colorOf(ghost, sheet.vars, "border", "border-color")).toBe(RULE);
        expect(colorOf(ghost, sheet.vars, "color")).toBe(INK);
        const ghostHover = declsFor(sheet, ".btn.ghost:hover");
        expect(
            colorOf(ghostHover, sheet.vars, "background", "background-color"),
        ).toBe("transparent");

        const copy = declsFor(sheet, ".copy-btn");
        expect(
            colorOf(copy, sheet.vars, "background", "background-color"),
        ).toBe(GREEN);
        const copyHover = declsFor(sheet, ".copy-btn:hover");
        expect(
            colorOf(copyHover, sheet.vars, "background", "background-color"),
        ).toBe(GREEN_DEEP);
    });

    test("pantry.css element buttons resolve to Direction C", async () => {
        const sheet = await loadSheet("pantry.css");
        const base = declsFor(sheet, "button");
        expect(
            colorOf(base, sheet.vars, "background", "background-color"),
        ).toBe(GREEN);
        expect(colorOf(base, sheet.vars, "color")).toBe("#ffffff");
        const hover = declsFor(sheet, "button:hover");
        expect(
            colorOf(hover, sheet.vars, "background", "background-color"),
        ).toBe(GREEN_DEEP);
        const secondary = declsFor(sheet, "button.secondary");
        expect(
            colorOf(secondary, sheet.vars, "background", "background-color"),
        ).toBe("transparent");
        expect(colorOf(secondary, sheet.vars, "border-color")).toBe(RULE);
        expect(colorOf(secondary, sheet.vars, "color")).toBe(INK);
        const secondaryHover = declsFor(sheet, "button.secondary:hover");
        expect(
            colorOf(
                secondaryHover,
                sheet.vars,
                "background",
                "background-color",
            ),
        ).toBe("transparent");
    });

    test("styles.css tokens resolve to the authority palette (P1 re-skin)", async () => {
        const sheet = await loadSheet("styles.css");
        for (const [token, hex] of Object.entries(AUTHORITY_TOKENS)) {
            expect(
                normalizeColor(
                    resolveVars(sheet.vars.get(token) ?? "", sheet.vars),
                ),
                token,
            ).toBe(hex);
        }
        // This sheet names the panel token --panel (editorial/pantry
        // call the same material --paper-card, asserted above).
        expect(
            normalizeColor(
                resolveVars(sheet.vars.get("--panel") ?? "", sheet.vars),
            ),
        ).toBe(PANEL);
        expect(
            normalizeColor(
                resolveVars(sheet.vars.get("--paper") ?? "", sheet.vars),
            ),
        ).toBe(PAPER);
        // The legacy green scale survives only as aliases onto the
        // authority greens (account-settings.css and app-overrides.css
        // resolve these names from this sheet's :root).
        expect(
            normalizeColor(
                resolveVars(sheet.vars.get("--green-700") ?? "", sheet.vars),
            ),
        ).toBe(GREEN);
        expect(
            normalizeColor(
                resolveVars(sheet.vars.get("--green-800") ?? "", sheet.vars),
            ),
        ).toBe(GREEN_DEEP);
    });

    test("styles.css buttons resolve to Direction C at the anchor geometry (P1 re-skin)", async () => {
        const sheet = await loadSheet("styles.css");
        const base = declsFor(sheet, ".button");
        expect(base.get("height")).toBe("31px");
        expect(base.get("padding")).toBe("6px 14px");
        expect(base.get("border-radius")).toBe("10px");
        expect(base.get("font-size")).toBe("0.9rem");

        const primary = declsFor(sheet, ".button-primary");
        expect(
            colorOf(primary, sheet.vars, "background", "background-color"),
        ).toBe(GREEN);
        expect(colorOf(primary, sheet.vars, "border-color")).toBe(GREEN);
        expect(colorOf(primary, sheet.vars, "color")).toBe("#ffffff");
        // Direction C primary carries no shadow.
        expect(primary.get("box-shadow") ?? "none").toBe("none");
        const primaryHover = declsFor(sheet, ".button-primary:hover");
        expect(
            colorOf(primaryHover, sheet.vars, "background", "background-color"),
        ).toBe(GREEN_DEEP);

        const secondary = declsFor(sheet, ".button-secondary");
        expect(
            colorOf(secondary, sheet.vars, "background", "background-color"),
        ).toBe("transparent");
        expect(colorOf(secondary, sheet.vars, "border-color")).toBe(RULE);
        expect(colorOf(secondary, sheet.vars, "color")).toBe(INK);
        const secondaryHover = declsFor(sheet, ".button-secondary:hover");
        expect(
            colorOf(
                secondaryHover,
                sheet.vars,
                "background",
                "background-color",
            ),
        ).toBe("transparent");

        const quiet = declsFor(sheet, ".button-quiet");
        expect(colorOf(quiet, sheet.vars, "color")).toBe(INK_SOFT);
        const quietFill = colorOf(
            quiet,
            sheet.vars,
            "background",
            "background-color",
        );
        expect(quietFill === null || quietFill === "transparent").toBe(true);

        // .button-light keeps its role — the button on dark green
        // bands — in Direction C outline grammar: transparent fill,
        // panel outline and text, transparent on hover.
        const light = declsFor(sheet, ".button-light");
        expect(
            colorOf(light, sheet.vars, "background", "background-color"),
        ).toBe("transparent");
        expect(colorOf(light, sheet.vars, "border-color")).toBe(PANEL);
        expect(colorOf(light, sheet.vars, "color")).toBe(PANEL);
        const lightHover = declsFor(sheet, ".button-light:hover");
        expect(
            colorOf(lightHover, sheet.vars, "background", "background-color"),
        ).toBe("transparent");

        const small = declsFor(sheet, ".button-small");
        expect(small.get("height")).toBe("31px");
        expect(small.get("padding")).toBe("6px 14px");
    });
});

/* ---------------- (c) gold confinement ---------------- */

describe("design authority (c): gold confinement", () => {
    test("gold appears only in allow-listed CSS selectors", async () => {
        const offenders: string[] = [];
        for (const name of publicFiles(".css")) {
            const sheet = await loadSheet(name);
            for (const rule of sheet.rules) {
                const usesGold = [...rule.declarations.values()].some(
                    (value) =>
                        resolveVars(value, sheet.vars)
                            .toLowerCase()
                            .includes(GOLD) || value.includes("--gold"),
                );
                if (!usesGold) continue;
                for (const selector of rule.selectors) {
                    if (!GOLD_CSS_ALLOWLIST.has(selector)) {
                        offenders.push(
                            `public/${name}:${rule.line} ${selector} uses gold outside the allow-list`,
                        );
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test("gold appears only in allow-listed JS chart color maps", async () => {
        const offenders: string[] = [];
        for (const name of publicFiles(".js")) {
            const text = await readPublic(name);
            const pattern = /#8a6d3b/gi;
            for (const match of text.matchAll(pattern)) {
                const before = text.slice(0, match.index);
                const fn = [
                    ...before.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g),
                ].pop();
                const key = `public/${name}::${fn ? fn[1] : "<top-level>"}`;
                if (!GOLD_JS_ALLOWLIST.has(key)) {
                    offenders.push(`${key} uses gold outside the allow-list`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

/* ---------------- (d) button-like class inventory ---------------- */

describe("design authority (d): button-like class inventory", () => {
    test("every button-like class is spec-verified or allow-listed", async () => {
        const found = new Set<string>();
        for (const name of publicFiles(".css")) {
            const sheet = await loadSheet(name);
            for (const rule of sheet.rules) {
                for (const selector of rule.selectors) {
                    for (const cls of selector.matchAll(
                        /\.([a-zA-Z0-9_-]+)/g,
                    )) {
                        if (/button/i.test(cls[1]) || /btn/i.test(cls[1])) {
                            found.add(cls[1]);
                        }
                    }
                }
            }
        }
        const unregistered = [...found].filter(
            (cls) => !BUTTON_CLASS_REGISTRY.has(cls),
        );
        expect(unregistered).toEqual([]);
        // The registry must not rot: every spec/context/allow entry
        // still names a class the tree actually uses.
        const stale = [...BUTTON_CLASS_REGISTRY.keys()].filter(
            (cls) => !found.has(cls),
        );
        expect(stale).toEqual([]);
    });
});

/* ---------------- (e) 11px floor ---------------- */

describe("design authority (e): 11px type floor", () => {
    test("no font-size below 11px outside chart annotations", async () => {
        const offenders: string[] = [];
        for (const name of publicFiles(".css")) {
            const sheet = await loadSheet(name);
            for (const rule of sheet.rules) {
                const raw = rule.declarations.get("font-size");
                if (!raw) continue;
                const value = raw.trim().toLowerCase();
                const px = /^([0-9.]+)px$/.exec(value);
                const rem = /^([0-9.]+)rem$/.exec(value);
                // em/% are relative to their parent and cannot be
                // resolved mechanically; px and rem (16px root) can.
                const sizePx = px
                    ? parseFloat(px[1])
                    : rem
                      ? parseFloat(rem[1]) * 16
                      : null;
                if (sizePx === null || sizePx >= 11) continue;
                const allowed = rule.selectors.some((selector) =>
                    CHART_ANNOTATION_ALLOWLIST.has(selector),
                );
                if (!allowed) {
                    offenders.push(
                        `public/${name}:${rule.line} ${rule.selectors.join(", ")} sets font-size ${raw} (${sizePx}px, below the 11px floor)`,
                    );
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

/* ---------------- (f) dialog material ----------------
 * Ported from PR #274 (scripts/ui-surface-smoke.ts on
 * feat/design-authority-ci-checks): dialogs are the panel material
 * (authority §2 / Surface rules) — the dialog card is #fffdf8, and no
 * dialog rule paints a dialog white. Adapted to this suite's parser:
 * declarations are resolved through each sheet's CSS variables and
 * colors normalized, so #fff, #ffffff, and white are one value. No
 * exceptions, no allow-list. */

describe("design authority (f): dialog material", () => {
    test("dialog .auth-card resolves to the panel material #fffdf8", async () => {
        let declared = 0;
        const offenders: string[] = [];
        for (const name of publicFiles(".css")) {
            const sheet = await loadSheet(name);
            const decls = declsFor(sheet, "dialog .auth-card");
            const fill = colorOf(
                decls,
                sheet.vars,
                "background",
                "background-color",
            );
            if (fill === null) continue;
            declared++;
            if (fill !== PANEL) {
                offenders.push(
                    `public/${name} dialog .auth-card resolves to ${fill}, not the panel material ${PANEL}`,
                );
            }
        }
        expect(declared).toBeGreaterThan(0);
        expect(offenders).toEqual([]);
    });

    test("no CSS rule whose selector starts with dialog paints a dialog white", async () => {
        const offenders: string[] = [];
        for (const name of publicFiles(".css")) {
            const sheet = await loadSheet(name);
            for (const rule of sheet.rules) {
                for (const selector of rule.selectors) {
                    if (!selector.startsWith("dialog")) continue;
                    const fill = colorOf(
                        rule.declarations,
                        sheet.vars,
                        "background",
                        "background-color",
                    );
                    if (fill === "#ffffff") {
                        offenders.push(
                            `public/${name}:${rule.line} ${selector} paints a dialog white`,
                        );
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

/* ---------------- (g) chart palette confinement ----------------
 * Punch-list P3 (ratified 2026-11-13, PR #327): the pre-authority
 * Trends chart palette is ratified as-is and named in DESIGN.md's
 * token chapter. These values are chart-only: they style chart
 * marks, selected-day wells, and Trends pills — never buttons,
 * fields, or general surfaces. The registry below is the surface
 * list the palette may appear on; every entry carries its reason.
 * Recorded exceptions are text-only borrowings that already shipped
 * in the chart grammar's ink/sage/series colors — P3 changed no
 * values, so they are recorded here rather than silently spread. */

const CHART_PALETTE = ["#2e5b34", "#22301f", "#6e7462", "#c9bfa3", "#e6eddc"];

/** Selector fragments allowed to carry chart-palette values. */
const CHART_CSS_SURFACES = new Map<string, string>([
    [
        ".trends-",
        "Trends chart system: chart marks, bands, pills, toggles, sheets (P3 ratification, PR #327)",
    ],
    [
        ".macro-",
        "Today macro tiles/sheets: the Today half of the Trends chart grammar; tile bars and drill-down sheets carry chart data (P3)",
    ],
    [
        ".cal-",
        "Trends/Today calendar data marks: selected-day well, in-range wash, day dots (DESIGN.md chart palette: selected-day wells)",
    ],
    [
        ".range-",
        "Trends range view: split/range rows in chart ink and series green (P3)",
    ],
    [".day-tag", "Trends range view day tags (P3)"],
    [".planned-tag", "Trends range view planned tag, series green (P3)"],
    [".micro-avg", "Trends micro average label, sage (P3)"],
    [
        ".brain-link",
        "insight/brain link: DESIGN.md names series green as the brain glyph's green — one learned 'insight' green (P3)",
    ],
    // Recorded text-only exceptions (no fills, no buttons, no
    // fields): surfaces that shipped in the chart grammar's text
    // colors before the authority. P3 ratified values as-is.
    [
        ".meal-draft-saved",
        "recorded exception: saved-confirmation text in series green; shipped with the Trends grammar, text only (P3, no value changes)",
    ],
    [
        ".nutrition-label",
        "recorded exception: nutrition-label meta text in sage; text only (P3, no value changes)",
    ],
    [
        ".cook-mode-",
        "recorded exception: cook-mode rows reference the chart grammar's muted sage as a var() fallback; text only (P3, no value changes)",
    ],
    [
        ".recipe-portion-picker",
        "recorded exception: portion-picker labels in the chart grammar's sage/chart ink; text only (P3, no value changes)",
    ],
]);

/** (g) Chart palette in JS is confined to the Trends chart maps. */
const CHART_JS_ALLOWLIST = new Map<string, string>([
    [
        "public/app.js::trendsDonutChart",
        "chart color map: macro donut segments (P3 ratification)",
    ],
    [
        "public/app.js::trendsStackedChart",
        "chart color map: meal-split stacked segments (P3 ratification)",
    ],
]);

describe("design authority (g): chart palette confinement (P3)", () => {
    test("chart values appear only on registered chart surfaces in CSS", async () => {
        const offenders: string[] = [];
        for (const name of publicFiles(".css")) {
            const sheet = await loadSheet(name);
            for (const rule of sheet.rules) {
                const usesChart = [...rule.declarations.values()].some(
                    (value) => {
                        const resolved = resolveVars(
                            value,
                            sheet.vars,
                        ).toLowerCase();
                        return CHART_PALETTE.some((hex) =>
                            resolved.includes(hex),
                        );
                    },
                );
                if (!usesChart) continue;
                for (const selector of rule.selectors) {
                    const allowed = [...CHART_CSS_SURFACES.keys()].some(
                        (fragment) => selector.includes(fragment),
                    );
                    if (!allowed) {
                        offenders.push(
                            `public/${name}:${rule.line} ${selector} uses a chart-palette value outside the registered chart surfaces (P3)`,
                        );
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test("no chart value is an authority token variable in any sheet", async () => {
        const offenders: string[] = [];
        for (const name of publicFiles(".css")) {
            const sheet = await loadSheet(name);
            for (const [token, value] of sheet.vars) {
                const resolved = resolveVars(value, sheet.vars).toLowerCase();
                if (CHART_PALETTE.some((hex) => resolved.includes(hex))) {
                    offenders.push(
                        `public/${name} ${token} resolves to a chart-palette value; chart values are not tokens (P3)`,
                    );
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test("chart values in JS are confined to the Trends chart color maps", async () => {
        const offenders: string[] = [];
        for (const name of publicFiles(".js")) {
            const text = await readPublic(name);
            for (const hex of CHART_PALETTE) {
                const pattern = new RegExp(hex, "gi");
                for (const match of text.matchAll(pattern)) {
                    const before = text.slice(0, match.index);
                    const fn = [
                        ...before.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g),
                    ].pop();
                    const key = `public/${name}::${fn ? fn[1] : "<top-level>"}`;
                    if (!CHART_JS_ALLOWLIST.has(key)) {
                        offenders.push(
                            `${key} uses chart value ${hex} outside the allow-list (P3)`,
                        );
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

/* ---------------- (h) warning family tokens ----------------
 * Punch-list P5 (ratified 2026-11-13, PR #327): warn-line #b98a00
 * and warn-text #8a6100 are the warning family, RESERVED for
 * warning signals only. Both sheets that style warnings define
 * them as tokens and reference the tokens — no literal amber. */

const WARN_LINE = "#b98a00";
const WARN_TEXT = "#8a6100";

describe("design authority (h): warning family (P5)", () => {
    test("pantry.css and app-overrides.css define the warn tokens at the ratified values", async () => {
        for (const name of ["pantry.css", "app-overrides.css"]) {
            const sheet = await loadSheet(name);
            expect(
                normalizeColor(
                    resolveVars(
                        sheet.vars.get("--warn-line") ?? "",
                        sheet.vars,
                    ),
                ),
                `${name} --warn-line`,
            ).toBe(WARN_LINE);
            expect(
                normalizeColor(
                    resolveVars(
                        sheet.vars.get("--warn-text") ?? "",
                        sheet.vars,
                    ),
                ),
                `${name} --warn-text`,
            ).toBe(WARN_TEXT);
        }
    });

    test("no literal warn amber outside the :root token definitions", async () => {
        const offenders: string[] = [];
        for (const name of ["pantry.css", "app-overrides.css"]) {
            const sheet = await loadSheet(name);
            for (const rule of sheet.rules) {
                if (rule.selectors.includes(":root")) continue;
                for (const value of rule.declarations.values()) {
                    const lower = value.toLowerCase();
                    if (
                        lower.includes(WARN_LINE) ||
                        lower.includes(WARN_TEXT)
                    ) {
                        offenders.push(
                            `public/${name}:${rule.line} ${rule.selectors.join(", ")} uses a literal warn amber; use var(--warn-line) / var(--warn-text) (P5)`,
                        );
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test("app warning rules resolve through the warn tokens", async () => {
        const sheet = await loadSheet("app-overrides.css");
        for (const selector of [
            ".settings-view .account-status-warning",
            ".household-view .account-status-warning",
        ]) {
            expect(
                colorOf(declsFor(sheet, selector), sheet.vars, "color"),
                selector,
            ).toBe(WARN_TEXT);
        }
        expect(
            colorOf(
                declsFor(sheet, ".household-view .pending-invite"),
                sheet.vars,
                "border-left",
                "border-left-color",
            ),
        ).toBe(WARN_LINE);
    });

    test("pantry warning rules resolve through the warn tokens", async () => {
        const sheet = await loadSheet("pantry.css");
        for (const selector of [".notice", ".lowstock"]) {
            expect(
                colorOf(
                    declsFor(sheet, selector),
                    sheet.vars,
                    "border-left",
                    "border-left-color",
                ),
                selector,
            ).toBe(WARN_LINE);
        }
    });
});
