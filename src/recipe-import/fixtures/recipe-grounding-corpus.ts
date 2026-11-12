import type { RecipeParseStrategy } from "../parser.js";

/**
 * Live grounding corpus for the recipe importer.
 *
 * Unlike `recipe-corpus.ts` (parse-strategy smoke over 21 pages), this
 * small set is run through the full importer (`previewRecipeUrl` with
 * the real food search service) by
 * `scripts/recipe-import-grounding-corpus.ts` and asserts that a floor
 * share of ingredients resolve to provider-grounded foods instead of
 * model estimates. It runs on workflow_dispatch and a weekly schedule
 * only; it never gates pull requests.
 *
 * Floors were set from measured first runs on 2026-11-11, not picked
 * aspirationally. Measured with a warm local USDA catalog plus live
 * provider backfill (production's cache-through shape), per-recipe
 * grounded rates were: King Arthur 37.5%, Love & Lemons 37.5%,
 * Modern Proper 46.7%, BBC Food 70.6%, Natasha's Kitchen 46.7%,
 * Skinnytaste 63.6%, 101 Cookbooks 50.0% — aggregate 52.3%. A repeat
 * run with the pre-fix parser measured a 46.1% aggregate over the
 * parseable entries, and individual recipes jitter by roughly
 * ±10 points between runs (candidate ranking and portion-fit margins),
 * so the floors sit well below every measured configuration:
 * per-recipe 20%, aggregate 35%. They exist to catch strategy
 * breakage and query corruption (the class of bug where "(284g)"
 * leaked into search text), not to grade the matcher.
 *
 * Strategy coverage notes, also measured 2026-11-11: no major live
 * recipe site still serves `recipeIngredient` microdata — the
 * surviving microdata in the wild is the legacy form that uses
 * schema.org's original `ingredients` property name. The BBC Food
 * entry below is an archived snapshot of bbc.co.uk/food carrying that
 * original markup (the live BBC recipe pages now use JSON-LD); the
 * snapshot has the side benefit of being byte-stable. One measured
 * candidate was deliberately excluded: Just One Cookbook's wonton
 * soup grounded only 15–25% across runs because its slash-compound
 * ingredient names ("green onion/scallion", "chicken stock/broth")
 * defeat the deterministic matcher; production's semantic resolver
 * covers part of that gap and the lane does not model it.
 */
export interface RecipeGroundingCorpusEntry {
    id: string;
    recipeUrl: string;
    expectedStrategy: RecipeParseStrategy;
    notes: string;
}

export const RECIPE_GROUNDING_CORPUS: RecipeGroundingCorpusEntry[] = [
    {
        id: "king-arthur-focaccia",
        recipeUrl:
            "https://www.kingarthurbaking.com/recipes/big-and-bubbly-focaccia-recipe",
        expectedStrategy: "schema_org_json_ld",
        notes: 'Baking lines carry mid-line gram weights such as "3 cups (360g) King Arthur Unbleached All-Purpose Flour"; measured 37.5% grounded.',
    },
    {
        id: "modern-proper-stuffed-pepper-soup",
        recipeUrl: "https://themodernproper.com/stuffed-pepper-soup",
        expectedStrategy: "schema_org_json_ld",
        notes: 'Package sizes in hyphenated form: "1 (14-ounce) can tomato sauce"; measured 46.7% grounded.',
    },
    {
        id: "natashas-kitchen-pierogi",
        recipeUrl: "https://natashaskitchen.com/pierogi-recipe/",
        expectedStrategy: "schema_org_json_ld",
        notes: 'Parenthesized prep notes stay in names ("cream cheese (softened)"); measured 46.7% grounded.',
    },
    {
        id: "skinnytaste-red-lentil-soup",
        recipeUrl: "https://www.skinnytaste.com/red-lentil-soup-with-spinach/",
        expectedStrategy: "schema_org_json_ld",
        notes: 'Trailing weight "2 cups baby spinach (2 oz)"; measured 63.6% grounded.',
    },
    {
        id: "101-cookbooks-spicy-cauliflower",
        recipeUrl: "https://www.101cookbooks.com/spicy-cauliflower/",
        expectedStrategy: "schema_org_json_ld",
        notes: "Metric/imperial pairs in ingredient text; measured 50.0% grounded.",
    },
    {
        id: "love-and-lemons-lemon-pasta",
        recipeUrl: "https://www.loveandlemons.com/lemon-pasta/",
        expectedStrategy: "recipe_card_html",
        notes: "The one large site in the set still serving WP Recipe Maker card HTML instead of JSON-LD; measured 37.5% grounded.",
    },
    {
        id: "bbc-food-chicken-casserole",
        recipeUrl:
            "https://git.macropus.org/bbc-food/www.bbc.co.uk/food/recipes/chickencasserole_85719.html",
        expectedStrategy: "microdata",
        notes: 'Archived BBC Food snapshot with legacy microdata (itemprop "ingredients"); before the legacy-alias fix this page failed to parse at all, after it measured 70.6% grounded.',
    },
];

/** Minimum grounded share for any single recipe in the corpus. */
export const RECIPE_GROUNDING_PER_RECIPE_FLOOR = 0.2;
/** Minimum grounded share across the whole corpus run. */
export const RECIPE_GROUNDING_AGGREGATE_FLOOR = 0.35;
