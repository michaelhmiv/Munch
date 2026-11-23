import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const PUBLIC = join(import.meta.dir, "..", "..", "public");

/**
 * Regression guard for the 2026-11-22 device find (build 807): the
 * item-assumptions element ships with the `hidden` attribute, but the
 * food-row small rules set `display` (block in styles.css, inline in
 * .operate-view), which overrides the UA [hidden] rule — so the text
 * rendered anyway. The scoped guard rule in app-overrides.css is what
 * actually keeps assumptions collapsed until the chip is tapped.
 */
describe("item assumptions collapse (owner ruling, 2026-11-22)", () => {
    test("renderer emits the assumptions region hidden by default", async () => {
        const appJs = await Bun.file(join(PUBLIC, "app.js")).text();
        expect(appJs).toContain('class="item-assumptions" hidden');
        expect(appJs).toContain('data-action="toggle-item-assumptions"');
    });

    test("CSS guard beats the food-row small display rules", async () => {
        const css = await Bun.file(join(PUBLIC, "app-overrides.css")).text();
        expect(css).toMatch(
            /\.food-row \.item-assumptions\[hidden\]\s*\{\s*display:\s*none;/,
        );
    });
});
