import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BOTTOM_NAV_MODEL } from "./feature-nav.js";

const read = (name: string) =>
    readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

// Geometry of an icon: its shape elements in order, each reduced to
// the attributes that draw it. Comparing geometry (not raw markup)
// lets the model's one-line SVG strings and the shipped pages'
// prettier-wrapped SVGs be pinned to each other without formatting
// false positives.
function iconGeometry(markup: string): string[] {
    const shapes: string[] = [];
    const tagPattern = /<(circle|rect|path)\b([\s\S]*?)>/g;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(markup)) !== null) {
        const [, tag, attrs] = match;
        const picked = ["cx", "cy", "r", "x", "y", "width", "height", "rx", "d"]
            .map((name) => {
                // Anchored to a preceding space/start so "x" cannot
                // match inside "cx" (nor "y" inside "cy").
                const found = attrs.match(
                    new RegExp(`(?:^|\\s)${name}="([^"]*)"`),
                );
                return found
                    ? `${name}=${found[1].replace(/\s+/g, " ")}`
                    : null;
            })
            .filter(Boolean);
        shapes.push(`${tag} ${picked.join(" ")}`);
    }
    return shapes;
}

function bottomNavBlock(html: string): string {
    const start = html.indexOf('<nav class="mobile-bottom-nav"');
    const end = html.indexOf("</nav>", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return html.slice(start, end);
}

function anchorBlock(nav: string, route: string): string {
    const start = nav.indexOf(`data-route="${route}"`);
    expect(start).toBeGreaterThan(-1);
    // The shipped formatting splits the closing tag ("</a\n>"), so
    // the block ends at the "</a" prefix.
    const end = nav.indexOf("</a", start);
    expect(end).toBeGreaterThan(start);
    return nav.slice(start, end);
}

describe("bottom bar — Refined Line treatment (approved Nov 11)", () => {
    test("the model keeps the six destinations in shipped order", () => {
        expect(BOTTOM_NAV_MODEL.map((entry) => entry.route)).toEqual([
            "today",
            "plan",
            "recipes",
            "groceries",
            "pantry",
            "more",
        ]);
        expect(BOTTOM_NAV_MODEL.map((entry) => entry.label)).toEqual([
            "Today",
            "Plan",
            "Recipes",
            "Groceries",
            "Pantry",
            "More",
        ]);
    });

    test("every destination carries an authored 1.5-stroke line SVG", () => {
        for (const entry of BOTTOM_NAV_MODEL) {
            expect(entry.iconSvg).toContain("<svg");
            expect(entry.iconSvg).toContain('viewBox="0 0 24 24"');
            expect(entry.iconSvg).toContain('stroke-width="1.5"');
            // The retired unicode glyphs stay retired.
            expect(entry.iconSvg).not.toMatch(/[◉□◇✓▦•]/);
            expect(iconGeometry(entry.iconSvg).length).toBeGreaterThan(0);
        }
    });

    test.each(["app.html", "pantry.html"])(
        "%s ships the model's icons and labels in its bottom nav",
        (page) => {
            const nav = bottomNavBlock(read(page));
            for (const entry of BOTTOM_NAV_MODEL) {
                const anchor = anchorBlock(nav, entry.route);
                expect(anchor).toContain('class="tab-icon"');
                expect(iconGeometry(anchor)).toEqual(
                    iconGeometry(entry.iconSvg),
                );
                expect(anchor).toContain(`<span>${entry.label}</span>`);
            }
        },
    );

    test.each(["app-overrides.css", "pantry.css"])(
        "%s marks the active tab with the gold dot, no pill or underline",
        (sheet) => {
            const css = read(sheet);
            const dot = css.match(
                /\.mobile-bottom-nav a\.is-active::after\s*{([^}]*)}/,
            );
            expect(dot).not.toBeNull();
            expect(dot![1]).toContain("#8a6d3b");
            expect(dot![1]).toContain("border-radius: 50%");
            expect(dot![1]).toContain('content: ""');

            const active = css.match(
                /\.mobile-bottom-nav a\.is-active\s*{([^}]*)}/,
            );
            expect(active).not.toBeNull();
            expect(active![1]).not.toContain("underline");

            const iconRule = css.match(
                /\.mobile-bottom-nav a \.tab-icon svg\s*{([^}]*)}/,
            );
            expect(iconRule).not.toBeNull();
            expect(iconRule![1]).toContain("width: 23px");
            expect(iconRule![1]).toContain("height: 23px");
        },
    );
});
