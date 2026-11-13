import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Pantry-presence flag client grammar, exercised on the real
// functions lifted out of app.js: the three-state flag on grocery
// rows (both list modes render through groceryItemRowMarkup) and
// the add-time run-out prompt with its once-per-session guard.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extract(name: string): string {
    const match = source.match(
        new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`app.js function not found: ${name}`);
    return match[0];
}

function extractConst(name: string): string {
    const match = source.match(new RegExp(`const ${name} = \`[^\`]*\`;`));
    if (!match) throw new Error(`app.js const not found: ${name}`);
    return match[0];
}

const context: Record<string, unknown> = {
    state: { pantryRunOutPrompted: new Set<string>() },
};
runInNewContext(
    [
        extract("escapeHtml"),
        extract("number"),
        extractConst("PANTRY_FLAG_CHECK_SVG"),
        extractConst("PANTRY_FLAG_CIRCLE_SVG"),
        extractConst("PANTRY_FLAG_BASKET_SVG"),
        extract("pantryFlagMarkup"),
        extract("groceryPantryBadgeMarkup"),
        extract("pantryRunOutPromptKey"),
        extract("shouldShowPantryRunOutPrompt"),
        extract("groceryPantryPromptMarkup"),
        extract("groceryItemRowMarkup"),
    ].join("\n"),
    context,
);

const flagMarkup = context.pantryFlagMarkup as (flag: unknown) => string;
const badgeMarkup = context.groceryPantryBadgeMarkup as (
    item: unknown,
) => string;
const promptMarkup = context.groceryPantryPromptMarkup as (
    item: unknown,
    scope: string,
) => string;
const rowMarkup = context.groceryItemRowMarkup as (
    item: unknown,
    scope: string,
    editable: boolean,
) => string;
const shouldShow = context.shouldShowPantryRunOutPrompt as (
    scope: string,
    item: unknown,
) => boolean;
const prompted = (context.state as { pantryRunOutPrompted: Set<string> })
    .pantryRunOutPrompted;

const matchedItem = {
    grocery_item_id: "g1",
    name: "Milk",
    quantity: 1,
    unit: "gal",
    note: null,
    added_by: null,
    purchased_at: null,
    version: 3,
    pantry_match: { pantry_item_id: "pantry-milk", pantry_name: "Milk" },
    pantry_flag: {
        state: "have",
        pantry_item_id: "pantry-milk",
        pantry_name: "Milk",
    },
};
const noneItem = {
    ...matchedItem,
    grocery_item_id: "g2",
    name: "Flour",
    pantry_match: null,
    pantry_flag: { state: "none", pantry_item_id: null, pantry_name: null },
};
const moduleOffItem = { ...noneItem, grocery_item_id: "g3", pantry_flag: null };
const plainItem = {
    ...matchedItem,
    grocery_item_id: "g4",
    pantry_match: null,
    pantry_flag: null,
};

describe("presence flag", () => {
    test("a matched row carries the have flag with its pantry identity", () => {
        const row = rowMarkup(matchedItem, "personal", true);
        expect(row).toContain("pantry-flag pantry-flag-have");
        expect(row).toContain("In your pantry");
        expect(row).toContain('data-pantry-item-id="pantry-milk"');
        expect(row).toContain("<svg");
    });

    test("an unmatched row now says so explicitly — the none flag", () => {
        const row = rowMarkup(noneItem, "personal", true);
        expect(row).toContain("pantry-flag pantry-flag-none");
        expect(row).toContain("Not in pantry");
        expect(row).not.toContain("pantry-flag-have");
    });

    test("the flag renders on read-only rows too (shopping mode shares the row markup)", () => {
        expect(rowMarkup(matchedItem, "personal", false)).toContain(
            "In your pantry",
        );
        expect(rowMarkup(noneItem, "personal", false)).toContain(
            "Not in pantry",
        );
    });

    test("module off renders no flag at all — null is not none", () => {
        expect(badgeMarkup(moduleOffItem)).toBe("");
        expect(rowMarkup(moduleOffItem, "personal", true)).not.toContain(
            "pantry-flag",
        );
    });

    test("the flag is exactly the factual statement — no amount, no verdict", () => {
        const badge = badgeMarkup(matchedItem);
        const text = badge.replace(/<[^>]*>/g, "");
        expect(text).toBe("In your pantry");
        expect(text).not.toMatch(/\d/);
        expect(text.toLowerCase()).not.toMatch(
            /caution|warning|already have|don'?t need|covered|enough|⚠|!/,
        );
        const noneText = badgeMarkup(noneItem).replace(/<[^>]*>/g, "");
        expect(noneText).toBe("Not in pantry");
        expect(noneText.toLowerCase()).not.toMatch(
            /caution|warning|missing|⚠|!/,
        );
    });

    test("every state carries a mark — svg, never a character glyph", () => {
        for (const state of ["have", "none", "listed"] as const) {
            const markup = flagMarkup({
                state,
                pantry_item_id: state === "have" ? "p1" : null,
                pantry_name: null,
            });
            expect(markup).toContain("<svg");
            expect(markup).toContain(
                `pantry-flag-${state === "have" ? "have" : state}`,
            );
        }
        expect(
            flagMarkup({
                state: "listed",
                pantry_item_id: null,
                pantry_name: null,
            }),
        ).toContain("On your list");
        expect(flagMarkup(null)).toBe("");
        expect(flagMarkup(undefined)).toBe("");
    });

    test("legacy payloads without the flag field fall back to badge semantics", () => {
        const legacyMatched: Record<string, unknown> = { ...matchedItem };
        delete legacyMatched.pantry_flag;
        expect(badgeMarkup(legacyMatched)).toContain("In your pantry");
        const legacyUnmatched = { ...legacyMatched, pantry_match: null };
        expect(badgeMarkup(legacyUnmatched)).toBe("");
        expect(badgeMarkup({})).toBe("");
    });
});

describe("run-out prompt", () => {
    test("the prompt asks the owner's question with the two answers", () => {
        const markup = promptMarkup(matchedItem, "personal");
        expect(markup).toContain(
            "Milk is shown in the pantry — did you run out?",
        );
        expect(markup).toContain('data-action="pantry-ran-out"');
        expect(markup).toContain('data-pantry-item-id="pantry-milk"');
        expect(markup).toContain('data-action="pantry-still-have"');
        expect(markup).toContain(">Ran out<");
        expect(markup).toContain(">Still have it<");
    });

    test("the prompt carries no warning language and no amounts", () => {
        const markup = promptMarkup(matchedItem, "personal").toLowerCase();
        expect(markup).not.toMatch(/caution|warning|already have|⚠/);
        expect(markup).not.toMatch(/gal|cup|quantity/);
    });

    test("it shows once per pantry item per session, then never again", () => {
        expect(shouldShow("personal", matchedItem)).toBe(true);
        prompted.add("personal:pantry-milk");
        expect(shouldShow("personal", matchedItem)).toBe(false);
        // A different scope is a different list session question.
        expect(shouldShow("household", matchedItem)).toBe(true);
        // And an unmatched item never prompts.
        expect(shouldShow("personal", plainItem)).toBe(false);
    });
});
