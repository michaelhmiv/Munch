from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected marker missing in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, count))


# Avoid duplicate full Pantry retrieval/enrichment during a single website
# recommendation request. Saved-recipe ranking can consume a preloaded context.
replace(
    "src/inventory/meal-planning.ts",
    '''    maxMinutes?: number;
    limit?: number;
}): Promise<PantryRecipeCandidate[]> {
    const [context, recipes] = await Promise.all([
        getPantryPlanningContext({
            userId: input.userId,
            scope: input.scope,
            limit: 200,
        }),
        readSavedRecipeRows({''',
    '''    maxMinutes?: number;
    limit?: number;
    context?: PantryPlanningContext;
}): Promise<PantryRecipeCandidate[]> {
    const [context, recipes] = await Promise.all([
        input.context
            ? Promise.resolve(input.context)
            : getPantryPlanningContext({
                  userId: input.userId,
                  scope: input.scope,
                  limit: 200,
              }),
        readSavedRecipeRows({''',
)
replace(
    "src/inventory/meal-ideas.ts",
    '''    const [pantry, savedRecipes] = await Promise.all([
        getPantryPlanningContext({
            userId: input.userId,
            scope: input.scope,
            limit: 200,
            enrichLimit: 32,
        }),
        rankSavedRecipesForPantry({
            userId: input.userId,
            scope: input.scope,
            goal: input.goal,
            assumedStaples,
            maxMinutes: input.maxMinutes,
            limit: 8,
        }),
    ]);''',
    '''    const pantry = await getPantryPlanningContext({
        userId: input.userId,
        scope: input.scope,
        limit: 200,
        enrichLimit: 32,
    });
    const savedRecipes = await rankSavedRecipesForPantry({
        userId: input.userId,
        scope: input.scope,
        goal: input.goal,
        assumedStaples,
        maxMinutes: input.maxMinutes,
        limit: 8,
        context: pantry,
    });''',
)

# Classification regression: culinary pepper must not swallow bell peppers.
replace(
    "src/inventory/planning-profile.test.ts",
    '''        expect(classifyPantryFood("fresh garlic").culinaryRoles).toContain(
            "aromatic",
        );
    });''',
    '''        expect(classifyPantryFood("fresh garlic").culinaryRoles).toContain(
            "aromatic",
        );
        expect(classifyPantryFood("red bell pepper").category).toBe("produce");
        expect(classifyPantryFood("black pepper").category).toBe("spice");
    });''',
)

# MCP regression explicitly locks the no-new-tool decision and planning detail.
replace(
    "src/inventory/tools.test.ts",
    '''        expect(pantrySchema?.candidate_names).toBeDefined();
        expect(reconcileSchema?.idempotency_key).toBeDefined();''',
    '''        expect(pantrySchema?.candidate_names).toBeDefined();
        expect(pantrySchema?.detail_level).toBeDefined();
        expect(tools.has("recommend_meal_from_pantry")).toBe(false);
        expect(reconcileSchema?.idempotency_key).toBeDefined();''',
)

