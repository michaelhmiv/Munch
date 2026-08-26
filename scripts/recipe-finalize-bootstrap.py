from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        if new in text:
            return
        raise SystemExit(f"replacement marker not found in {path}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


# Public parser strategy contract.
types = Path("src/recipe-import/types.ts")
text = types.read_text()
text = text.replace(
    'strategy: z.enum(["schema_org_json_ld", "microdata"]),',
    'strategy: z.enum([\n            "schema_org_json_ld",\n            "microdata",\n            "recipe_card_html",\n        ]),',
)
text = text.replace(
    'strategy: "schema_org_json_ld" | "microdata";',
    'strategy: "schema_org_json_ld" | "microdata" | "recipe_card_html";',
)
types.write_text(text)

# Parser implementation: keep JSON-LD and microdata first, then common recipe-card DOM.
parser = Path("src/recipe-import/parser.ts")
text = parser.read_text()
if 'import { load } from "cheerio";' not in text:
    text = text.replace('import type {\n', 'import { load } from "cheerio";\nimport type {\n', 1)
text = text.replace(
    'export const RECIPE_IMPORT_PARSER_VERSION = "1.0.0";',
    'export const RECIPE_IMPORT_PARSER_VERSION = "1.1.0";',
    1,
)
old_tail = '''export function parseRecipeHtml(html: string): ParsedRecipe {
    const parsed = parseJsonLd(html) ?? parseMicrodata(html);
    if (!parsed) {
        throw new Error(
            "No supported structured recipe data was found on the page.",
        );
    }
    return parsed;
}
'''
new_tail = r'''function parseRecipeCardHtml(html: string): ParsedRecipe | null {
    const $ = load(html);
    const root = $(".wprm-recipe-container, .tasty-recipes").first();
    if (root.length === 0) return null;

    const clean = (value: string): string | undefined => {
        const normalized = decodeHtml(value).replace(/\s+/g, " ").trim();
        return normalized || undefined;
    };
    const firstText = (selector: string): string | undefined =>
        clean(root.find(selector).first().text());
    const wprm = root.hasClass("wprm-recipe-container");

    const name = firstText(
        wprm
            ? ".wprm-recipe-name"
            : ".tasty-recipes-title, [itemprop='name']",
    );
    if (!name) return null;

    const ingredientNodes = wprm
        ? root.find(".wprm-recipe-ingredient")
        : root.find(".tasty-recipes-ingredients li");
    const ingredients = ingredientNodes
        .toArray()
        .map((node) => {
            const item = $(node);
            let rawText: string | undefined;
            if (wprm) {
                const amount = clean(
                    item.find(".wprm-recipe-ingredient-amount").first().text(),
                );
                const unit = clean(
                    item.find(".wprm-recipe-ingredient-unit").first().text(),
                );
                const ingredientName = clean(
                    item.find(".wprm-recipe-ingredient-name").first().text(),
                );
                const notes = clean(
                    item.find(".wprm-recipe-ingredient-notes").first().text(),
                );
                const base = [amount, unit, ingredientName]
                    .filter(Boolean)
                    .join(" ");
                rawText = clean(notes ? `${base}, ${notes}` : base);
            }
            rawText ??= clean(item.text());
            return rawText ? parseIngredientText(rawText) : null;
        })
        .filter(
            (
                value,
            ): value is ReturnType<typeof parseIngredientText> => Boolean(value),
        )
        .slice(0, 200);
    if (ingredients.length === 0) return null;

    const warnings: RecipeImportWarning[] = [];
    for (const ingredient of ingredients) warnings.push(...ingredient.warnings);

    const yieldText = firstText(
        wprm
            ? ".wprm-recipe-servings-container, .wprm-recipe-servings"
            : ".tasty-recipes-yield",
    );
    const yieldResult = parseServings(yieldText);
    if (yieldResult.warning) warnings.push(yieldResult.warning);

    const instructionNodes = wprm
        ? root.find(".wprm-recipe-instruction-text")
        : root.find(".tasty-recipes-instructions li");
    const instructions = instructionNodes
        .toArray()
        .map((node) => clean($(node).text()))
        .filter((value): value is string => Boolean(value))
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, 100);
    if (instructions.length === 0) {
        warnings.push(
            warning(
                "instructions_missing",
                "The source recipe card did not provide instructions; add them before saving.",
                "instructions",
            ),
        );
    }

    const prepText = firstText(
        wprm
            ? ".wprm-recipe-prep-time-container"
            : ".tasty-recipes-prep-time",
    );
    const cookText = firstText(
        wprm
            ? ".wprm-recipe-cook-time-container"
            : ".tasty-recipes-cook-time",
    );

    return {
        strategy: "recipe_card_html",
        name: name.slice(0, 200),
        description: firstText(
            wprm ? ".wprm-recipe-summary" : ".tasty-recipes-description",
        )?.slice(0, 2_000),
        servings: yieldResult.servings,
        instructions,
        preparationMinutes: parseDuration(prepText),
        cookingMinutes: parseDuration(cookText),
        sourceTitle: name.slice(0, 500),
        siteName: extractMeta(html, "og:site_name"),
        author: firstText(
            wprm
                ? ".wprm-recipe-author"
                : ".tasty-recipes-author-name, [itemprop='author']",
        ),
        canonicalUrl:
            extractCanonicalLink(html) ?? extractMeta(html, "og:url"),
        ingredients: ingredients.map((value) => value.ingredient),
        warnings,
    };
}

export function parseRecipeHtml(html: string): ParsedRecipe {
    const parsed =
        parseJsonLd(html) ??
        parseMicrodata(html) ??
        parseRecipeCardHtml(html);
    if (!parsed) {
        throw new Error(
            "No supported structured recipe data was found on the page.",
        );
    }
    return parsed;
}
'''
if old_tail in text:
    text = text.replace(old_tail, new_tail, 1)
elif 'function parseRecipeCardHtml(html: string): ParsedRecipe | null' not in text:
    raise SystemExit("parseRecipeHtml tail marker not found")
parser.write_text(text)

# Parser unit coverage for both supported recipe-card families.
tests = Path("src/recipe-import.test.ts")
text = tests.read_text()
marker = '    test("preserves raw text and warns when a quantity is not measurable", () => {\n'
insertion = r'''    test("falls back to WP Recipe Maker cards while preserving source facts", () => {
        const parsed = parseRecipeHtml(`
            <html><head>
              <meta property="og:site_name" content="Example Kitchen" />
              <link rel="canonical" href="https://example.com/lemon-pasta" />
            </head><body>
              <div class="wprm-recipe-container">
                <h2 class="wprm-recipe-name">Lemon Pasta</h2>
                <div class="wprm-recipe-summary">A bright weeknight pasta.</div>
                <div class="wprm-recipe-servings-container">Serves <span class="wprm-recipe-servings">2</span></div>
                <div class="wprm-recipe-prep-time-container">Prep Time 5 minutes</div>
                <div class="wprm-recipe-cook-time-container">Cook Time 15 minutes</div>
                <ul>
                  <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">8</span> <span class="wprm-recipe-ingredient-unit">ounces</span> <span class="wprm-recipe-ingredient-name">spaghetti</span></li>
                  <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-amount">⅓</span> <span class="wprm-recipe-ingredient-unit">cup</span> <span class="wprm-recipe-ingredient-name">Parmesan cheese</span>, <span class="wprm-recipe-ingredient-notes">grated</span></li>
                  <li class="wprm-recipe-ingredient"><span class="wprm-recipe-ingredient-name">Sea salt and black pepper to taste</span></li>
                </ul>
                <ol>
                  <li class="wprm-recipe-instruction"><div class="wprm-recipe-instruction-text">Cook the pasta until al dente.</div></li>
                  <li class="wprm-recipe-instruction"><div class="wprm-recipe-instruction-text">Toss with the sauce and serve.</div></li>
                </ol>
              </div>
            </body></html>
        `);
        expect(parsed.strategy).toBe("recipe_card_html");
        expect(parsed.name).toBe("Lemon Pasta");
        expect(parsed.servings).toBe(2);
        expect(parsed.preparationMinutes).toBe(5);
        expect(parsed.cookingMinutes).toBe(15);
        expect(parsed.ingredients).toHaveLength(3);
        expect(parsed.ingredients[0]).toMatchObject({
            rawText: "8 ounces spaghetti",
            name: "spaghetti",
            quantity: 8,
            unit: "oz",
        });
        expect(parsed.ingredients[1]).toMatchObject({
            rawText: "⅓ cup Parmesan cheese, grated",
            quantity: 1 / 3,
            unit: "cup",
        });
        expect(parsed.ingredients[2]?.quantity).toBeUndefined();
        expect(parsed.instructions).toEqual([
            "Cook the pasta until al dente.",
            "Toss with the sauce and serve.",
        ]);
        expect(parsed.canonicalUrl).toBe("https://example.com/lemon-pasta");
    });

    test("falls back to Tasty Recipes card markup", () => {
        const parsed = parseRecipeHtml(`
            <div class="tasty-recipes">
              <h2 class="tasty-recipes-title">Simple Toast</h2>
              <div class="tasty-recipes-yield">Yield: 1 serving</div>
              <div class="tasty-recipes-ingredients"><ul><li>2 slices bread</li></ul></div>
              <div class="tasty-recipes-instructions"><ol><li>Toast the bread.</li></ol></div>
            </div>
        `);
        expect(parsed.strategy).toBe("recipe_card_html");
        expect(parsed.ingredients[0]).toMatchObject({
            name: "bread",
            quantity: 2,
            unit: "slice",
        });
        expect(parsed.instructions).toEqual(["Toast the bread."]);
    });

'''
if 'falls back to WP Recipe Maker cards while preserving source facts' not in text:
    if marker not in text:
        raise SystemExit("recipe-import test insertion marker not found")
    text = text.replace(marker, insertion + marker, 1)
tests.write_text(text)

# Add the end-to-end parse -> save -> read -> log smoke to DB CI.
ci = Path(".github/workflows/ci.yml")
text = ci.read_text()
marker = '''      - name: Exercise recipes, planning, groceries, idempotency, and RLS
        run: bun scripts/recipe-planning-smoke.ts
'''
insertion = marker + '''      - name: Exercise parsed recipe save, read-back, and meal logging
        run: bun scripts/recipe-import-save-roundtrip-smoke.ts
'''
if 'Exercise parsed recipe save, read-back, and meal logging' not in text:
    if marker not in text:
        raise SystemExit("CI insertion marker not found")
    text = text.replace(marker, insertion, 1)
ci.write_text(text)

# Keep the live corpus representative of the exact parser gap that motivated this work.
corpus = Path("src/recipe-import/fixtures/recipe-corpus.ts")
text = corpus.read_text()
marker = '''    {
        id: "food-network-gorgonzola-pasta",
'''
love = '''    {
        id: "love-and-lemons-lemon-pasta",
        site: "Love & Lemons",
        url: "https://www.loveandlemons.com/lemon-pasta/",
        variety: "lemon pasta",
        patterns: [
            "recipe-card HTML fallback",
            "quantity-less seasoning",
            "fraction quantities",
        ],
    },
'''
if 'id: "love-and-lemons-lemon-pasta"' not in text:
    if marker not in text:
        raise SystemExit("corpus insertion marker not found")
    text = text.replace(marker, love + marker, 1)
corpus.write_text(text)

workflow = Path(".github/workflows/recipe-import-corpus-smoke.yml")
text = workflow.read_text().replace('default: "20"', 'default: "21"', 1)
workflow.write_text(text)
