const FRACTIONS: Record<string, string> = {
    "¼": "1/4",
    "½": "1/2",
    "¾": "3/4",
    "⅓": "1/3",
    "⅔": "2/3",
    "⅛": "1/8",
    "⅜": "3/8",
    "⅝": "5/8",
    "⅞": "7/8",
};

const PREPARATION_WORDS =
    "chopped|diced|minced|grated|halved|sliced|shredded|julienned|cubed|crushed|peeled|seeded|drained|rinsed|divided|melted|softened|thawed|beaten|trimmed|roughly chopped|finely chopped";
const UNIT =
    "g|gram(?:s)?|kg|kilogram(?:s)?|oz|ounce(?:s)?|lb|pound(?:s)?|ml|milliliter(?:s)?|l|liter(?:s)?|cup(?:s)?|tbsp|tablespoon(?:s)?|tsp|teaspoon(?:s)?|clove(?:s)?|slice(?:s)?|can(?:s)?|package(?:s)?|pkg|bottle(?:s)?|pinch(?:es)?|dash(?:es)?|sprig(?:s)?|stalk(?:s)?";

function replaceUnicodeFractions(value: string): string {
    return value
        .replace(/[¼½¾⅓⅔⅛⅜⅝⅞]/g, (fraction) => FRACTIONS[fraction] ?? fraction)
        .replace(/⁄/g, "/");
}

/**
 * Removes recipe-source syntax that has no bearing on food identity while
 * deliberately retaining brand names, lean percentages, preparation states
 * that are part of the food name, and trailing package sizes.
 */
export function canonicalizeFoodSearchQuery(value: string): string {
    let query = replaceUnicodeFractions(value)
        .normalize("NFKC")
        .replace(/[~≈]/g, " ")
        .replace(/\(\s*\$\s*\d+(?:\.\d{1,2})?\s*\)/g, " ")
        .replace(/\(\s*\d+(?:\.\d{1,2})?\s*(?:¢|cents?)\s*\)/gi, " ")
        .replace(
            new RegExp(`\\(\\s*(?:${PREPARATION_WORDS})\\s*\\)`, "gi"),
            " ",
        )
        .replace(
            new RegExp(
                `^\\s*(?:\\d+(?:\\s+\\d+\\/\\d+|\\/\\d+|\\.\\d+)?|\\d+\\/\\d+)\\s+(?:${UNIT})\\b\\s*(?:of\\s+)?`,
                "i",
            ),
            "",
        )
        .replace(
            new RegExp(`,\\s*(?:${PREPARATION_WORDS})\\b[\\s\\S]*$`, "i"),
            "",
        )
        .replace(/,?\s+(?:for serving|for garnish|to taste)\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();

    if (!query) query = value.trim();
    return query;
}