# Static website contract includes deliberate meal planning and privacy disclosure.
replace(
    "scripts/pantry-ui-smoke.ts",
    '''    'id="review"',
    'id="inventory"',
    'name="viewport"',''',
    '''    'id="review"',
    'id="meal-planner"',
    'id="meal-idea-form"',
    'id="meal-goal"',
    'id="meal-staples"',
    'id="meal-ideas"',
    'id="inventory"',
    'name="viewport"',''',
)
replace(
    "scripts/pantry-ui-smoke.ts",
    '''    "/api/app/pantry/scan-preview",
    "/api/app/purchases/receipt-preview",''',
    '''    "/api/app/pantry/scan-preview",
    "/api/app/pantry/meal-ideas",
    "/api/app/purchases/receipt-preview",''',
)
replace(
    "scripts/pantry-ui-smoke.ts",
    '''if (/receipt_image|raw_image|image_bytes/.test(routes)) {
    throw new Error(
        "Pantry route source suggests raw receipt media persistence",
    );
}''',
    '''if (/receipt_image|raw_image|image_bytes/.test(routes)) {
    throw new Error(
        "Pantry route source suggests raw receipt media persistence",
    );
}
if (
    !html.includes("whole kitchen") ||
    !html.includes("spices, sauces, condiments") ||
    !routes.includes("generatePantryMealIdeas")
) {
    throw new Error(
        "Pantry meal planning does not preserve the deliberate full-kitchen contract",
    );
}
if (js.includes("mealIdeasEl.innerHTML") || js.includes("candidate.description}`")) {
    throw new Error("AI meal-idea strings must be rendered with safe text nodes");
}''',
)
replace(
    "scripts/pantry-ui-smoke.ts",
    '''    !privacy.includes("Pantry and receipt images") ||
    !privacy.includes("<strong>OpenRouter</strong>") ||
    !privacy.includes("not a promise of zero retention")''',
    '''    !privacy.includes("Pantry and receipt images") ||
    !privacy.includes("Pantry meal planning") ||
    !privacy.includes("<strong>OpenRouter</strong>") ||
    !privacy.includes("not a promise of zero retention")''',
)

# Export the derived planning profile alongside Pantry state and advance schema.
replace(
    "src/account-export.ts",
    '''            inventoryItems,
            inventoryEvents,''',
    '''            inventoryItems,
            inventoryItemProfiles,
            inventoryEvents,''',
)
replace(
    "src/account-export.ts",
    '''            tx<JsonRecord[]>`
                select event.*
                from munch.inventory_events event''',
    '''            tx<JsonRecord[]>`
                select profile.*
                from munch.inventory_item_profiles profile
                join munch.inventory_items item
                  on item.id = profile.inventory_item_id
                join munch.inventory_spaces space
                  on space.id = item.inventory_space_id
                where space.personal_owner_user_id = ${userId}
                   or space.household_id in (
                       select membership.household_id
                       from munch.household_memberships membership
                       where membership.user_id = ${userId}
                         and membership.status = 'active'
                   )
                order by item.inventory_space_id, profile.inventory_item_id
            `,
            tx<JsonRecord[]>`
                select event.*
                from munch.inventory_events event''',
)
replace("src/account-export.ts", "schema_version: 2,", "schema_version: 3,")
replace(
    "src/account-export.ts",
    '''            inventory_items: stripInternalFields(inventoryItems),
            inventory_events: stripInternalFields(inventoryEvents),''',
    '''            inventory_items: stripInternalFields(inventoryItems),
            inventory_item_profiles: stripInternalFields(inventoryItemProfiles),
            inventory_events: stripInternalFields(inventoryEvents),''',
)

# Account export smoke seeds one shared profile and verifies it is exported.
replace(
    "scripts/account-export-smoke.ts",
    '''const { closePlatformDatabase } = await import("../src/platform/database.js");''',
    '''const { closePlatformDatabase, withUserDatabase } =
    await import("../src/platform/database.js");''',
)
replace(
    "scripts/account-export-smoke.ts",
    '''await reconcilePantry({
    userId: owner.userId,
    scope: { type: "household", householdId: household.householdId },''',
    '''const pantryResult = await reconcilePantry({
    userId: owner.userId,
    scope: { type: "household", householdId: household.householdId },''',
)
replace(
    "scripts/account-export-smoke.ts",
    '''});

const exported = await exportAccountData(member.userId);''',
    '''});
const cottage = pantryResult.operations[0]?.item;
if (!cottage) throw new Error("Account export Pantry setup returned no item");
await withUserDatabase(owner.userId, async (tx) => {
    await tx`
        insert into munch.inventory_item_profiles (
            inventory_item_id, profile_status, source_type,
            category, culinary_roles, basis_quantity, basis_unit,
            basis_grams, calories, protein_g, profile_version, enriched_at
        ) values (
            ${cottage.id}, 'resolved', 'heuristic', 'dairy',
            ${["creamy", "dairy", "protein"]}::text[],
            100, 'g', 100, 100, 12, 1, now()
        )
    `;
});

const exported = await exportAccountData(member.userId);''',
    1,
)
replace(
    "scripts/account-export-smoke.ts",
    '''if (!serialized.includes('"inventory_events"')) {
    throw new Error("Account export omitted Pantry event history");
}''',
    '''if (!serialized.includes('"inventory_events"')) {
    throw new Error("Account export omitted Pantry event history");
}
if (
    !serialized.includes('"inventory_item_profiles"') ||
    !serialized.includes('"category":"dairy"') ||
    !serialized.includes('"protein_g":12')
) {
    throw new Error("Account export omitted Pantry planning profiles");
}''',
)
replace(
    "scripts/account-export-smoke.ts",
    '''if (document.schema_version !== 2) {
    throw new Error(
        "Account export schema version was not advanced for Pantry",
    );
}''',
    '''if (document.schema_version !== 3) {
    throw new Error(
        "Account export schema version was not advanced for Pantry Intelligence",
    );
}''',
)

