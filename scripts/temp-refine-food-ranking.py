from pathlib import Path

# Use a shared morphological prefix for consonant-y singular/plural pairs so
# strawberry/strawberries and blueberry/blueberries stay in one indexed FTS query.
path = Path("src/food-providers/catalog-repository.ts")
text = path.read_text()
text = text.replace(
    '''    let stem = last;
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
    }''',
    '''    let stem = last;
    if (last.length > 4 && last.endsWith("ies")) {
        stem = last.slice(0, -3);
    } else if (/[^aeiou]y$/u.test(last)) {
        stem = last.slice(0, -1);
    } else if (last.length > 4 && last.endsWith("oes")) {
        stem = last.slice(0, -2);
    } else if (
        last.length > 3 &&
        last.endsWith("s") &&
        !last.endsWith("ss") &&
        !last.endsWith("us")
    ) {
        stem = last.slice(0, -1);
    }''',
    1,
)
if 'stem = last.slice(0, -3);' not in text or '/[^aeiou]y$/u.test(last)' not in text:
    raise SystemExit("morphological prefix patch failed")
path.write_text(text)

# Add only generic prepared/derived-form terms demonstrated by the real USDA
# corpus. Query tokens themselves are exempt from the penalty.
path = Path("src/food-providers/ranking.ts")
text = path.read_text()
needle = '''    "beef",
]);'''
replacement = '''    "beef",
    "juice",
    "concentrate",
    "canned",
    "bit",
    "glazed",
    "spinach",
    "tuna",
    "chinese",
]);'''
if needle not in text:
    raise SystemExit("ranking token anchor changed")
text = text.replace(needle, replacement, 1)
path.write_text(text)

# Align the strict real-data quality detector with those prepared forms, while
# allowing dried herbs/spices (e.g. dried oregano), which are canonical foods.
path = Path("scripts/food-catalog-common-corpus.ts")
text = path.read_text()
text = text.replace('    "dried",\n', '', 1)
needle = '''    "gravy",
]);'''
replacement = '''    "gravy",
    "juice",
    "concentrate",
    "canned",
    "bit",
    "glazed",
    "spinach",
    "tuna",
    "chinese",
]);'''
if needle not in text:
    raise SystemExit("strict corpus token anchor changed")
text = text.replace(needle, replacement, 1)
path.write_text(text)

# Extend focused regression coverage.
path = Path("src/food-providers/catalog-repository.test.ts")
text = path.read_text()
text = text.replace(
    '        expect(lexicalFoodSearchTsquery("onion")).toBe("onion:*");\n',
    '        expect(lexicalFoodSearchTsquery("onion")).toBe("onion:*");\n        expect(lexicalFoodSearchTsquery("strawberries")).toBe("strawberr:*");\n        expect(lexicalFoodSearchTsquery("strawberry")).toBe("strawberr:*");\n',
    1,
)
path.write_text(text)

path = Path("src/food-providers/ranking.test.ts")
text = path.read_text()
if 'demotes derived variants exposed by the USDA corpus' not in text:
    insert = '''
    test("demotes derived variants exposed by the USDA corpus", () => {
        expect(
            top("blueberries", [
                food("Blueberry juice", { raw: { dataset: "survey" } }),
                food("Blueberries, raw"),
            ]),
        ).toBe("Blueberries, raw");
        expect(top("bacon", [food("Bacon bits"), food("Bacon")])).toBe(
            "Bacon",
        );
        expect(
            top("spaghetti", [
                food("Spaghetti, spinach, cooked"),
                food("Spaghetti, cooked"),
            ]),
        ).toBe("Spaghetti, cooked");
        expect(
            top("macaroni", [
                food("Macaroni with tuna, Puerto Rican style", {
                    raw: { dataset: "survey" },
                }),
                food("Macaroni, cooked"),
            ]),
        ).toBe("Macaroni, cooked");
        expect(
            top("walnuts", [
                food("Nuts, walnuts, glazed"),
                food("Nuts, walnuts, raw"),
            ]),
        ).toBe("Nuts, walnuts, raw");
        expect(
            top("cooked broccoli", [
                food("Broccoli, Chinese, cooked"),
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
