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
 *      Drawn geometry (31px / 6px 14px / 10px) is the recorded anchor in
 *      DESIGN.md; production ships the >=44px hit floor, which is what
 *      is asserted here — the drawn-geometry reconciliation is the
 *      authority's own recorded known divergence, not a silent pass.
 *  (c) Gold #8a6d3b appears ONLY in the allow-listed nav-indicator,
 *      calendar-today, and chart-accent selectors below.
 *  (d) Every button-like class in public/ CSS is either spec-verified
 *      by (b) or allow-listed in the registry below, with a reason.
 *  (e) No font-size below the 11px floor outside the allow-listed
 *      chart-annotation selectors (the Trends chart header records the
 *      sanction: "the 11px floor governs UI type, not chart
 *      annotation").
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
const RETIRED = ["#efe9db", "#b8a888", "#b3261e", "#fffdf7", "#fffef9"];

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
            reason: "size variant of a spec tier; carries no color treatment of its own",
        },
    ],
    [
        "button-large",
        {
            status: "context",
            reason: "size variant in the legacy styles.css grammar; carries no color treatment of its own",
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
            status: "allow",
            reason: "legacy styles.css marketing variant with no Direction C tier; retirement rides the styles.css re-skin recorded in DESIGN.md's enforcement punch list",
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

    test("app hit floor: operate buttons and the dialog close reach 44px", async () => {
        const sheet = await loadSheet("app-overrides.css");
        expect(declsFor(sheet, ".operate-view .button").get("min-height")).toBe(
            "44px",
        );
        expect(declsFor(sheet, ".dialog-close").get("min-height")).toBe("44px");
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

    test("legacy styles.css still anchors its primary hue to authority green", async () => {
        const sheet = await loadSheet("styles.css");
        expect(
            normalizeColor(
                resolveVars(sheet.vars.get("--green-700") ?? "", sheet.vars),
            ),
        ).toBe(GREEN);
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
