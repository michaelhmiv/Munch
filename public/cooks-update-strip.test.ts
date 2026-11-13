import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/**
 * Tools-to-top N5: the active-cook update strip. An active cook pins
 * a compact strip (one-line field + camera + the full-form door)
 * directly under the header/checklist; the full "Record an update"
 * form opens as a sheet instead of living below the Timeline.
 * Completed cooks keep the bottom form exactly as before. Strip,
 * sheet, and bottom form all submit through the one
 * cook-update-form branch — same payload, same endpoint.
 */
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
function fn(name: string) {
    return source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))![0];
}

function detailWith(status: string) {
    return {
        cook: {
            id: "cook-1",
            title: "Wings",
            timezone: "America/New_York",
            status,
            cook_date: "2026-09-16",
            version: 1,
        },
        dishes: [],
        events: [],
        outcomes: [],
        updates: [],
        media: [],
    };
}

function renderDetail(status: string) {
    const context = {
        escapeHtml: (s: unknown) => String(s ?? "").replaceAll('"', "&quot;"),
        number: String,
        formatDate: () => "September 16",
        formatTime: () => "12:06 PM",
        cookTimelineMarkup: () => "TIMELINE-SENTINEL",
        cookModeMarkup: () => "CHECKLIST-SENTINEL",
        photoCaptureMarkup: (options: { name?: string; compact?: boolean }) =>
            `[capture name=${options?.name ?? ""} compact=${options?.compact ? "1" : "0"}]`,
        detail: detailWith(status),
    };
    return runInNewContext(
        fn("cookDetailActionsMarkup") +
            fn("cookUpdateFormMarkup") +
            fn("cookUpdateStripMarkup") +
            fn("cookDetailMarkup") +
            "; cookDetailMarkup(detail)",
        context,
    ) as string;
}

test("active cook: the strip is pinned under the checklist, before Dishes", () => {
    const html = renderDetail("active");
    expect(html).toContain('id="cook-update-strip-form"');
    expect(html).toContain('data-action="open-cook-update-form"');
    expect(html).toContain('name="timezone" value="America/New_York"');
    expect(html).toContain('name="message" type="text"');
    expect(html).toContain("[capture name=photos compact=1]");
    const stripAt = html.indexOf('id="cook-update-strip-form"');
    expect(html.indexOf("CHECKLIST-SENTINEL")).toBeLessThan(stripAt);
    expect(stripAt).toBeLessThan(html.indexOf("<h3>Dishes</h3>"));
    // No second copy of the full form parked at the bottom.
    expect(html).not.toContain('id="cook-update-form"');
    expect(html).not.toContain("<h3>Record an update</h3>");
});

test("completed cook: no strip; the bottom form stays below the Timeline", () => {
    const html = renderDetail("finished");
    expect(html).not.toContain("cook-update-strip-form");
    expect(html).toContain('id="cook-update-form"');
    expect(html).toContain("<h3>Record an update</h3>");
    expect(html).toContain("[capture name=photos compact=0]");
    expect(html.indexOf("TIMELINE-SENTINEL")).toBeLessThan(
        html.indexOf('id="cook-update-form"'),
    );
});

test("the sheet opens the shared full form and carries the strip's entry over", () => {
    const calls: { title?: string; body?: string; files?: unknown } = {};
    const context = {
        escapeHtml: (s: unknown) => String(s ?? "").replaceAll('"', "&quot;"),
        photoCaptureMarkup: () => "[capture]",
        openDialog: (title: string, body: string) => {
            calls.title = title;
            calls.body = body;
        },
        dialog: { querySelector: () => ({}) },
        setPhotoCaptureFiles: (_control: unknown, files: unknown) => {
            calls.files = files;
        },
        cook: { id: "cook-1", timezone: "America/New_York" },
        carried: {
            message: "Wrapped the wings",
            files: [{ name: "wings.jpg" }],
        },
    };
    runInNewContext(
        fn("cookUpdateFormMarkup") +
            fn("openCookUpdateForm") +
            "; openCookUpdateForm(cook, carried)",
        context,
    );
    expect(calls.title).toBe("Record an update");
    expect(calls.body).toContain('id="cook-update-form"');
    expect(calls.body).toContain("Wrapped the wings");
    expect(calls.files).toEqual([{ name: "wings.jpg" }]);
});

test("strip, sheet, and bottom form share the one update submit branch", () => {
    // The submit listener admits the strip form…
    expect(source).toContain('"cook-update-strip-form",');
    // …into the same branch as the full form…
    expect(source).toMatch(
        /form\.id === "cook-update-form" \|\|\s*form\.id === "cook-update-strip-form"/,
    );
    // …which is the only place the updates endpoint is posted to.
    const posts =
        source.match(
            /\/api\/app\/cooks\/\$\{encodeURIComponent\(form\.dataset\.id\)\}\/updates/g,
        ) ?? [];
    expect(posts.length).toBe(1);
    // The strip's Full form button routes to the sheet opener.
    expect(source).toContain('action === "open-cook-update-form"');
});
