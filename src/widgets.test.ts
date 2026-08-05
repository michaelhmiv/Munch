import { describe, expect, test } from "bun:test";
import {
    ALL_WIDGET_TEMPLATES,
    DEVELOPMENT_WIDGET_TEMPLATES,
    USER_WIDGET_TEMPLATES,
    WIDGET_TEMPLATES,
    getWidgetHtml,
} from "./widgets.js";

const KEYS = Object.keys(WIDGET_TEMPLATES);
const USER_KEYS = Object.keys(USER_WIDGET_TEMPLATES);
const SRC = "./public/widgets/src";
const INCLUDE_RE = /\/\*@include\s+([^\s@]+)\s*@\*\//g;

function scriptFrom(html: string): string {
    return html.slice(
        html.indexOf("<script>") + "<script>".length,
        html.indexOf("</script>"),
    );
}

for (const key of KEYS) {
    test(`${key} assembles into one self-contained MCP App document`, async () => {
        const html = await getWidgetHtml(key);
        expect(html.match(/\/\*@include/g)).toBeNull();
        expect(html.match(/\/\*@inlinets/g)).toBeNull();
        expect(html).not.toMatch(/^export\s/m);
        expect((html.match(/<style>/g) ?? []).length).toBe(1);
        expect((html.match(/<script>/g) ?? []).length).toBe(1);
        expect(html).not.toContain("<link");
        expect(html).not.toMatch(/<script[^>]+src=/);
        expect(html.trimStart().startsWith("<!doctype html>")).toBe(true);
        expect(html).toContain("function initWidget(config)");
        expect((html.match(/initWidget\(\{/g) ?? []).length).toBe(1);
        expect(html).toContain("--accent:");
        expect(html).toContain("--panel:");
        expect(() =>
            new Bun.Transpiler({ loader: "js" }).transformSync(
                scriptFrom(html),
            ),
        ).not.toThrow();
    });

    test(`${key} inlines every shared partial in full`, async () => {
        const template = await Bun.file(
            `${SRC}/templates/${WIDGET_TEMPLATES[key]}`,
        ).text();
        const includes = [...template.matchAll(INCLUDE_RE)].map(
            (match) => match[1]!,
        );
        expect(includes.length).toBeGreaterThan(0);
        const html = await getWidgetHtml(key);
        for (const rel of includes) {
            const partial = (await Bun.file(`${SRC}/${rel}`).text()).trim();
            expect(html).toContain(partial);
        }
    });
}

describe("production widget boundary", () => {
    test("the component gallery is development-only", () => {
        expect(DEVELOPMENT_WIDGET_TEMPLATES).toHaveProperty(
            "component-gallery",
        );
        expect(USER_WIDGET_TEMPLATES).not.toHaveProperty("component-gallery");
        expect(ALL_WIDGET_TEMPLATES).toHaveProperty("component-gallery");
    });

    test("production exports only user-facing templates", async () => {
        const widgetsSource = await Bun.file("src/widgets.ts").text();
        expect(widgetsSource).toContain(
            'process.env.NODE_ENV === "production"',
        );
        expect(widgetsSource).toContain("USER_WIDGET_TEMPLATES");
    });
});

describe("ChatGPT-native widget UX contracts", () => {
    test("user-facing widgets contain no competitor-specific fallback copy", async () => {
        for (const key of USER_KEYS) {
            const source = await Bun.file(
                `${SRC}/templates/${USER_WIDGET_TEMPLATES[key]}`,
            ).text();
            expect(source.toLowerCase()).not.toContain("claude");
        }
    });

    test("no user widget references the removed panel-bg token", async () => {
        for (const key of USER_KEYS) {
            const source = await Bun.file(
                `${SRC}/templates/${USER_WIDGET_TEMPLATES[key]}`,
            ).text();
            expect(source).not.toContain("--panel-bg");
        }
    });

    test("meal review exposes one primary and one secondary decision", async () => {
        const source = await Bun.file(
            `${SRC}/templates/meal-review.html`,
        ).text();
        expect(source).toContain('id="confirm"');
        expect(source).toContain('id="adjust"');
        expect(source).not.toContain('id="cancel"');
        expect(source).not.toContain("<textarea");
    });

    test("meal logged always renders a receipt rather than an empty root", async () => {
        const source = await Bun.file(
            `${SRC}/templates/meal-logged.html`,
        ).text();
        expect(source).toContain("<title>Meal Logged</title>");
        expect(source).not.toContain('root.innerHTML = ""');
    });

    test("deep workflows advertise fullscreen while retaining inline mode", async () => {
        for (const file of [
            "nutrition-summary.html",
            "trends.html",
            "weight-trends.html",
            "import-meals.html",
        ]) {
            const source = await Bun.file(`${SRC}/templates/${file}`).text();
            expect(source).toContain('displayModes: ["inline", "fullscreen"]');
            expect(source).toContain("requestDisplayMode");
        }
    });

    test("range controls are fullscreen-only in analytical templates", async () => {
        for (const file of ["trends.html", "weight-trends.html"]) {
            const source = await Bun.file(`${SRC}/templates/${file}`).text();
            expect(source).toContain("fullscreen-only range-controls");
        }
    });

    test("bridge declares modern display-mode and message capabilities", async () => {
        const bridge = await Bun.file(`${SRC}/shared/bridge.js`).text();
        expect(bridge).toContain("availableDisplayModes");
        expect(bridge).toContain('"ui/request-display-mode"');
        expect(bridge).toContain('"ui/message"');
        expect(bridge).toContain("onHostContext");
    });

    test("inline templates do not ship tablists", async () => {
        for (const key of USER_KEYS) {
            const source = await Bun.file(
                `${SRC}/templates/${USER_WIDGET_TEMPLATES[key]}`,
            ).text();
            expect(source).not.toContain('role="tablist"');
        }
    });
});

test("unknown widget key throws", async () => {
    expect(getWidgetHtml("not-a-widget")).rejects.toThrow(/unknown widget/);
});
