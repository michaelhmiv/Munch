# Recipe lifecycle

Munch has one reusable-combination abstraction: `recipes`. A saved food remains a reusable single food or product snapshot; a recipe is an ordered combination of ingredients with quantities, servings, nutrition, and source provenance; a meal is the immutable historical record of what was consumed. There is no separate saved-meal table.

## Revision and logging rules

- `save_recipe` creates recipe identity and revision 1.
- `update_recipe` replaces the complete definition with a new immutable revision and moves the recipe identity to that revision. It uses optimistic `version` checks and an update idempotency key.
- `delete_recipe` archives the recipe. Active search and planning hide archived recipes, while revisions and historical meals remain exportable.
- `log_recipe` requires an explicit serving amount and meal type. It loads the selected revision, scales every ingredient quantity and stored nutrient fact, and writes the result through the structured meal path.
- Each logged item stores the recipe ID, revision ID, ingredient ID, and original ingredient source snapshot. Later recipe edits cannot recalculate the historical meal.
- `schedule_recipe` pins a recipe revision to the meal calendar. A plan entry is never treated as consumption.

For a one-serving `My Peanut Butter Sandwich Lunch`, logging `0.5` stores two slices as one slice, four tablespoons of peanut butter as two tablespoons, two tablespoons of chia as one tablespoon, and half of the saved nutrition totals. The historical meal remains linked to revision 1 after a later update changes peanut butter to three tablespoons.

Ambiguous photo or free-text meals continue to use the existing meal-review/draft confirmation workflow. A saved recipe is already a resolved structured source, so `log_recipe` asks for the missing serving amount in conversation and writes directly once the amount is explicit.
