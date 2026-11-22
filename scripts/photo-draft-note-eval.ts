/**
 * Held-out generalization eval for the model-first photo draft note
 * interpreter (eval-only, NOT a CI gate).
 *
 * Runs 18 diverse free-text notes (corrections, additions, removals,
 * quantity overrides, and ambiguous corrections — none of which appear
 * in DRAFT_ADD_PARSE_PROMPT) against the REAL Ember endpoint via
 * `parseDraftAddTextWithModel` and scores:
 * - per-phrasing action + target_item_id correctness;
 * - hard bars: every correction resolves to `replace` or `question`,
 *   ZERO silent appends of a corrected item, ZERO lost items.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun scripts/photo-draft-note-eval.ts
 *   bun scripts/photo-draft-note-eval.ts --dry-run
 */
import {
    parseDraftAddTextWithModel,
    type DraftAddAction,
    type DraftAddParseContextItem,
} from "../src/meal-photo/draft-add-parse.js";
import { mealPhotoVisionConfig } from "../src/meal-photo/vision.js";

interface EvalCase {
    id: string;
    note: string;
    draft: DraftAddParseContextItem[];
    expectedActions: DraftAddAction[];
    expectedTargetId: string | null;
    /** True when the note is a correction that must NEVER silently append. */
    isCorrection: boolean;
    /** Optional expected stated quantity (null = must stay unstated for carryover). */
    expectQuantityStated?: boolean;
}

const SAUSAGE_MUSTARD_DRAFT: DraftAddParseContextItem[] = [
    {
        id: "item-hotdog",
        name: "hot dog",
        visionName: "hot dog",
        cookingMethod: "grilled",
        quantity: 2,
        portionLabel: "2 piece",
    },
    {
        id: "item-mustard",
        name: "mustard sauce",
        visionName: "mustard sauce",
        cookingMethod: null,
        quantity: 1,
        portionLabel: "1 tbsp",
    },
];

const SAUSAGE_BUN_MUSTARD_DRAFT: DraftAddParseContextItem[] = [
    ...SAUSAGE_MUSTARD_DRAFT,
    {
        id: "item-bun",
        name: "hot dog bun",
        visionName: "hot dog bun",
        cookingMethod: null,
        quantity: 2,
        portionLabel: "2 piece",
    },
];

const TWO_MEAT_DRAFT: DraftAddParseContextItem[] = [
    {
        id: "item-chicken",
        name: "chicken breast",
        visionName: "grilled chicken breast",
        cookingMethod: "grilled",
        quantity: 150,
        portionLabel: "150 g",
    },
    {
        id: "item-turkey",
        name: "turkey breast",
        visionName: "roasted turkey breast",
        cookingMethod: "roasted",
        quantity: 150,
        portionLabel: "150 g",
    },
];

