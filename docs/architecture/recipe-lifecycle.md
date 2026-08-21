# Recipe lifecycle

Munch has one reusable-combination abstraction: `recipes`. A saved food remains a reusable single food or product snapshot; a recipe is an ordered combination of ingredients with quantities, servings, nutrition, and source provenance; a meal is the immutable historical record of what was consumed. There is no separate saved-meal table.

## Revision and logging rules

- `save_recipe` creates recipe identity and revision 1.
- `update_recipe` replaces the complete definition with a new immutable revision and moves the recipe identity to that revision. It uses optimistic `version` checks and an update idempotency key.
- `delete_recipe` archives the recipe. Active search and planning hide archived recipes, while revisions and historical meals remain exportable.
- `log_recipe` requires an explicit serving amount and meal type. It loads the selected revision, scales every ingredient quantity and stored nutrient fact, and writes the result through the structured meal path.
- Each logged item stores the recipe ID, revision ID, ingredient ID, and original ingredient source snapshot. Later recipe edits cannot recalculate the historical meal.
- `schedule_recipe` pins a recipe revision to the meal calendar. A plan entry is never treated as consumption.

## URL import and review

- `parse_recipe_url` is a read-only preview operation. It accepts a public HTTPS URL, fetches bounded HTML after SSRF-safe URL and redirect checks, and parses Schema.org JSON-LD first with Recipe microdata fallback.
- The shared importer normalizes ingredients, instructions, servings, timing, source provenance, and provider-backed nutrition matches. Ambiguous or unresolved ingredients remain visible as review warnings instead of being silently omitted.
- The website-only route may inject the configurable OpenRouter semantic resolver. It gets at most one batched ingredient-interpretation call and one bounded candidate-reranking call per import. It may split alternatives, interpret ranges, strip preparation language, and select among Munch food-search candidates, but the server still owns provider IDs, portion scaling, nutrition arithmetic, and provenance.
- The MCP route deliberately does not inject the website resolver. ChatGPT or another connected MCP model already supplies the conversational intelligence, so it uses the deterministic preview, its own page understanding, and `search_foods` to resolve recipe language without creating a second paid model call.
- The website uses the same preview contract at `POST /api/app/recipes/import-preview`, then hands the edited draft to the existing recipe save path. Neither channel persists a recipe or adds groceries until the user explicitly confirms.
- Imported recipes retain `source_type=imported`, the canonical source URL, ingredient-level resolution snapshots, and any automatic assumptions so later recipe logging remains pinned to the saved revision.

For a one-serving `My Peanut Butter Sandwich Lunch`, logging `0.5` stores two slices as one slice, four tablespoons of peanut butter as two tablespoons, two tablespoons of chia as one tablespoon, and half of the saved nutrition totals. The historical meal remains linked to revision 1 after a later update changes peanut butter to three tablespoons.

Ambiguous photo or free-text meals continue to use the existing meal-review/draft confirmation workflow. A saved recipe is already a resolved structured source, so `log_recipe` asks for the missing serving amount in conversation and writes directly once the amount is explicit.
