# Recipe nutrition production verification

`MUNCH_RECIPE_NUTRITION_BACKFILL_EXPECTED_JSON` is an optional production-verification guard for the recipe nutrition backfill runner.

When supplied, it is a JSON object keyed by recipe ID. A recipe entry may assert `nutrition_status`, selected values in `nutrition_total`, selected values in `nutrition_per_serving`, a numeric `tolerance`, and `require_ingredient_core_nutrients`.

The runner still performs ownership discovery with auth access only, then reads and updates recipes through the normal user-scoped planning repository. Assertions run against the revision read back through that same path. Any mismatch exits non-zero so a controlled deployment can fail closed instead of treating an unverified backfill as successful.

This guard is intended for targeted production certification and should not be left configured during ordinary service startup.
