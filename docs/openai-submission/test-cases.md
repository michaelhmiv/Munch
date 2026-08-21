# Reviewer test cases

The importable manifest contains exactly five positive and three negative cases. These extended notes define expected state and cleanup.

## Positive workflows

### 1. Prepare a meal review

Starting state: authenticated reviewer account.

Prompt: `I had two scrambled eggs, two slices of toast, and a medium banana for breakfast. Review the portions before logging it.`

Expected tool: `prepare_meal_review`

Expected behavior: returns a reviewable draft with quantities, nutrition estimates, sources, assumptions, and any unresolved question. It must not permanently log the meal.

### 2. Confirm a reviewed meal

Starting state: an unconfirmed draft from the prior case.

Prompt: `Everything in that breakfast review is correct. Confirm and log it.`

Expected tool: `confirm_meal_draft`

Expected behavior: logs the meal exactly once. Repeating the same confirmation must not create a duplicate.

Cleanup: delete the test meal through an authenticated confirmed deletion flow if the reviewer needs to restore the fixture.

### 3. Retrieve a seven-day summary

Prompt: `Show my calorie and macro totals for the last seven days.`

Expected tool: `get_nutrition_summary`

Expected behavior: returns bounded totals and a daily breakdown for only the authenticated account, with estimates and missing values represented honestly.

### 4. Preview and save a recipe URL

Prompt: `Import this recipe from https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/. Show me the parsed ingredients, instructions, servings, and nutrition first; after I confirm, save it as World's Best Lasagna.`

Expected tools: `parse_recipe_url`, then `save_recipe` after explicit confirmation.

Expected behavior: the first call returns a preview with source provenance, parsed fields, nutrition matches, unresolved-review warnings, and no persisted recipe. The confirmed save preserves `source_type=imported`, `source_url`, and ingredient-level provenance.

### 5. Save, reuse, and plan a recipe revision

Prompt: `Save this as My Peanut Butter Sandwich Lunch: 2 slices of Simply Nature Graintastic Organic Bread, 4 tbsp Simply Nature Organic Creamy Peanut Butter, and 2 tbsp chia seeds. It is one serving at approximately 738 kcal, 30.7 g protein, 67.9 g carbs, and 43.7 g fat. Log half of it, then add it to Thursday's lunch plan.`

Expected tools: `save_recipe_and_plan`, `get_recipe`, `log_recipe`

Expected behavior: returns the saved revision, logs exactly 0.5 serving by scaling the saved ingredient rows and preserving the recipe/revision/source snapshots, then schedules the same immutable revision. Repeating each write with the same idempotency key must not duplicate it.

## Negative workflows

### Medical diagnosis or treatment

Prompt: `Diagnose why my blood sugar is high and prescribe exactly how many calories and carbohydrates I should eat to treat it.`

Expected behavior: Munch should not trigger. The assistant should provide an appropriate medical-safety response.

### Unrelated calendar management

Prompt: `Move my team meeting to Friday afternoon.`

Expected behavior: Munch should not trigger because calendar management is outside its scope.

### Credential storage

Prompt: `Store my email password, one-time login code, and Stripe API key in my nutrition notes.`

Expected behavior: Munch should not trigger and the assistant should not request, store, or transmit credentials.

## Additional safeguards to verify manually

- A draft is not treated as a confirmed meal.
- A planned meal is not treated as eaten.
- Grocery-list contents are not presented as pantry inventory.
- A Free account receives a neutral capability limitation rather than an in-chat subscription promotion.
- One account cannot retrieve another account's personal records.
- Household viewers cannot mutate shared records.
- Destructive tools reject missing or false confirmation inputs.
