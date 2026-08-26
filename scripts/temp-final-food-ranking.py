from pathlib import Path

for filename in ["src/food-providers/ranking.ts", "scripts/food-catalog-common-corpus.ts"]:
    path = Path(filename)
    text = path.read_text()
    anchor = '    "chinese",\n]);'
    replacement = '    "chinese",\n    "canadian",\n    "squash",\n    "chili",\n]);'
    if anchor not in text:
        raise SystemExit(f"form token anchor changed in {filename}")
    path.write_text(text.replace(anchor, replacement, 1))

path = Path("src/food-providers/ranking.test.ts")
text = path.read_text()
if 'demotes subtype and dish names for generic food queries' not in text:
    insert = '''
    test("demotes subtype and dish names for generic food queries", () => {
        expect(
            top("bacon", [
                food("Canadian bacon, unprepared"),
                food("Bacon"),
            ]),
        ).toBe("Bacon");
        expect(
            top("spaghetti", [
                food("Spaghetti squash, cooked"),
                food("Spaghetti, cooked"),
            ]),
        ).toBe("Spaghetti, cooked");
        expect(
            top("macaroni", [
                food("Chili with macaroni", { raw: { dataset: "survey" } }),
                food("Macaroni, cooked"),
            ]),
        ).toBe("Macaroni, cooked");
    });
'''
    pos = text.rfind("\n});")
    if pos < 0:
        raise SystemExit("ranking test suite anchor changed")
    text = text[:pos] + insert + text[pos:]
path.write_text(text)
