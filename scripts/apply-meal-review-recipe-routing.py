#!/usr/bin/env python3
from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/mcp-latency.ts",
    '    "save_recipe",\n    "get_meal_plan",',
    '    "save_recipe",\n    "save_meal_as_recipe",\n    "get_meal_plan",',
    "direct meal-to-recipe tool",
)
replace_once(
    "src/mcp-latency.ts",
    '    save_recipe:\n        "Save a fully established structured recipe. Do not invent ingredients, quantities, servings, or source facts.",',
    '    save_recipe:\n        "Save a fully established new structured recipe. Do not invent ingredients, quantities, servings, or source facts; use save_meal_as_recipe instead when converting a known logged meal.",\n    save_meal_as_recipe:\n        "Convert a known logged meal directly into a saved recipe using meal_id. Use for \'save that as a recipe\' or \'make that meal a recipe\'; when meal_id is already known, do not search meals, foods, or ingredients first.",',
    "meal-to-recipe routing descriptions",
)
replace_once(
    "src/mcp-latency.ts",
    '    resolve_meal_review:\n        "Apply the user\'s answers or edits to a pending meal review. The meal remains unlogged until explicit confirmation.",',
    '    resolve_meal_review:\n        "Apply answers or edits to a pending meal review. Item-linked answers must include a reconciled full items payload; do not close a material question while leaving stale item facts or nutrition.",',
    "review reconciliation routing description",
)
replace_once(
    "src/mcp-latency.test.ts",
    '    test("compacts unmapped verbose descriptions to one bounded sentence", () => {',
    '''    test("routes known meal-to-recipe intent without history fan-out", () => {
        const description = compactToolDescription(
            "save_meal_as_recipe",
            "This fallback should not be used.",
        );
        expect(description).toContain("known logged meal");
        expect(description).toContain(
            "do not search meals, foods, or ingredients",
        );
        expect(description.length).toBeLessThan(261);
    });

    test("compacts unmapped verbose descriptions to one bounded sentence", () => {''',
    "meal-to-recipe latency regression",
)
replace_once(
    "src/mcp-latency.test.ts",
    '        expect(directModelToolCount()).toBe(29);',
    '        expect(directModelToolCount()).toBe(30);',
    "direct tool count",
)
replace_once(
    "src/mcp-latency.test.ts",
    '        expect(isModelPrivateTool("get_meals_by_date_range")).toBe(false);',
    '        expect(isModelPrivateTool("get_meals_by_date_range")).toBe(false);\n        expect(isModelPrivateTool("save_meal_as_recipe")).toBe(false);',
    "direct tool visibility",
)
replace_once(
    "src/mcp-runtime.ts",
    'import { registerMealReviewTools } from "./meal-review-tools.js";\n',
    'import { registerMealReviewTools } from "./meal-review-tools.js";\nimport { registerMealToRecipeTool } from "./meal-to-recipe.js";\n',
    "meal-to-recipe runtime import",
)
replace_once(
    "src/mcp-runtime.ts",
    "Saved recipes use search_recipes/get_recipe. Use personal scope by default",
    "Saved recipes use search_recipes/get_recipe. When the user wants an already-known logged meal saved as a recipe, use save_meal_as_recipe with that meal ID instead of searching meals, foods, or ingredients again. Use personal scope by default",
    "server meal-to-recipe routing instruction",
)
replace_once(
    "src/mcp-runtime.ts",
    "Prefer this atomic review flow over legacy granular draft tools.\\n\\nRecipe URLs",
    "Prefer this atomic review flow over legacy granular draft tools. When answering an item-linked material review question, reconcile the affected canonical item in the same resolve_meal_review call; do not close the question while leaving stale assumptions or nutrition behind.\\n\\nRecipe URLs",
    "server reconciliation instruction",
)
replace_once(
    "src/mcp-runtime.ts",
    '    registerRecipePlanningTools(optimizedServer, userId, capabilities);\n    if (capabilities.tier === "premium"',
    '    registerRecipePlanningTools(optimizedServer, userId, capabilities);\n    registerMealToRecipeTool(optimizedServer, userId, capabilities);\n    if (capabilities.tier === "premium"',
    "meal-to-recipe runtime registration",
)

print("Applied current-main-aware meal review and meal-to-recipe routing changes.")
