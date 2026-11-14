import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function sqlFiles(directory: string): string[] {
    return readdirSync(`${root}${directory}`)
        .filter((name) => name.endsWith(".sql"))
        .sort();
}

// The canonical baseline is frozen. scripts/migrate.ts installs
// db/schema ONLY into an empty database; a database that already
// carries the schema-generation marker (production) applies
// db/updates/ files only. A migration filed under db/schema therefore
// never reaches production: on 2026-11-13 PRs #319/#321 filed the Jev
// sweep tables and the recipe yield_estimate column there, every
// production deploy stayed green, and recipe detail reads broke on
// the missing column. Post-baseline migrations belong in db/updates/
// under the next number, written defensively (the updates runner
// also applies them after the baseline on fresh installs). If the
// baseline is ever deliberately re-generated, update this list in
// the same change.
const BASELINE_SCHEMA_FILES = [
    "0001_foundation.sql",
    "0002_nutrition_core.sql",
    "0003_account_deletion_privileges.sql",
    "0004_service_facilities.sql",
    "0005_structured_meal_items.sql",
    "0006_saved_foods.sql",
    "0007_meal_drafts.sql",
    "0008_meal_draft_confirmation_deletion.sql",
    "0009_tool_events_read_grant.sql",
    "0010_better_auth.sql",
    "0011_household_foundation.sql",
    "0012_household_owner_bootstrap.sql",
    "0013_recipe_book.sql",
    "0014_meal_calendar.sql",
    "0015_grocery_lists.sql",
    "0016_recipe_usage_links.sql",
    "0017_shared_attribution_lifecycle.sql",
    "0018_shared_attribution_triggers.sql",
    "0019_persistent_food_catalog.sql",
    "0020_atomic_meal_review.sql",
    "0021_paid_household_seats.sql",
    "0022_recipe_revision_idempotency.sql",
    "0023_inventory.sql",
    "0024_inventory_actor_retention.sql",
    "0025_inventory_planning_profiles.sql",
    "0029_store_billing.sql",
    "0030_jev_sweep.sql",
    "0031_recipe_yield_estimate.sql",
];

describe("migration placement", () => {
    test("db/schema holds exactly the frozen baseline set", () => {
        expect(sqlFiles("db/schema")).toEqual(BASELINE_SCHEMA_FILES);
    });

    test("every db/updates file matches the runner's NNNN_name.sql shape", () => {
        for (const name of sqlFiles("db/updates")) {
            expect(name).toMatch(/^\d{4,}_[a-z0-9_-]+\.sql$/i);
        }
    });
});
