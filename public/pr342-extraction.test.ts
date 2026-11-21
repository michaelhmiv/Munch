import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/**
 * Bug-fix extraction from CLOSED PR #342 (approved by Michael
 * 2026-11-21: "pull those out of the PR and not do the UI stuff").
 * #342's UI/density overhaul was rejected, but it carried genuine bug
 * fixes. Each test below pins one extracted fix; every one of them
 * fails on the pre-extraction tree.
 *
 * Behavioral tests lift the real functions out of app.js (the repo's
 * vm-extraction pattern); the rest are source pins, the established
 * pattern for surfaces with no module harness (widget templates,
 * mobile shell scripts, CSS).
 */
const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const patchesSource = readFileSync(
    new URL("./app-patches.js", import.meta.url),
    "utf8",
);
const appHtml = readFileSync(new URL("./app.html", import.meta.url), "utf8");
const stylesCss = readFileSync(
    new URL("./styles.css", import.meta.url),
    "utf8",
);
const overridesCss = readFileSync(
    new URL("./app-overrides.css", import.meta.url),
    "utf8",
);
const importMealsHtml = readFileSync(
    new URL("./widgets/src/templates/import-meals.html", import.meta.url),
    "utf8",
);
const pantryNativeSource = readFileSync(
    new URL("../mobile/pantry-native.js", import.meta.url),
    "utf8",
);
const pantryHtml = readFileSync(
    new URL("./pantry.html", import.meta.url),
    "utf8",
);
const pantryCss = readFileSync(
    new URL("./pantry.css", import.meta.url),
    "utf8",
);
const runtimeSource = readFileSync(
    new URL("../mobile/runtime.js", import.meta.url),
    "utf8",
);
const mobileLoginSource = readFileSync(
    new URL("../mobile/mobile-login.js", import.meta.url),
    "utf8",
);

function extract(source: string, name: string): string {
    const match = source.match(
        new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`function not found: ${name}`);
    return match[0];
}

describe("swipe-to-remove diagonal-scroll guard (app.js)", () => {
    const context: Record<string, unknown> = {};
    runInNewContext(extract(appSource, "draftSwipeRemoves"), context);
    const draftSwipeRemoves = context.draftSwipeRemoves as (
        startX: number,
        endX: number,
        startY?: number,
        endY?: number,
    ) => boolean;

    test("a clean horizontal left swipe still removes", () => {
        expect(draftSwipeRemoves(300, 200, 100, 100)).toBe(true);
        expect(draftSwipeRemoves(300, 180, 100, 130)).toBe(true);
        // Two-argument callers keep the pre-guard behavior.
        expect(draftSwipeRemoves(300, 200)).toBe(true);
        expect(draftSwipeRemoves(300, 250)).toBe(false);
        expect(draftSwipeRemoves(200, 300)).toBe(false);
    });

    test("a diagonal scroll does not remove", () => {
        // Mostly-vertical travel with a leftward drift is a scroll,
        // not a swipe: 100px left but 120px up.
        expect(draftSwipeRemoves(300, 200, 100, 220)).toBe(false);
        // 90px left, 80px down: |dx| must exceed |dy| * 1.5.
        expect(draftSwipeRemoves(300, 210, 100, 180)).toBe(false);
    });

    test("both swipe arms capture and pass the Y coordinates", () => {
        // The draft-review arm and the composer arm (#349) share the
        // predicate; both must feed it real Y values or the guard is
        // inert. Synthetic events without clientY fall back to 0.
        const arms = appSource.match(
            /startY: event\.touches\[0\]\.clientY \?\? 0/g,
        );
        expect(arms?.length).toBe(2);
        expect(appSource).toContain("event.changedTouches[0].clientY ?? 0");
    });
});

