# ADR-0010: Canonical user data contracts

Status: Accepted

## Context

Munch has one Railway PostgreSQL system of record, but several product surfaces historically derived the same user-facing values independently. The website, Insights, MCP tools, widgets, and settings UI could therefore disagree even when the stored row was correct. The observed example was nutrition goals: Today read the saved `nutrition_goals` row while Insights rendered the same macro cards with a null target and displayed "No target set."

Independent implementations also existed for nutrition totals, range averages, date-span counting, units, and product-policy constants. Previous nutrient-coverage fixes already demonstrated that mathematically plausible duplicate implementations can drift when null and zero have different meanings.

## Decision

Every user-facing fact has one persistence owner, and every derived value has one calculation owner. Presentation surfaces consume those contracts; they do not establish alternate business semantics.

### Persistence owners

| Domain                             | Canonical persistence owner                  |
| ---------------------------------- | -------------------------------------------- |
| Meals                              | `munch.meals`                                |
| Consumed meal items and provenance | `munch.meal_items`                           |
| Nutrition goals                    | `munch.nutrition_goals`                      |
| Water                              | `munch.water_logs`                           |
| Weight                             | `munch.weight_logs`                          |
| User preferences                   | `munch.account_preferences`                  |
| Recipes and immutable revisions    | recipe tables and planning repository        |
| Meal planning                      | meal calendar tables and planning repository |
| Groceries                          | grocery tables and planning repository       |
| Billing facts                      | Stripe-backed billing repository             |
| Product limits and prices          | `PRODUCT_CONFIG`                             |

### Nutrition read contract

The website uses the canonical nutrition contract in `src/nutrition-contract.ts` for:

- meal totals;
- logged-day averages;
- inclusive date-range counts;
- timezone-aware day grouping;
- nutrition-goal propagation; and
- partial nutrient coverage semantics for fiber, sugar, and alcohol.

The partial nutrient rule remains owned by `src/insights.ts`: a day with no recorded value for a partial nutrient is not silently converted into a confirmed zero for averages or coverage counts.

Today, Food Log history, and Insights must consume the canonical contract rather than implementing their own reducers or date arithmetic.

### Legacy cross-surface boundaries

Some MCP code predates the canonical web contract and remains intentionally stable because its tool schemas and output contracts are public integration surfaces. While those implementations remain separate, parity tests are mandatory. They compare MCP totals, averages, nutrient coverage, and date-range behavior against the canonical contract so a behavioral divergence fails CI.

The same rule applies to browser/server unit conversion boundaries: canonical storage remains grams or milliliters, and parity tests prevent display helpers from adopting different conversion semantics.

### Product policy

Free-tier limits, Premium price, discounted household-seat price, and household member limits originate in `PRODUCT_CONFIG`. Authorization and billing modules may export compatibility aliases, but those aliases must derive from `PRODUCT_CONFIG` rather than redeclare numbers.

The authenticated account UI consumes a public projection of that policy from the app bootstrap contract, including billing arithmetic and household member limits. Static public marketing copy that intentionally repeats a displayed price remains protected by consistency checks.

### Foods workspace

The website no longer exposes a first-class Foods workspace. Historical structured meal items are the user-facing record of foods previously consumed, while Recipes remain the reusable multi-ingredient abstraction.

The saved-food repository and MCP tools are retained temporarily as a compatibility layer for existing/custom-connector tool catalogs and explicit saved aliases/default portions. `/app/foods` redirects to Food Log, and dynamic website navigation must not expose a Foods destination.

Removing the compatibility storage or MCP tools is a separate versioned change and must not be coupled to the website navigation removal.

## Enforcement

Changes affecting shared user-facing data must include tests that demonstrate parity across the surfaces they touch. At minimum, the suite covers:

- Today and Insights goal identity;
- web and MCP meal-total parity;
- web and MCP average/partial-nutrient parity;
- inclusive date-range parity;
- timezone grouping;
- web/server weight conversion parity;
- product-policy aliases and billing arithmetic; and
- Foods workspace retirement.

A new UI surface should consume an existing canonical contract. If a new derived concept has no owner, create a domain-level owner first rather than placing the calculation in the renderer.

## Consequences

- Stored data remains normalized by domain rather than being merged into a single table.
- UI code becomes thinner and less capable of contradicting another surface.
- Existing MCP contracts can be migrated incrementally without accepting silent drift.
- Product-policy changes require one configuration change instead of coordinated numeric edits across authorization modules.
- Compatibility layers are explicit and testable rather than being mistaken for first-class product concepts.
