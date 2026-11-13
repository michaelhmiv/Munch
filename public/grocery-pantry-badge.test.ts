import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { formatRecipeQuantity } from "./quantity-format.js";

// "Already have it" client grammar, exercised on the real functions
// lifted out of app.js: the presence badge on grocery rows (both
// list modes render through groceryItemRowMarkup) and the add-time
// run-out prompt with its once-per-session guard.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extract(name: string): string {
    const match = source.match(
        new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`app.js function not found: ${name}`);
    return match[0];
}

const context: Record<string, unknown> = {
    state: { pantryRunOutPrompted: new Set<string>() },
    formatRecipeQuantity,
};
runInNewContext(
    [
        extract("escapeHtml"),
        extract("number"),
        extract("groceryPantryBadgeMarkup"),
        extract("pantryRunOutPromptKey"),
        extract("shouldShowPantryRunOutPrompt"),
        extract("groceryPantryPromptMarkup"),
        extract("groceryItemRowMarkup"),
    ].join("\n"),
    context,
);

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
};
const plainItem = { ...matchedItem, grocery_item_id: "g2", pantry_match: null };

describe("presence badge", () => {
    test("a matched row carries the badge; an unmatched row does not", () => {
        expect(rowMarkup(matchedItem, "personal", true)).toContain(
            "In your pantry",
        );
        expect(rowMarkup(plainItem, "personal", true)).not.toContain(
            "grocery-pantry-badge",
        );
    });

    test("the badge renders on read-only rows too (shopping mode shares the row markup)", () => {
        expect(rowMarkup(matchedItem, "personal", false)).toContain(
            "In your pantry",
        );
    });

    test("the badge is exactly the factual flag — no amount, no verdict", () => {
        const badge = badgeMarkup(matchedItem);
        expect(badge).toContain(">In your pantry<");
        expect(badge).not.toMatch(/\d/);
        expect(badge.toLowerCase()).not.toMatch(
            /caution|warning|already have|don'?t need|covered|enough|⚠|!/,
        );
    });

    test("no badge markup at all without a pantry match", () => {
        expect(badgeMarkup(plainItem)).toBe("");
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
