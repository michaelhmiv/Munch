import type {
    ParsedRecipe,
    ParsedRecipeIngredient,
    RecipeImportWarning,
} from "./types.js";

export const RECIPE_IMPORT_PARSER_VERSION = "1.0.0";

const UNICODE_FRACTIONS: Record<string, string> = {
    "¼": "1/4",
    "½": "1/2",
    "¾": "3/4",
    "⅐": "1/7",
    "⅑": "1/9",
    "⅒": "1/10",
    "⅓": "1/3",
    "⅔": "2/3",
    "⅕": "1/5",
    "⅖": "2/5",
    "⅗": "3/5",
    "⅘": "4/5",
    "⅙": "1/6",
    "⅚": "5/6",
    "⅛": "1/8",
    "⅜": "3/8",
    "⅝": "5/8",
    "⅞": "7/8",
};

const COMMON_UNITS = new Set([
    "bag",
    "bottle",
    "can",
    "clove",
    "cloves",
    "cup",
    "cups",
    "dash",
    "drop",
    "each",
    "g",
    "head",
    "heads",
    "gram",
    "grams",
    "inch",
    "inches",
    "jar",
    "kg",
    "kilogram",
    "kilograms",
    "lb",
    "lbs",
    "liter",
    "liters",
    "litre",
    "litres",
    "ml",
    "ounce",
    "ounces",
    "oz",
    "package",
    "packages",
    "piece",
    "pieces",
    "pinch",
    "pint",
    "pints",
    "pound",
    "pounds",
    "quart",
    "quarts",
    "slice",
    "slices",
    "sprig",
    "sprigs",
    "stalk",
    "stalks",
    "tbsp",
    "tablespoon",
    "tablespoons",
    "tsp",
    "teaspoon",
    "teaspoons",
    "serving",
    "servings",
]);

function warning(
    code: string,
    message: string,
    field?: string,
): RecipeImportWarning {
    return { code, message, severity: "warning", ...(field ? { field } : {}) };
}

function decodeHtml(value: string): string {
    const named: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: '"',
    };
    return value
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
            const codePoint = Number.parseInt(hex, 16);
            return Number.isFinite(codePoint)
                ? String.fromCodePoint(codePoint)
                : "";
        })
        .replace(/&#(\d+);/g, (_match, decimal: string) => {
            const codePoint = Number.parseInt(decimal, 10);
            return Number.isFinite(codePoint)
                ? String.fromCodePoint(codePoint)
                : "";
        })
        .replace(
            /&([a-z]+);/gi,
            (match, name: string) => named[name.toLowerCase()] ?? match,
        )
        .replace(/\u00a0/g, " ");
}

function stripTags(value: string): string {
    return decodeHtml(value.replace(/<[^>]*>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
}

function stringValue(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = stripTags(value);
    return text || undefined;
}

function firstString(value: unknown): string | undefined {
    if (typeof value === "string") return stringValue(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = firstString(item);
            if (found) return found;
        }
    }
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return (
            firstString(record.name) ??
            firstString(record.text) ??
            firstString(record.value)
        );
    }
    return undefined;
}

