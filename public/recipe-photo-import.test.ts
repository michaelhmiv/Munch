import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Cross-work slice 3 — photo recipe import, client side. Source-level
// assertions in the style of recipes-library.test.ts: the Photo door
// sits beside Import in the Recipes header, the capture dialog reuses
// the shared photo-capture control, the submit posts to the photo
// preview endpoint, and the result lands in the SAME import-review
// dialog the URL importer populates.

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const cssSource = readFileSync(
    new URL("./app-overrides.css", import.meta.url),
    "utf8",
);

test("Recipes header carries exactly Import · Photo · Create, in that order", () => {
    const render = appSource.match(
        /async function renderRecipes\(\) \{[\s\S]*?\n\}/,
    )![0];
    expect(render).toContain('data-action="import-recipe-url"');
    expect(render).toContain('data-action="import-recipe-photo"');
    expect(render).toContain('data-action="create-recipe"');
    const header = render.slice(
        render.indexOf("auth-actions recipe-actions"),
        render.indexOf("recipe-filter-row"),
    );
    // The header interpolates the three door buttons in order.
    expect(header).toContain("${importButton}${photoButton}${createButton}");
    // The Photo door is a secondary door, never a second primary.
    const photoButton = render.match(
        /<button[^>]*data-action="import-recipe-photo"[^>]*>/,
    )![0];
    expect(photoButton).toContain("button-secondary");
    expect(photoButton).toContain("recipe-photo-door");
    expect(photoButton).not.toContain("button-primary");
    expect(render).toContain(">Photo</button>");
});

test("Photo door CSS is direction C at the 31px anchor with a ≥44px tap overlay", () => {
    const door = cssSource.match(
        /\.recipes-view \.recipe-actions \.recipe-photo-door \{([\s\S]*?)\}/,
    )![1];
    expect(door).toContain("min-height: 31px");
    expect(door).toContain("height: 31px");
    expect(door).toContain("padding: 6px 14px");
    expect(door).toContain("border: 1px solid #8a7c63");
    expect(door).toContain("border-radius: 10px");
    expect(door).toContain("background: transparent");
    expect(door).toContain("color: #2b2620");
    expect(door).not.toContain("#efe9db");
    const overlay = cssSource.match(
        /\.recipes-view \.recipe-actions \.recipe-photo-door::after \{([\s\S]*?)\}/,
    )![1];
    expect(overlay).toContain("inset: -7px 0");
    // The header keeps slice 2's deliberate single-row scroll at
    // phone widths (never a page-level overflow); slice 3 adds the
    // trailing-fade affordance so the third door reads as scrollable.
    const mobile = cssSource.slice(
        cssSource.indexOf(
            "@media (max-width: 899px)",
            cssSource.indexOf("recipe-panel-actions"),
        ),
    );
    const row = mobile.match(
        /\.recipes-view \.recipe-actions \{([\s\S]*?)\}/,
    )![1];
    expect(row).toContain("flex-wrap: nowrap");
    expect(row).toContain("overflow-x: auto");
    expect(row).toContain("mask-image: linear-gradient");
});

test("capture dialog reuses the shared photo-capture control, not a second uploader", () => {
    const open = appSource.match(
        /function openRecipePhotoImport\(\) \{[\s\S]*?\n\}/,
    )![0];
    expect(open).toContain("photoCaptureMarkup");
    expect(open).toContain('inputId: "recipe-photo-file"');
    expect(open).toContain('data-action="submit-recipe-photo"');
    expect(open).not.toContain('type="file"');
});

test("submit downscales, posts the photo preview endpoint, and opens the shared review dialog", () => {
    const submit = appSource.match(
        /async function submitRecipePhoto\(\) \{[\s\S]*?\n\}/,
    )![0];
    expect(submit).toContain("downscaleImageFile(file)");
    expect(submit).toContain('"/api/app/recipes/import-photo-preview"');
    expect(submit).toContain("openRecipeImportReview(data.draft)");
    const dispatch = appSource.match(
        /if \(action === "import-recipe-photo"\)[^\n]*/,
    )![0];
    expect(dispatch).toContain("openRecipePhotoImport()");
    expect(appSource).toContain(
        'if (action === "submit-recipe-photo") return submitRecipePhoto();',
    );
});

test("review dialog renders a photo source line instead of a dead URL link", () => {
    const review = appSource.match(
        /function recipeImportReviewMarkup\(draft\) \{[\s\S]*?\n\}/,
    )![0];
    expect(review).toContain("draft.source.final_url");
    expect(review).toContain("Recipe photo");
    // Warnings from the photo read surface through the existing
    // warnings pattern in the same markup.
    expect(review).toContain("Review warnings");
    expect(review).toContain("draft.warnings");
});
