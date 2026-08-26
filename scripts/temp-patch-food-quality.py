from pathlib import Path
import re

# Replace OR singular/plural FTS with one prefix tsquery over the final noun.
path = Path("src/food-providers/catalog-repository.ts")
text = path.read_text()
pattern = re.compile(
    r"export function lexicalFoodSearchVariants\(value: string\): string\[] \{.*?\n\}\n\nexport function hashCatalogIdentity",
    re.S,
)
helper = '''export function lexicalFoodSearchTsquery(value: string): string {
    const normalized = normalizeFoodText(value);
    if (!normalized) return "";
    const tokens = normalized.split(" ").filter(Boolean);
    const lastIndex = tokens.length - 1;
    const last = tokens[lastIndex];
    if (!last) return "";

    let stem = last;
    if (last.length > 4 && last.endsWith("ies")) {
        stem = `${last.slice(0, -3)}y`;
    } else if (last.length > 4 && last.endsWith("oes")) {
        stem = last.slice(0, -2);
    } else if (
        last.length > 3 &&
        last.endsWith("s") &&
        !last.endsWith("ss") &&
        !last.endsWith("us")
    ) {
        stem = last.slice(0, -1);
    }

    tokens[lastIndex] = `${stem}:*`;
    return tokens.join(" & ");
}

export function hashCatalogIdentity'''
text, count = pattern.subn(helper, text, count=1)
if count != 1:
    raise SystemExit("lexical helper anchor changed")
text = text.replace(
    "        const lexicalVariants = lexicalFoodSearchVariants(normalized);\n        const alternate = lexicalVariants[1] ?? normalized;",
    "        const lexicalTsquery = lexicalFoodSearchTsquery(normalized);",
    1,
)
text = text.replace(
    ") @@ (\n                    plainto_tsquery('simple', ${normalized})\n                    || plainto_tsquery('simple', ${alternate})\n                  )",
    ") @@ to_tsquery('simple', ${lexicalTsquery})",
    1,
)
text = text.replace(
    "plainto_tsquery('simple', ${normalized})",
    "to_tsquery('simple', ${lexicalTsquery})",
    1,
)
if "lexicalFoodSearchVariants" in text or "${alternate}" in text:
    raise SystemExit("lexical variant cleanup incomplete")
path.write_text(text)

# Update helper tests.
path = Path("src/food-providers/catalog-repository.test.ts")
text = path.read_text()
text = text.replace("lexicalFoodSearchVariants,", "lexicalFoodSearchTsquery,")
old = re.compile(
    r'    test\("creates conservative final-noun lexical variants".*?\n    \}\);',
    re.S,
)
new = '''    test("creates indexed final-noun prefix queries", () => {
        expect(lexicalFoodSearchTsquery("onion")).toBe("onion:*");
        expect(lexicalFoodSearchTsquery("pistachios")).toBe("pistachio:*");
        expect(lexicalFoodSearchTsquery("sweet potato")).toBe(
            "sweet & potato:*",
        );
        expect(lexicalFoodSearchTsquery("2% milk")).toBe("2 & milk:*");
    });'''
text, count = old.subn(new, text, count=1)
if count != 1:
    raise SystemExit("catalog lexical test anchor changed")
path.write_text(text)

# Wait for deliberately asynchronous access metadata batches in the DB smoke.
path = Path("scripts/food-catalog-ingestion-smoke.ts")
text = path.read_text()
start = text.find(
    "    const accessed = await database<Array<{ access_count: number | string }>>`"
)
end = text.find("    );\n} finally {", start)
if start < 0 or end < 0:
    raise SystemExit("access metadata smoke anchor changed")
replacement = '''    let accessCount = 0;
    const accessDeadline = Date.now() + 1_500;
    while (Date.now() < accessDeadline) {
        const accessed = await database<
            Array<{ access_count: number | string }>
        >`
            select access_count
            from munch.food_catalog_entries
            where provider = 'usda' and provider_food_id = '321358'
        `;
        accessCount = Number(accessed[0]?.access_count ?? 0);
        if (accessCount >= 1) break;
        await Bun.sleep(25);
    }
    if (accessCount < 1) {
        throw new Error(
            "Query-cache hits did not asynchronously update access counters",
        );
    }

    console.log(
        `[food_catalog_smoke] imported=${first.accepted} idempotent_rows=${rows.length} local_hits=${local.length} query_cache_hits=${cached.length} stale_exposed=true access_count=${accessCount}`,
'''
text = text[:start] + replacement + text[end:]
path.write_text(text)