# Privacy: structured Pantry/saved-recipe context is sent to OpenRouter only when
# the website recommendation feature is explicitly used.
replace(
    "public/privacy.html",
    "Last updated: August 24, 2026",
    "Last updated: August 25, 2026",
)
replace(
    "public/privacy.html",
    '''                                Optional Premium Pantry inventory, exact or
                                approximate quantities, storage locations,
                                inventory-event history, and structured purchase
                                or receipt reconciliation results. Munch does
                                not retain raw Pantry or receipt images after
                                the website extraction request is processed.''',
    '''                                Optional Premium Pantry inventory, exact or
                                approximate quantities, storage locations,
                                inventory-event history, structured purchase or
                                receipt reconciliation results, and refreshable
                                planning profiles that can include compact
                                nutrition facts, food-source identifiers, and
                                culinary categories or roles. Munch does not
                                retain raw Pantry or receipt images after the
                                website extraction request is processed.''',
)
replace(
    "public/privacy.html",
    '''                        <h3>Why it is stored</h3>''',
    '''                        <h3>Pantry meal planning</h3>
                        <p>
                            When an eligible Premium user asks the Munch website
                            for Pantry meal ideas, Munch can send the relevant
                            structured Pantry inventory, compact planning
                            profiles, explicit assumed staples, request goals,
                            and saved-recipe candidate facts to its configured AI
                            processor. This request is used to rank or generate
                            grounded meal ideas. Raw Pantry or receipt images are
                            not included in this meal-planning request, and the
                            recommendation does not change Pantry, Grocery, or
                            recipe records by itself.
                        </p>
                        <h3>Why it is stored</h3>''',
)
replace(
    "public/privacy.html",
    '''                                <strong>OpenRouter</strong> receives Pantry or
                                receipt images uploaded through the Munch
                                website when AI-assisted extraction is enabled.
                                Munch requests routing with provider data
                                collection disabled.''',
    '''                                <strong>OpenRouter</strong> receives Pantry or
                                receipt images uploaded through the Munch
                                website when AI-assisted extraction is enabled,
                                and receives relevant structured Pantry and
                                saved-recipe context when an eligible user asks
                                the website for AI-assisted Pantry meal ideas.
                                Munch requests routing with provider data
                                collection disabled.''',
)

# Required CI exercises the new Postgres/RLS/ranking corpus without external AI.
replace(
    ".github/workflows/ci.yml",
    '''      - name: Exercise Pantry inventory, receipt reconciliation, and RLS
        run: bun scripts/pantry-platform-smoke.ts
      - name: Exercise complete account export and household privacy''',
    '''      - name: Exercise Pantry inventory, receipt reconciliation, and RLS
        run: bun scripts/pantry-platform-smoke.ts
      - name: Exercise Pantry planning profiles, ranking, and RLS
        env:
          MUNCH_PANTRY_PLANNING_ENABLED: "true"
        run: bun scripts/pantry-planning-smoke.ts
      - name: Exercise complete account export and household privacy''',
)

print("Pantry Intelligence completion patches applied.")