describe("draft review live totals + add-text status (app.js)", () => {
    test("updateDraftTotalsLive sums the editor fields into the strip", () => {
        const totalsEls: Record<
            string,
            { innerHTML: string; textContent: string }
        > = {
            calories: { innerHTML: "", textContent: "" },
            protein_g: { innerHTML: "", textContent: "" },
            carbs_g: { innerHTML: "", textContent: "" },
            fat_g: { innerHTML: "", textContent: "" },
        };
        const totalsBox = {
            querySelector: (selector: string) => {
                const match = /\[data-draft-total='([^']+)'\]/.exec(selector);
                return match ? totalsEls[match[1]] : null;
            },
        };
        const fakeEditor = (fields: Record<string, string>) => {
            const kcal = { textContent: "stale" };
            return {
                kcal,
                querySelector: (selector: string) => {
                    const field = /\[data-draft-field="([^"]+)"\]/.exec(
                        selector,
                    );
                    if (field)
                        return fields[field[1]] != null
                            ? { value: fields[field[1]] }
                            : null;
                    if (selector === "[data-draft-item-kcal]") return kcal;
                    return null;
                },
            };
        };
        const editors = [
            fakeEditor({
                calories: "200",
                protein_g: "10",
                carbs_g: "20",
                fat_g: "5",
            }),
            fakeEditor({
                calories: "150",
                protein_g: "",
                carbs_g: "10",
                fat_g: "2.5",
            }),
        ];
        const root = {
            querySelectorAll: (selector: string) =>
                selector === "[data-draft-item-index]" ? editors : [],
            querySelector: (selector: string) =>
                selector === ".meal-draft-totals" ? totalsBox : null,
        };
        const context: Record<string, unknown> = {
            document: {
                getElementById: (id: string) =>
                    id === "meal-draft-review" ? root : null,
            },
        };
        runInNewContext(
            [
                extract(appSource, "number"),
                extract(appSource, "updateDraftTotalsLive"),
                "this.__update = updateDraftTotalsLive;",
                "this.__number = number;",
            ].join("\n"),
            context,
        );
        const update = context.__update as () => void;
        const num = context.__number as (
            value: number,
            digits?: number,
        ) => string;
        update();
        expect(totalsEls.calories.innerHTML).toBe(
            `${num(350)} <small>kcal</small>`,
        );
        expect(totalsEls.protein_g.textContent).toBe(`${num(10, 1)} g`);
        expect(totalsEls.carbs_g.textContent).toBe(`${num(30, 1)} g`);
        expect(totalsEls.fat_g.textContent).toBe(`${num(7.5, 1)} g`);
        // Each row's own kcal line follows its calories field.
        expect(editors[0].kcal.textContent).toBe("200 kcal");
        expect(editors[1].kcal.textContent).toBe("150 kcal");
    });

    test("the render carries the live-total hooks", () => {
        expect(appSource).toContain('data-draft-total="calories"');
        expect(appSource).toContain('data-draft-total="protein_g"');
        expect(appSource).toContain('data-draft-total="carbs_g"');
        expect(appSource).toContain('data-draft-total="fat_g"');
        expect(appSource).toContain("data-draft-item-kcal");
    });

    test("recompute is wired to typing and to portion/quantity commits", () => {
        // Definition + input listener + applyDraftPortionToEditor (x2)
        // + applyDraftQuantityToEditor (x1).
        const calls = appSource.match(/updateDraftTotalsLive\(\)/g);
        expect(calls?.length).toBeGreaterThanOrEqual(5);
        expect(appSource).toContain('closest?.("#meal-draft-review")');
    });

    test("the add-text status line always renders with the id the handler reads", () => {
        // The add-draft-text handler looks up
        // #meal-draft-add-text-status to leave in-place feedback (a
        // toast would be painted under the modal); before the fix the
        // render only emitted the element — without the id, and only
        // when a message already existed — so the lookup always missed
        // and the feedback silently vanished.
        expect(appSource).toContain('id="meal-draft-add-text-status"');
        expect(appSource).toContain(
            'getElementById(\n            "meal-draft-add-text-status",\n        )',
        );
    });
});

describe("meal-import widget progress + drop-zone var (import-meals.html)", () => {
    test("progress() is called with (label, value, goal, unit)", () => {
        // ui.js defines progress(label, value, goal, unit, color); the
        // old call passed (ratio * 100, "Import progress") — a number
        // as the label and the label as the value — so the bar never
        // rendered real progress.
        expect(importMealsHtml).not.toContain(
            'progress(ratio * 100, "Import progress")',
        );
        expect(importMealsHtml).toContain(
            'progress("Import progress", imported, total, "rows")',
        );
        expect(importMealsHtml).toContain("importedRows: 0");
        expect(importMealsHtml).toContain("totalRows: S.rows.length");
        expect(importMealsHtml).toContain(
            "S.progress.importedRows += batch.length",
        );
    });

    test("the drop zone no longer references the undefined --accent-soft", () => {
        expect(importMealsHtml).not.toContain("--accent-soft");
        expect(importMealsHtml).toContain(
            "background: var(--green-tint, #eef4ea)",
        );
    });
});

