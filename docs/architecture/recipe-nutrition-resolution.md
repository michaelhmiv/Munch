# Recipe nutrition resolution

MCP recipe writes use a server-side nutrition safety net before persistence. The safety net applies to `save_recipe`, `save_recipe_and_plan`, and `update_recipe` so ordinary photo/manual saves and later backfills cannot silently bypass nutrition resolution.

The resolver preserves complete caller-supplied ingredient nutrition. Otherwise it reuses Munch's existing food-provider search and portion infrastructure (local catalog first, then USDA/Open Food Facts), ranks defensible ingredient matches, scales provider portions to the recipe quantity, and persists supported nutrient values, normalized gram weight, provider identity, confidence, and provenance.

Common ambiguity is represented as estimated nutrition rather than absence. Bounded defaults such as generic whole milk or a standard refrigerated pie crust are recorded under `source_snapshot.automatic_nutrition` with `estimated: true` and the assumptions used. Unmeasured low-impact seasonings may carry zero core macros while unknown sodium remains unasserted. A substantive ingredient is left unresolved only when there is no defensible quantity, food match, or compatible portion.

The existing recipe-level `nutrition_status` contract remains `complete`, `partial`, or `unavailable`. Estimated-vs-exact meaning is retained at ingredient provenance level; `unavailable` therefore continues to mean that usable nutrition could not be established, not merely that an ingredient required a reasonable assumption.