const EVAL_CASES: EvalCase[] = [
    // Corrections against the two-item incident draft
    {
        id: "corr-01",
        note: "turns out they were brats",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["replace"],
        expectedTargetId: "item-hotdog",
        isCorrection: true,
        expectQuantityStated: false,
    },
    {
        id: "corr-02",
        note: "my bad, the sausages were bratwurst",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["replace"],
        expectedTargetId: "item-hotdog",
        isCorrection: true,
        expectQuantityStated: false,
    },
    {
        id: "corr-03",
        note: "the dogs are actually brats",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["replace"],
        expectedTargetId: "item-hotdog",
        isCorrection: true,
        expectQuantityStated: false,
    },
    {
        id: "corr-04",
        note: "swap the hot dogs for bratwurst",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["replace"],
        expectedTargetId: "item-hotdog",
        isCorrection: true,
        expectQuantityStated: false,
    },
    {
        id: "corr-05",
        note: "it was a brat, not a dog",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["replace"],
        expectedTargetId: "item-hotdog",
        isCorrection: true,
        expectQuantityStated: false,
    },
    {
        id: "corr-06",
        note: "those are kielbasa",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["replace"],
        expectedTargetId: "item-hotdog",
        isCorrection: true,
        expectQuantityStated: false,
    },
    {
        id: "corr-07",
        note: "oops that's spicy brown mustard, not yellow",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["replace"],
        expectedTargetId: "item-mustard",
        isCorrection: true,
        expectQuantityStated: false,
    },
    {
        id: "corr-08",
        note: "actually just one bratwurst, I didn't eat the second one",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["replace"],
        expectedTargetId: "item-hotdog",
        isCorrection: true,
        expectQuantityStated: true,
    },
    {
        id: "corr-09",
        note: "the bun was a pretzel bun",
        draft: SAUSAGE_BUN_MUSTARD_DRAFT,
        expectedActions: ["replace"],
        expectedTargetId: "item-bun",
        isCorrection: true,
        expectQuantityStated: false,
    },
    {
        id: "corr-10",
        note: "whole wheat buns, not white",
        draft: SAUSAGE_BUN_MUSTARD_DRAFT,
        expectedActions: ["replace"],
        expectedTargetId: "item-bun",
        isCorrection: true,
        expectQuantityStated: false,
    },
    // Pure additions
    {
        id: "add-01",
        note: "also I had a beer",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["add"],
        expectedTargetId: null,
        isCorrection: false,
    },
    {
        id: "add-02",
        note: "threw some sauerkraut on top",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["add"],
        expectedTargetId: null,
        isCorrection: false,
    },
    {
        id: "add-03",
        note: "had a handful of kettle chips on the side",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["add"],
        expectedTargetId: null,
        isCorrection: false,
    },
    {
        id: "add-04",
        note: "plus 2 tbsp ketchup",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["add"],
        expectedTargetId: null,
        isCorrection: false,
        expectQuantityStated: true,
    },
    // Removals
    {
        id: "rem-01",
        note: "skip the mustard",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["remove"],
        expectedTargetId: "item-mustard",
        isCorrection: true,
    },
    {
        id: "rem-02",
        note: "didn't end up using the mustard",
        draft: SAUSAGE_MUSTARD_DRAFT,
        expectedActions: ["remove"],
        expectedTargetId: "item-mustard",
        isCorrection: true,
    },
    // Ambiguous corrections (must ask, never guess or append)
    {
        id: "amb-01",
        note: "it was actually pork",
        draft: TWO_MEAT_DRAFT,
        expectedActions: ["question"],
        expectedTargetId: null,
        isCorrection: true,
    },
    {
        id: "amb-02",
        note: "one of those was duck instead",
        draft: TWO_MEAT_DRAFT,
        expectedActions: ["question"],
        expectedTargetId: null,
        isCorrection: true,
    },
];

const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
    console.log(
        `[photo-draft-note-eval] Dry run OK: ${EVAL_CASES.length} held-out cases ready.`,
    );
    process.exit(0);
}

const config = mealPhotoVisionConfig();
if (!config) {
    console.error(
        "[photo-draft-note-eval] OPENROUTER_API_KEY is not configured; cannot run live Ember eval.",
    );
    process.exit(2);
}

let exactPass = 0;
let silentAppends = 0;
let lostItems = 0;
let errors = 0;

console.log(
    `| Case | Note | Expected | Actual | Target | Items | Quantity Stated? | Result |`,
);
console.log(`| --- | --- | --- | --- | --- | --- | --- | --- |`);

for (const c of EVAL_CASES) {
    try {
        const result = await parseDraftAddTextWithModel(
            c.note,
            config,
            {},
            {
                items: c.draft,
            },
        );
        const actionOk = c.expectedActions.includes(result.action);
        const targetOk =
            c.expectedTargetId === null
                ? result.targetItemId === null
                : result.targetItemId === c.expectedTargetId;
        const quantityStated = result.items.some((item) => item.strongSignal);
        const qtyOk =
            c.expectQuantityStated === undefined
                ? true
                : quantityStated === c.expectQuantityStated;

        if (c.isCorrection && result.action === "add") {
            silentAppends += 1;
        }
        if (
            c.expectedActions.includes("replace") &&
            result.action === "remove"
        ) {
            lostItems += 1;
        }
        const ok = actionOk && targetOk && qtyOk;
        if (ok) exactPass += 1;
        const itemSummary =
            result.items
                .map((i) => `${i.name} (${i.quantity} ${i.unit})`)
                .join(", ") || "—";
        console.log(
            `| ${c.id} | ${c.note} | ${c.expectedActions.join("/")}${c.expectedTargetId ? `(${c.expectedTargetId})` : ""} | ${result.action} | ${result.targetItemId ?? "null"} | ${itemSummary} | ${quantityStated} | ${ok ? "PASS" : "MISS"} |`,
        );
    } catch (error) {
        errors += 1;
        console.log(
            `| ${c.id} | ${c.note} | ${c.expectedActions.join("/")} | ERROR | — | ${error instanceof Error ? error.message : String(error)} | — | ERROR |`,
        );
    }
}

console.log(
    `\nSummary (${config.model}): ${exactPass}/${EVAL_CASES.length} exact pass | silent_appends=${silentAppends} | lost_items=${lostItems} | errors=${errors}`,
);
if (silentAppends > 0 || lostItems > 0 || errors > 0) {
    process.exit(1);
}