# Harden corpus scoring with singular-aware coverage and prepared-form checks.
path = Path("scripts/food-catalog-common-corpus.ts")
text = path.read_text()
old_tokens = '''function tokens(value: string): string[] {
    return normalizeFoodText(value)
        .split(" ")
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}'''
new_tokens = '''function canonicalToken(token: string): string {
    if (token.length > 4 && token.endsWith("ies")) {
        return `${token.slice(0, -3)}y`;
    }
    if (token.length > 4 && token.endsWith("oes")) {
        return token.slice(0, -2);
    }
    if (
        token.length > 3 &&
        token.endsWith("s") &&
        !token.endsWith("ss") &&
        !token.endsWith("us")
    ) {
        return token.slice(0, -1);
    }
    return token;
}

function tokens(value: string): string[] {
    return normalizeFoodText(value)
        .split(" ")
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
        .map(canonicalToken);
}'''
if old_tokens not in text:
    raise SystemExit("corpus token anchor changed")
text = text.replace(old_tokens, new_tokens, 1)
marker = "function percentile(values: number[], fraction: number): number {"
strict = '''const PLAIN_INGREDIENT_FORM_TOKENS = new Set([
    "bun",
    "sauce",
    "stick",
    "pickled",
    "breaded",
    "reheated",
    "prepackaged",
    "honey",
    "roasted",
    "dried",
    "yolk",
    "white",
    "pita",
    "spaghetti",
    "macaroni",
    "vegetable",
    "raab",
    "light",
    "cream",
    "beef",
    "salad",
    "sandwich",
    "pie",
    "chip",
    "cookie",
    "cracker",
    "soup",
    "cake",
    "cereal",
    "pizza",
    "casserole",
    "dip",
    "dressing",
    "powder",
    "flour",
    "yogurt",
    "custard",
    "pancake",
    "bagel",
    "gravy",
]);

function plainIngredientFormQuality(query: string, name: string): boolean {
    const queryTokens = new Set(tokens(query));
    const nameTokens = new Set(tokens(name));
    for (const token of PLAIN_INGREDIENT_FORM_TOKENS) {
        if (!queryTokens.has(token) && nameTokens.has(token)) return false;
    }
    return true;
}

'''
if marker not in text:
    raise SystemExit("corpus strict quality insertion anchor changed")
text = text.replace(marker, strict + marker, 1)
text = text.replace(
    "quality: Boolean(top && coverage >= 0.5),",
    "quality: Boolean(\n            top &&\n                coverage >= 0.5 &&\n                plainIngredientFormQuality(query, top.name)\n        ),",
    1,
)
text = text.replace("if (report.quality_rate < 0.85) {", "if (report.quality_rate < 0.98) {", 1)
text = text.replace("is below the 85% gate", "is below the 98% gate", 1)
path.write_text(text)

# Add focused ranking regressions for the real corpus failures.
path = Path("src/food-providers/ranking.test.ts")
text = path.read_text()
if "demotes prepared forms for plain ingredient queries" not in text:
    insert = '''
    test("demotes prepared forms for plain ingredient queries", () => {
        expect(
            top("cinnamon", [
                food("Cinnamon buns, frosted", { raw: { dataset: "survey" } }),
                food("Spices, cinnamon, ground"),
            ]),
        ).toBe("Spices, cinnamon, ground");
        expect(
            top("egg", [
                food("Egg, yolk, dried"),
                food("Egg, whole, raw, fresh"),
            ]),
        ).toBe("Egg, whole, raw, fresh");
        expect(
            top("tuna", [
                food("Tuna with cream or white sauce", { raw: { dataset: "survey" } }),
                food("Fish, tuna, light, raw"),
            ]),
        ).toBe("Fish, tuna, light, raw");
        expect(
            top("walnuts", [
                food("Walnuts, honey roasted", { raw: { dataset: "survey" } }),
                food("Walnuts, raw"),
            ]),
        ).toBe("Walnuts, raw");
        expect(
            top("cooked broccoli", [
                food("Broccoli raab, cooked"),
                food("Broccoli, cooked"),
            ]),
        ).toBe("Broccoli, cooked");
    });
'''
    pos = text.rfind("\n});")
    if pos < 0:
        raise SystemExit("ranking test suite anchor changed")
    text = text[:pos] + insert + text[pos:]
path.write_text(text)
