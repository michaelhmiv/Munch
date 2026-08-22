export interface RecipeImportCorpusEntry {
    id: string;
    site: string;
    url: string;
    variety: string;
    patterns: readonly string[];
}

/**
 * A deliberately broad, manually curated live corpus for recipe URL imports.
 *
 * This list is used by the manual corpus smoke workflows. It is intentionally
 * not fetched by ordinary PR CI: third-party pages change independently of
 * Munch, and the website-only OpenRouter path must never spend credits during
 * a normal pull request.
 */
export const RECIPE_IMPORT_CORPUS = [
    {
        id: "allrecipes-worlds-best-lasagna",
        site: "Allrecipes",
        url: "https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/",
        variety: "Italian-American layered casserole",
        patterns: ["large ingredient list", "cans", "mixed units"],
    },
    {
        id: "food-network-gorgonzola-pasta",
        site: "Food Network",
        url: "https://www.foodnetwork.com/recipes/food-network-kitchen/gorgonzola-pasta-with-spinach-and-walnuts-10024399",
        variety: "vegetarian pasta",
        patterns: [
            "to taste seasoning",
            "parenthetical amount",
            "structured steps",
        ],
    },
    {
        id: "serious-eats-gaziantep-chicken",
        site: "Serious Eats",
        url: "https://www.seriouseats.com/ana-sortuns-gaziantep-chicken-with-tahini-sauce",
        variety: "Turkish/Middle Eastern chicken",
        patterns: ["multi-component recipe", "spice blend", "sauce component"],
    },
    {
        id: "simply-recipes-tortellini-soup",
        site: "Simply Recipes",
        url: "https://www.simplyrecipes.com/quick-tortellini-soup-recipe-11999755",
        variety: "quick Italian-American soup",
        patterns: ["short recipe", "optional garnish", "minutes metadata"],
    },
    {
        id: "bon-appetit-honey-lemon-chicken",
        site: "Bon Appétit",
        url: "https://www.bonappetit.com/recipe/honey-glazed-lemon-chicken",
        variety: "roasted poultry",
        patterns: [
            "yield wording",
            "quantity-less seasoning",
            "fraction quantities",
        ],
    },
    {
        id: "bbc-good-food-thai-green-curry",
        site: "BBC Good Food",
        url: "https://www.bbcgoodfood.com/recipes/thai-green-chicken-curry",
        variety: "Thai curry",
        patterns: ["metric units", "alternatives", "serving accompaniment"],
    },
    {
        id: "recipe-tin-eats-moussaka-pilaf",
        site: "RecipeTin Eats",
        url: "https://www.recipetineats.com/one-pot-moussaka-beef-rice-pilaf/",
        variety: "Greek-inspired one-pot rice",
        patterns: ["metric/imperial pair", "alternative meat", "one-pot meal"],
    },
    {
        id: "love-and-lemons-ribollita",
        site: "Love & Lemons",
        url: "https://www.loveandlemons.com/ribollita-tuscan-white-bean-soup/",
        variety: "Tuscan bean soup",
        patterns: [
            "alternative vegetables",
            "canned ingredient",
            "recipe notes",
        ],
    },
    {
        id: "minimalist-baker-vegan-ramen",
        site: "Minimalist Baker",
        url: "https://minimalistbaker.com/easy-vegan-ramen/",
        variety: "vegan Japanese-inspired ramen",
        patterns: ["sectioned ingredients", "decimal quantity", "diet tags"],
    },
    {
        id: "damn-delicious-summer-spaghetti",
        site: "Damn Delicious",
        url: "https://damndelicious.net/2018/07/17/summer-spaghetti-with-tomatoes-and-burrata/",
        variety: "summer tomato pasta",
        patterns: ["compound quantity", "to taste seasoning", "fresh produce"],
    },
    {
        id: "the-kitchn-beef-stroganoff",
        site: "The Kitchn",
        url: "https://www.thekitchn.com/recipe-one-pot-weeknight-beef-stroganoff-249761",
        variety: "one-pot beef comfort food",
        patterns: ["serves range", "divided ingredient", "nutrition metadata"],
    },
    {
        id: "delish-ritz-chicken-cutlets",
        site: "Delish",
        url: "https://www.delish.com/cooking/recipe-ideas/a73467103/cheesy-ritz-cracker-chicken-cutlets-recipe/",
        variety: "breaded chicken cutlets",
        patterns: ["new-style article URL", "crushed topping", "pan sauce"],
    },
    {
        id: "king-arthur-focaccia",
        site: "King Arthur Baking",
        url: "https://www.kingarthurbaking.com/recipes/big-and-bubbly-focaccia-recipe",
        variety: "yeasted bread",
        patterns: ["gram weights", "ingredient sections", "yield by pan size"],
    },
    {
        id: "food52-butterscotch-pecan-pie",
        site: "Food52",
        url: "https://food52.com/recipes/82447-butterscotch-pecan-pie-recipe",
        variety: "custard pie",
        patterns: ["baking dessert", "garnish quantity", "prepared ingredient"],
    },
    {
        id: "epicurious-baked-feta-pasta",
        site: "Epicurious",
        url: "https://www.epicurious.com/recipes/food/views/ba-syn-baked-feta-pasta-green-sauce",
        variety: "vegetarian baked pasta",
        patterns: [
            "syndicated recipe path",
            "green sauce",
            "substitution language",
        ],
    },
    {
        id: "just-one-cookbook-wonton-soup",
        site: "Just One Cookbook",
        url: "https://www.justonecookbook.com/shrimp-pork-wonton/",
        variety: "Japanese shrimp and pork wonton soup",
        patterns: [
            "multiple ingredient sections",
            "package quantity",
            "bilingual title",
        ],
    },
    {
        id: "once-upon-a-chef-beef-stew",
        site: "Once Upon a Chef",
        url: "https://www.onceuponachef.com/recipes/beef-stew-with-carrots-potatoes.html",
        variety: "French-style beef stew",
        patterns: [
            "long-form editorial page",
            "wine/broth choices",
            "slow braise",
        ],
    },
    {
        id: "budget-bytes-white-chicken-chili",
        site: "Budget Bytes",
        url: "https://www.budgetbytes.com/slow-cooker-white-chicken-chili/",
        variety: "slow-cooker white chicken chili",
        patterns: ["slow cooker", "canned beans", "budget recipe metadata"],
    },
    {
        id: "skinnytaste-red-lentil-soup",
        site: "Skinnytaste",
        url: "https://www.skinnytaste.com/red-lentil-soup-with-spinach/",
        variety: "Mediterranean-inspired lentil soup",
        patterns: [
            "diet abbreviations",
            "alternative broth",
            "nutrition facts",
        ],
    },
    {
        id: "gimme-some-oven-baked-mac",
        site: "Gimme Some Oven",
        url: "https://www.gimmesomeoven.com/baked-mac-and-cheese/",
        variety: "baked macaroni and cheese",
        patterns: [
            "ingredient sections",
            "cheese alternative",
            "topping component",
        ],
    },
] as const satisfies readonly RecipeImportCorpusEntry[];

export const RECIPE_IMPORT_CORPUS_HOSTS = new Set(
    RECIPE_IMPORT_CORPUS.map((entry) => new URL(entry.url).hostname),
);