describe("pantry barcode scanner injection (mobile/pantry-native.js)", () => {
    test("the scan control injects into the tools rail that exists", () => {
        // pantry.html retired .grid-two (the pantry UI smoke asserts
        // it never returns); the old injector queried it, got null,
        // and silently returned — barcode scanning never appeared.
        expect(pantryHtml).toContain('class="tools-rail"');
        expect(pantryHtml).not.toContain('class="grid-two"');
        expect(pantryNativeSource).not.toContain(".grid-two");
        expect(pantryNativeSource).not.toContain("injectBarcodeCard");
        expect(pantryNativeSource).toContain("injectBarcodeTool");
        expect(pantryNativeSource).toContain('$(".tools-rail")');
        expect(pantryNativeSource).toContain('id = "native-barcode-scan"');
        expect(pantryNativeSource).toContain('className = "native-rail-tool"');
    });

    test("the injected control is not one of the page's rail tools", () => {
        // .rail-tool is the pantry page's own shipped tool set — the
        // four tools the packaged placement checks enumerate by
        // data-open-sheet / data-testid. The barcode control is a
        // packaged-shell-only injection with neither attribute; under
        // the shipped class it entered that enumeration as a null
        // entry (the deterministic mobile-parity failure this pins
        // against). It mirrors the rail styles under its own class
        // instead — closed PR #342's original arrangement.
        expect(pantryNativeSource).not.toContain('className = "rail-tool"');
        expect(pantryCss).toContain(".rail-tool,\n.native-rail-tool {");
        expect(pantryCss).toContain(
            ".rail-tool:hover,\n.native-rail-tool:hover {",
        );
        expect(pantryCss).toContain(".rail-tool svg,\n.native-rail-tool svg {");
    });
});

describe("photo-capture button crush (app-overrides.css)", () => {
    test("the 44px square icon rule names the camera button, not the labeled buttons", () => {
        const start = overridesCss.indexOf("Icon-only controls keep a square");
        expect(start).toBeGreaterThan(-1);
        const group = overridesCss.slice(start, start + 700);
        expect(group).toContain(".photo-capture-camera,");
        expect(group).not.toContain(".photo-capture-button,");
        expect(group).toContain(".photo-capture-camera::after,");
        expect(group).not.toContain(".photo-capture-button::after,");
        // The labeled buttons keep their hit-floor rule.
        expect(overridesCss).toContain(
            ".photo-capture-button {\n    min-height: 44px;\n}",
        );
    });
});

describe("toast top layer (app.html, app.js, app-patches.js, styles.css)", () => {
    test("the toast region is a manual popover, shown/hidden with its toasts", () => {
        expect(appHtml).toContain('popover="manual"');
        expect(appSource).toContain("function showToastRegion()");
        expect(appSource).toContain("function hideToastRegionIfEmpty()");
        expect(appSource).toContain("toastRegion.showPopover()");
        expect(appSource).toContain("toastRegion.hidePopover()");
        expect(patchesSource).toContain("patchToastRegion.showPopover()");
        expect(patchesSource).toContain("patchToastRegion.hidePopover()");
    });

    test("the popover support CSS keeps the region pinned where it was", () => {
        expect(stylesCss).toContain(".toast-region[popover] {");
        expect(stylesCss).toContain("inset: auto 20px 20px auto;");
        expect(stylesCss).toContain(
            ".toast-region[popover]:not(:popover-open) {",
        );
    });
});

describe("mobile shell fixes (runtime.js, mobile-login.js)", () => {
    test("installed return routes keep their query string", () => {
        const occurrences = runtimeSource.match(
            /`\$\{location\.pathname\}\$\{location\.search\}`/g,
        );
        expect(occurrences?.length).toBe(2);
    });

    test("the Android back button routes dialog closes through the dialog's own path", () => {
        expect(runtimeSource).toContain("'[data-action=\"close-dialog\"]'");
        expect(runtimeSource).toContain(
            'new Event("cancel", { cancelable: true })',
        );
    });

    test("sign-in availability probes run in parallel", () => {
        expect(mobileLoginSource).toContain(
            "const [appleAvailable, googleAvailable] = await Promise.all([",
        );
        expect(mobileLoginSource).not.toContain(
            "appleButton.hidden = !(await isAppleSignInAvailable())",
        );
        expect(mobileLoginSource).not.toContain(
            "googleButton.hidden = !(await isGoogleSignInAvailable())",
        );
    });
});