function extractAttribute(tag: string, attribute: string): string | undefined {
    const match = new RegExp(
        `\\b${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
        "i",
    ).exec(tag);
    return match?.[2] ? decodeHtml(match[2]).trim() : undefined;
}

function extractMeta(html: string, key: string): string | undefined {
    const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of tags) {
        const property =
            extractAttribute(tag, "property") ?? extractAttribute(tag, "name");
        if (property?.toLowerCase() === key.toLowerCase()) {
            return extractAttribute(tag, "content");
        }
    }
    return undefined;
}

function extractTitle(html: string): string | undefined {
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    return title ? stripTags(title) : undefined;
}

function extractCanonicalLink(html: string): string | undefined {
    const tags = html.match(/<link\b[^>]*>/gi) ?? [];
    for (const tag of tags) {
        const rel = extractAttribute(tag, "rel")
            ?.toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
        if (rel?.includes("canonical")) {
            return extractAttribute(tag, "href");
        }
    }
    return undefined;
}

function normalizeFractionText(value: string): string {
    let result = value;
    for (const [character, fraction] of Object.entries(UNICODE_FRACTIONS)) {
        result = result.replace(
            new RegExp(`(\\d)${character}`, "g"),
            `$1 ${fraction}`,
        );
        result = result.replaceAll(character, fraction);
    }
    return result
        .replace(/[‐‑‒–—]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
}

function fractionValue(value: string): number | undefined {
    const normalized = value.trim();
    if (!normalized) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
    if (/^\d+\/\d+$/.test(normalized)) {
        const [numerator, denominator] = normalized.split("/").map(Number);
        if (denominator && numerator !== undefined)
            return numerator / denominator;
    }
    const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(normalized);
    if (mixed) {
        const whole = Number(mixed[1]);
        const numerator = Number(mixed[2]);
        const denominator = Number(mixed[3]);
        if (denominator) return whole + numerator / denominator;
    }
    return undefined;
}

function parseQuantityPrefix(value: string): {
    quantity?: number;
    remainder: string;
    range: boolean;
} {
    const normalized = normalizeFractionText(value);
    const range = /^(\S+)\s*-\s*(\S+)\s+/.exec(normalized);
    if (range) {
        const first = fractionValue(range[1]!);
        const second = fractionValue(range[2]!);
        if (first !== undefined && second !== undefined) {
            return {
                quantity: (first + second) / 2,
                remainder: normalized.slice(range[0].length).trim(),
                range: true,
            };
        }
    }
    const prefix = /^((?:(?:\d+(?:\.\d+)?)\s+)?\d+\/\d+|\d+(?:\.\d+)?)\s*/.exec(
        normalized,
    );
    if (!prefix) return { remainder: normalized, range: false };
    return {
        quantity: fractionValue(prefix[1]!),
        remainder: normalized.slice(prefix[0].length).trim(),
        range: false,
    };
}

function normalizeUnit(value: string): string {
    const aliases: Record<string, string> = {
        cups: "cup",
        cloves: "clove",
        grams: "g",
        gram: "g",
        heads: "head",
        kilograms: "kg",
        kilogram: "kg",
        liters: "l",
        litres: "l",
        milliliters: "ml",
        millilitres: "ml",
        ounces: "oz",
        ounce: "oz",
        pounds: "lb",
        pound: "lb",
        slices: "slice",
        slice: "slice",
        pieces: "piece",
        piece: "piece",
        sprigs: "sprig",
        sprig: "sprig",
        stalks: "stalk",
        stalk: "stalk",
        tablespoons: "tbsp",
        tablespoon: "tbsp",
        teaspoons: "tsp",
        teaspoon: "tsp",
        servings: "serving",
    };
    return aliases[value.toLowerCase()] ?? value.toLowerCase();
}

export function parseIngredientText(rawValue: string): {
    ingredient: ParsedRecipeIngredient;
    warnings: RecipeImportWarning[];
} {
    const rawText = stripTags(rawValue).slice(0, 1_000);
    const warnings: RecipeImportWarning[] = [];
    const optional = /\boptional\b/i.test(rawText);
    const withoutOptional = rawText
        .replace(/\(\s*optional\s*\)/gi, "")
        .replace(/\boptional\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    const parsed = parseQuantityPrefix(withoutOptional);
    let remainder = parsed.remainder;
    let unit: string | undefined;
    const unitMatch = /^([a-zA-Z]+)\b/.exec(remainder);
    if (unitMatch && COMMON_UNITS.has(unitMatch[1]!.toLowerCase())) {
        unit = normalizeUnit(unitMatch[1]!);
        remainder = remainder.slice(unitMatch[0].length).trim();
    }
    if (parsed.range) {
        warnings.push(
            warning(
                "quantity_range",
                `The source listed a quantity range; using the midpoint ${parsed.quantity}.`,
            ),
        );
    }
    if (parsed.quantity === undefined && !/\bto taste\b/i.test(rawText)) {
        warnings.push(
            warning(
                "quantity_unparsed",
                "The ingredient quantity could not be parsed and needs review.",
            ),
        );
    }
    const name = remainder.replace(/^[-:]+|[-:]+$/g, "").trim() || rawText;
    return {
        ingredient: {
            rawText,
            name,
            quantity: parsed.quantity,
            unit,
            optional: optional || undefined,
        },
        warnings,
    };
}

function parseDuration(value: unknown): number | undefined {
    const text = firstString(value);
    if (!text) return undefined;
    const iso = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?/i.exec(text);
    if (iso && (iso[1] || iso[2])) {
        return Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0);
    }
    const hours = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i.exec(text);
    const minutes = /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)/i.exec(text);
    if (!hours && !minutes) return undefined;
    return Math.round(Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0));
}

function parseServings(value: unknown): {
    servings: number;
    warning?: RecipeImportWarning;
} {
    const text = firstString(value);
    const match = text?.match(/\d+(?:\.\d+)?/);
    if (match) {
        const servings = Number(match[0]);
        return {
            servings,
            ...(text && !/^\s*\d+(?:\.\d+)?\s*$/.test(text)
                ? {
                      warning: warning(
                          "yield_interpreted",
                          `The source yield “${text.slice(0, 120)}” was interpreted as ${servings} servings.`,
                          "servings",
                      ),
                  }
                : {}),
        };
    }
    return {
        servings: 1,
        warning: warning(
            "yield_missing",
            "The source did not provide a numeric yield; review the serving count.",
            "servings",
        ),
    };
}

function instructionStrings(value: unknown): string[] {
    const values: string[] = [];
    const visit = (item: unknown) => {
        if (typeof item === "string") {
            values.push(...item.split(/\r?\n/).map(stripTags).filter(Boolean));
            return;
        }
        if (Array.isArray(item)) {
            item.forEach(visit);
            return;
        }
        if (item && typeof item === "object") {
            const record = item as Record<string, unknown>;
            if (record.itemListElement !== undefined)
                visit(record.itemListElement);
            else if (record.text !== undefined) visit(record.text);
            else if (record.name !== undefined) visit(record.name);
        }
    };
    visit(value);
    return [...new Set(values)].slice(0, 100);
}

function recipeType(value: unknown): boolean {
    const types = Array.isArray(value) ? value : [value];
    return types.some((type) => {
        const normalized = String(type).toLowerCase();
        return (
            normalized === "recipe" ||
            normalized.endsWith("/recipe") ||
            normalized.endsWith("#recipe")
        );
    });
}

function collectRecipeObjects(
    value: unknown,
    result: Record<string, unknown>[],
): void {
    if (Array.isArray(value)) {
        value.forEach((item) => collectRecipeObjects(item, result));
        return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (recipeType(record["@type"] ?? record.type)) result.push(record);
    for (const [key, child] of Object.entries(record)) {
        if (key === "@type" || key === "type") continue;
        if (child && typeof child === "object")
            collectRecipeObjects(child, result);
    }
}

function jsonLdBlocks(html: string): unknown[] {
    const blocks = html.matchAll(
        /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    );
    const parsed: unknown[] = [];
    for (const block of blocks) {
        const raw = block[1]?.trim();
        if (!raw) continue;
        try {
            parsed.push(JSON.parse(raw));
        } catch {
            // A malformed block should not prevent microdata fallback.
        }
    }
    return parsed;
}

function parsedFromObject(
    recipe: Record<string, unknown>,
    html: string,
    strategy: ParsedRecipe["strategy"],
): ParsedRecipe {
    const warnings: RecipeImportWarning[] = [];
    const name =
        firstString(recipe.name) ??
        extractMeta(html, "og:title") ??
        extractTitle(html);
    if (!name) {
        throw new Error("The recipe page did not provide a recipe name.");
    }
    const ingredients = Array.isArray(recipe.recipeIngredient)
        ? recipe.recipeIngredient
              .map((value) => firstString(value))
              .filter((value): value is string => Boolean(value))
              .map((value) => parseIngredientText(value))
        : [];
    if (ingredients.length === 0) {
        throw new Error("The recipe page did not provide ingredients.");
    }
    for (const parsedIngredient of ingredients)
        warnings.push(...parsedIngredient.warnings);
    const yieldResult = parseServings(recipe.recipeYield);
    if (yieldResult.warning) warnings.push(yieldResult.warning);
    const instructions = instructionStrings(recipe.recipeInstructions);
    if (instructions.length === 0) {
        warnings.push(
            warning(
                "instructions_missing",
                "The source did not provide structured instructions; add them before saving.",
                "instructions",
            ),
        );
    }
    const canonicalUrl =
        firstString(recipe.url) ??
        extractCanonicalLink(html) ??
        extractMeta(html, "og:url");
    const author = firstString(recipe.author);
    const publisher = firstString(recipe.publisher);
    return {
        strategy,
        name: name.slice(0, 200),
        description: firstString(recipe.description)?.slice(0, 2_000),
        servings: yieldResult.servings,
        instructions,
        preparationMinutes: parseDuration(recipe.prepTime),
        cookingMinutes: parseDuration(recipe.cookTime),
        sourceTitle: name.slice(0, 500),
        siteName: publisher,
        author,
        canonicalUrl,
        ingredients: ingredients.map((value) => value.ingredient),
        warnings,
    };
}

function parseJsonLd(html: string): ParsedRecipe | null {
    const recipes: Record<string, unknown>[] = [];
    for (const block of jsonLdBlocks(html))
        collectRecipeObjects(block, recipes);
    if (recipes.length === 0) return null;
    const parsed = parsedFromObject(recipes[0]!, html, "schema_org_json_ld");
    if (recipes.length > 1) {
        parsed.warnings.push(
            warning(
                "multiple_recipes",
                "The page contains multiple structured recipes; the first recipe was selected for review.",
            ),
        );
    }
    return parsed;
}

function itemPropValues(html: string, property: string): string[] {
    const values: string[] = [];
    const pattern = new RegExp(
        `<([a-z0-9]+)\\b[^>]*\\bitemprop=["']${property}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
        "gi",
    );
    for (const match of html.matchAll(pattern)) {
        const tag = match[0] ?? "";
        const content = extractAttribute(tag, "content") ?? match[2];
        if (content) values.push(stripTags(content));
    }
    const selfClosing = new RegExp(
        `<([a-z0-9]+)\\b[^>]*\\bitemprop=["']${property}["'][^>]*\\/?>(?![\\s\\S]*<\\/\\1>)`,
        "gi",
    );
    for (const match of html.matchAll(selfClosing)) {
        const content = extractAttribute(match[0] ?? "", "content");
        if (content) values.push(content);
    }
    return values.filter(Boolean);
}

function parseMicrodata(html: string): ParsedRecipe | null {
    if (!/itemtype=["'][^"']*schema\.org\/Recipe/i.test(html)) return null;
    const ingredients = itemPropValues(html, "recipeIngredient");
    if (ingredients.length === 0) return null;
    const recipe: Record<string, unknown> = {
        name:
            itemPropValues(html, "name")[0] ??
            extractMeta(html, "og:title") ??
            extractTitle(html),
        description: extractMeta(html, "description"),
        recipeIngredient: ingredients,
        recipeInstructions: itemPropValues(html, "recipeInstructions"),
        recipeYield: itemPropValues(html, "recipeYield")[0],
        prepTime: itemPropValues(html, "prepTime")[0],
        cookTime: itemPropValues(html, "cookTime")[0],
        url: extractMeta(html, "og:url"),
        author: itemPropValues(html, "author")[0],
        publisher: itemPropValues(html, "publisher")[0],
    };
    return parsedFromObject(recipe, html, "microdata");
}

export function parseRecipeHtml(html: string): ParsedRecipe {
    const parsed = parseJsonLd(html) ?? parseMicrodata(html);
    if (!parsed) {
        throw new Error(
            "No supported structured recipe data was found on the page.",
        );
    }
    return parsed;
}
