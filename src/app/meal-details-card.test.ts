import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const PUBLIC = join(import.meta.dir, "..", "..", "public");

/**
 * Regression guards for the owner-approved meal-details slim card
 * (2026-11-22): the item card drops from ~214px to ~106px — portion
 * inline on the name line, confidence as plain text, no Source
 * snapshot, no in-card Remove button — and gains a per-item swipe
 * tray (Edit / Remove). Photo-derived estimates read "Photo
 * estimate", driven by the item's own grounding snapshot.
 */
describe("meal details slim card + swipe (owner-approved, 2026-11-22)", () => {
    test("item template renders the swipe wrap and tray", async () => {
        const appJs = await Bun.file(join(PUBLIC, "app.js")).text();
        expect(appJs).toContain('class="swipe-wrap"');
        expect(appJs).toContain('class="swipe-action swipe-edit"');
        expect(appJs).toContain('class="swipe-action swipe-remove"');
        expect(appJs).toContain("meal-detail-item-card");
    });

    test("item template is slim: inline portion, inline confidence, no snapshot, no in-card Remove", async () => {
        const appJs = await Bun.file(join(PUBLIC, "app.js")).text();
        expect(appJs).toContain('class="portion-inline"');
        expect(appJs).toContain('class="confidence-inline"');
        expect(appJs).not.toContain("<summary>Source snapshot</summary>");
        // The only remove-meal-item-detail button is the tray's.
        const occurrences =
            appJs.split('data-action="remove-meal-item-detail"').length - 1;
        expect(occurrences).toBe(1);
        expect(appJs).toContain(
            'class="swipe-action swipe-remove" type="button" data-action="remove-meal-item-detail"',
        );
    });

    test("photo-derived estimates are labelled Photo estimate from the snapshot", async () => {
        const appJs = await Bun.file(join(PUBLIC, "app.js")).text();
        expect(appJs).toContain(
            'item?.sourceSnapshot?.resolution_layer === "meal_photo_grounding"',
        );
        expect(appJs).toContain('return "Photo estimate"');
    });

    test("tray Remove confirms inside the card", async () => {
        const appJs = await Bun.file(join(PUBLIC, "app.js")).text();
        expect(appJs).toContain("function showCardInlineConfirm(");
        expect(appJs).toContain("showCardInlineConfirm(card, {");
    });

    test("swipe CSS: 152px tray, house destructive red, inline portion", async () => {
        const css = await Bun.file(join(PUBLIC, "app-overrides.css")).text();
        expect(css).toMatch(/\.swipe-tray\s*\{[^}]*width:\s*152px;/);
        expect(css).toMatch(/\.swipe-remove\s*\{[^}]*background:\s*#8c2f22;/);
        expect(css).toMatch(
            /\.dialog-content \.food-row \.portion-inline\s*\{\s*display:\s*inline;/,
        );
    });
});
