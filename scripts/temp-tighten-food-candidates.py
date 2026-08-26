from pathlib import Path

path = Path("src/food-providers/catalog-repository.ts")
text = path.read_text()
old = "const retrievalLimit = Math.min(50, Math.max(25, boundedLimit * 5));"
new = "const retrievalLimit = Math.min(40, Math.max(25, boundedLimit * 4));"
if old not in text:
    raise SystemExit("retrieval limit anchor changed")
path.write_text(text.replace(old, new, 1))

for filename in ["src/food-providers/ranking.ts", "scripts/food-catalog-common-corpus.ts"]:
    path = Path(filename)
    text = path.read_text()
    anchor = '    "chili",\n]);'
    replacement = '    "chili",\n    "muffin",\n    "meatball",\n    "dinner",\n    "meal",\n    "vegetable",\n]);'
    if anchor not in text:
        raise SystemExit(f"prepared form anchor changed in {filename}")
    path.write_text(text.replace(anchor, replacement, 1))

path = Path("src/food-providers/ranking.test.ts")
text = path.read_text()
if 'demotes remaining prepared forms from the real corpus' not in text:
    insert = '''
    test("demotes remaining prepared forms from the real corpus", () => {
        expect(
            top("zucchini", [
                food("Muffin, zucchini", { raw: { dataset: "survey" } }),
                food("Zucchini, raw"),
            ]),
        ).toBe("Zucchini, raw");
        expect(
            top("spaghetti", [
                food("Spaghetti and meatballs dinner, NFS, frozen meal", {
                    raw: { dataset: "survey" },
                }),
                food("Spaghetti, cooked"),
            ]),
        ).toBe("Spaghetti, cooked");
        expect(
            top("macaroni", [
                food("Macaroni, vegetable, enriched, cooked"),
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
