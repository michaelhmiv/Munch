# Munch — ChatGPT-first Guided Nutrition, with Website Parity

**Status:** Implementation specification / not yet implemented  
**Confirmed product decisions (2026-10-09):** All five outcomes below are in scope for this program. Weekly planning may combine saved recipes with customizable, AI-generated recipe drafts. A user-editable preference profile covers allergies, dislikes, likes, cooking difficulty and time, and available equipment; generation must use the saved recipe library and committed plan history to avoid repeats and improve variety. Goal guidance follows the user's selected objective (maintain, gain, lose, or track-only). Website AI-assisted planning uses the existing `MUNCH_AI_MODEL`, with manual fallback. Grocery-list additions are offered in a separate review-and-confirm step.

**Project:** `michaelhmiv/Munch`  
**Product:** Munch — consumer food, nutrition, recipes, planning, groceries and progress tracking  
**Primary experience:** ChatGPT plugin over Munch MCP  
**Equal-capability experience:** `https://munch.business/app`  
**Additional distribution:** Android/other installed clients follow existing mobile capability declarations  
**Baseline inspected:** `main`, repository tree `4f025dc298ff0214cbff47df1d3d8cb1d77299ea`, October 8, 2026

## 1. Mission

Extend Munch from predominantly factual meal/nutrition logging and recipe scheduling into an **optional guided nutrition planning loop**:

1. User defines desired goals, priorities, preferences and constraints.
2. Munch provides defensible data/context; the ChatGPT host model or Munch's website AI proposes candidate plans and recipes.
3. Munch validates the proposed plan against factual recipes, verified nutrition, scopes, permissions and constraints.
4. The user edits and explicitly approves any committed goal or meal-plan changes.
5. Munch records consumption separately from planning.
6. The user reviews progress, optionally considers suggested goal adjustments and plans the next week.

Implement the following five outcomes:

- **Goal guidance:** explain current goals, support reviewable goal-change recommendations, preserve goal history.
- **Guided weekly planning:** produce editable seven-day meal-plan drafts from saved and AI-generated recipes, personalized to user constraints and preferences.
- **Meal substitutions:** compare meaningful replacements; preview and atomically apply a chosen swap.
- **Weekly check-ins:** show trustworthy seven-day progress, coverage and actionable observations.
- **Daily guidance:** present a concise daily status and suggested next actions, never invent unlogged consumption.

This is NOT a workout-video platform, coaching marketplace, medical service or social network.

**Architectural invariant:** one user account, one canonical storage model, one deterministic domain/service implementation, and the same user outcomes through MCP and the authenticated website. The interfaces may differ; business rules cannot.

## 2. Repo findings / reuse rather than rebuild

Confirmed in current code:

- Runtime: Bun, Hono, Railway PostgreSQL with tenant/household row-level security; Better Auth + OAuth for MCP. `README.md`, `src/platform/database.ts`, `src/mcp-runtime.ts`.
- Nutrition goals currently persist basic daily macro and weight targets in `munch.nutrition_goals`; current `src/nutrition-platform/goals.ts` updates the latest state rather than maintaining a historical revision ledger.
- Recipes, immutable recipe revisions and personal/household planning already exist in `src/planning/repository.ts`, `db/schema/0013_recipe_book.sql` and `db/schema/0014_meal_calendar.sql`. `getMealPlan()` and `scheduleRecipe()` exist. The visible repository does **not** expose a general authenticated swap/update/unschedule lifecycle for planned meals; verify before adding it.
- `munch.planned_meals` already has `version`, `deleted_at`, owner scope and idempotency keys. Reuse these rather than creating a second calendar.
- Pantry matching/ranking is available in `src/inventory/meal-planning.ts` and `src/inventory/planning-profile.ts`; it is entitlement/feature-flag dependent. Do not assume pantry exists for every user.
- Trends, patterns and `computeWeeklyDigest()` exist in `src/insights.ts`. The existing textual digest averages caloric/protein data over all buckets, which may make days with no entries appear as zero intake. Fix or explicitly represent recording coverage in new analytics instead of interpreting missing data as eating nothing.
- `src/widgets.ts` assembles self-contained MCP App widgets from `public/widgets/src`. The user-facing widget templates and versioning tests already exist.
- `src/capability-manifest.ts` and `src/capability-manifest.test.ts` enforce outcome mappings for existing MCP tools; `src/mobile/capabilities.ts` declares mobile status. `docs/architecture/0011-cross-surface-capability-contracts.md` and `0012-mobile-product-surfaces.md` are accepted decisions. Extend these systems.
- `src/mcp-latency.ts` limits the direct model-facing catalog and routes low-frequency actions through the existing action gateway. Do not make every new operation a direct, prominently exposed tool.
- `docs/host-ai-mcp-boundary.md` explicitly forbids provider-model calls on MCP paths. The website may use the centralized `MUNCH_AI_MODEL`, currently configured through `src/website-ai-config.ts`. Keep this boundary.
- `docs/architecture/free-premium-household-contract.md` says Munch does **not** determine calorie/protein/weight-loss targets. Any guided target recommendation is a deliberate product-policy change: review this contract, make opt-in, preserve user control and keep Munch nonclinical.
- `docs/openai-submission/release-checklist.md` requires no pricing/upsell/checkout in OAuth/MCP/widgets and an authenticated reviewer account. Maintain this separation and keep release metadata in sync.

**First step for the implementing agent:** reconfirm the repository head, open PRs, actual migration head, feature flags and production plugin-review status. The above is a planning baseline, not a promise that production matches current source.

### 2.1 Existing-product testing audit — snapshot as of 2026-10-09

Reviewed `main` at `4f025dc298ff0214cbff47df1d3d8cb1d77299ea`, its test paths, package scripts, CI workflows, representative parity/auth/domain tests and recent Actions results. This is an inventory and workflow-level audit, not a line-by-line review of all tests or a coverage measurement.

**What is already in place**

- The repository contains 112 JavaScript/TypeScript `*.test.*` files across product, auth, billing, recipe/food, inventory, Cooks, mobile, UI and platform code.
- The PR/main `CI` workflow runs formatting, capability/commerce/submission/UI/widget checks, typechecking and `bun test`; it also runs a PostgreSQL 17 job that installs and re-applies the schema, then exercises auth/OAuth, nutrition, food catalog, structured meals, saved foods, household access/lifecycle, recipes/planning/groceries, Cooks, Pantry, exports/deletion, reviewer readiness and operations. A separate job builds the production container.
- Separate workflows test OAuth/session behavior, mobile bearer sessions, and an Android debug build with lint and unit tests. Manual or scheduled workflows cover live recipe-import and AI-provider corpora, USDA data, and production certification.
- Existing RLS, idempotency, migration, privacy, host-model-boundary and capability-manifest checks provide a strong server-side foundation.

**Gaps to address**

- No code-coverage report or coverage threshold was found in the package scripts or PR CI; current coverage therefore cannot be quantified.
- Website UI smoke checks validate static entry points/contracts. The OAuth “browser” smoke runs the app in-process over HTTP; no browser automation dependency or full authenticated website journey suite was found.
- Current parity tests check meal totals, missing-nutrient semantics and date-range behavior, while the capability manifest maps tools to outcomes. They do not yet exercise broad read/write journeys across MCP and the website against the same persisted account.
- Android CI builds and tests a debug app, but only a starter/example native unit-test file was found; the workflow does not run emulator/device UI journeys.
- Live model/provider corpora and production certification are manual or scheduled rather than part of every PR. Deterministic adapter and boundary tests run in PR CI, but model behavior is not continuously evaluated there.
- Production certification is available by manual dispatch. The audit did not find an automatic post-deploy certification trigger.

**Observed baseline runs**

- Main CI passed at commit `4f025dc` on 2026-09-17: https://github.com/michaelhmiv/Munch/actions/runs/35177767237
- The scheduled USDA corpus most recently passed on 2026-10-05: https://github.com/michaelhmiv/Munch/actions/runs/37346645204
- At the audit snapshot, PR #153's CI run failed at `format:check` because this plan file was not Prettier-formatted; the database and container jobs passed, but typecheck and `bun test` were skipped: https://github.com/michaelhmiv/Munch/actions/runs/37918751747

## 3. Product contract / UX principles

### 3.1 ChatGPT-first, not ChatGPT-dependent

ChatGPT should let a user say:

- "Plan seven dinners next week based on my 130 g protein target."
- "Show me three replacements for Thursday dinner that take under 30 minutes."
- "What did I do well this week? Was my food log complete enough to tell?"
- "What are my main nutrition priorities today?"
- "Show me what changing my protein goal would look like."

These should use **Munch's saved data**, not free-form invented past meals. The host model can reason over context and make proposals but Munch remains the authority for permission checks, calculations, provenance, validation, idempotency and persistence.

No everyday nutrition operation should _require_ leaving ChatGPT.

### 3.2 Website parity

On the standalone website, each of those outcomes must be independently possible through understandable controls, without ChatGPT connection or a pasted conversational prompt. Desktop and responsive mobile web should both work.

**Parity means:** equivalent records, validation, editable proposals, permissions, undo/history and results. It does **not** mean identical screen layout or equal counts of MCP tools and website buttons.

Native mobile receives matching capability declarations and separate certification as its surfaces mature. Do not mark native coverage `complete` without a verified journey; do not block required MCP/website parity on unimplemented iOS.

### 3.3 Focused product scope

Prefer four or five familiar website workspaces: **Today**, **Plan**, **Recipes/Groceries**, **Insights**, and **Goals/Settings**. Extend current information architecture rather than add five competing navigation destinations. Daily guidance lives in Today, meal generation and swaps in Plan, weekly check-ins in Insights, adaptive targets in Goals.

For ChatGPT, prefer concise text for small answers, inline cards for one decision, and fullscreen MCP App views only for a week calendar or multi-step review. Widgets complement tool calls; must not obscure source information or require inaccessible controls.

No obligation to deliver step-count sync, push notifications, coaching, communities, workout programming or challenges in the initial release.

## 4. Domain architecture

Organize by shared feature modules, not surfaces.

Proposed additions (adapt to repo conventions):

```text
src/guidance/
  contracts.ts             # shared validation/types/Zod
  preferences.ts           # preferences + exclusions
  goals.ts                 # goal snapshot, proposal, approval/history
  planning-context.ts      # canonical recipes, targets, pantry permissions
  plan-drafts.ts           # create/edit/validate/commit/cancel
  plan-scoring.ts          # deterministic candidate scoring + hard constraints
  substitutions.ts         # options/preview/apply/undo
  checkins.ts              # structured weekly review with coverage
  daily.ts                 # daily guidance from planned vs observed
  repository.ts            # transactional persistence helpers
  *.test.ts
src/guidance-tools.ts      # MCP adapter only
src/app/guidance-routes.ts # website API adapter only
public/widgets/src/templates/
  guided-plan.html
  plan-swap.html
  weekly-checkin.html
  goal-change.html
public/widgets/src/shared/
  ...reused components...
db/updates/
  <next migration number(s)>.sql
```

The server/service layer exposes deterministic pure functions and repositories; both adapters call those. Reuse `src/nutrition-platform`, `src/planning`, `src/insights.ts` and nutrition-provenance systems instead of copying them.

The website uses the configured provider for **candidate proposals only** as a planned v1 capability. Parse every response with a versioned schema; no model output bypasses deterministic verification. Keep the manual planner available whenever AI is disabled, unavailable, declined or over budget.

Do not call an AI provider from `src/mcp-runtime.ts` or its transitive imports. Add tests preserving the existing `src/host-ai-boundary.test.ts` rule.

## 5. Persistence / migration design

Use additive, reversible-in-effect migrations with backward-compatible reads. Choose final names after checking the actual schema and next unused migration number.

### 5.1 Nutrition guidance preferences

New user-scoped preferences may include:

- `objective`: maintain, gain, lose, or track-only (self-reported).
- `target_style`: self-managed versus suggestions-enabled.
- User-specified daily calorie/macro target, allowed variance and preferred review cadence.
- Dietary preferences, excluded ingredients, food allergies, disliked foods, liked cuisines/flavors/ingredients, meal slots per day, prep-time and total-time limits, budget and shopping preferences, repeat tolerance and desired variety.
- Cooking skill or preferred difficulty, easy-to-cook preference, owned/available equipment (including custom equipment), and preferred or avoided cooking methods.
- Optional pantry use when authorized and available.
- Version, updated timestamp and source/provenance of self-reported input.
- A profile that users can review and edit on both MCP and website, plus one-plan overrides; profile setup is skippable and must not block a first plan.

Do not collect sensitive health diagnoses or create disease-specific goals. Distinguish hard exclusions (e.g. allergy/ingredient) from soft preferences (e.g. preferred cuisine).

### 5.2 Goal revisions and review decisions

Preserve `munch.nutrition_goals` as current-state compatibility table and introduce an append-only goal-revision/audit table. Record revision ID, old/new values, origin (`user`, `mcp`, `website`), user confirmation, timestamp, algorithm version, rationale, optional linked recommendation ID and units. Link weekly assessments to the goal revision effective for that week.

A recommendation/proposal must expire, be rejectable, and never silently change goals. Applying it must atomically update current goals and insert history with idempotency and expected-version checking.

### 5.3 Meal-plan drafts and batches

Keep committed meals in `munch.planned_meals`. Introduce user-/household-scoped **draft header and draft item tables** with:

- range, timezone, scope/owner, selected constraints, target snapshot, generated-by provenance, status (`draft`, `committed`, `cancelled`, `expired`), version, expiry;
- date, meal slot, servings and editable notes, with either a saved `recipe_id` + **immutable recipe_revision_id** or a versioned structured generated-recipe snapshot;
- generated-recipe fields for title, ingredients with quantities/units, instructions, yield, prep/cook time, difficulty, required equipment, cuisine/method tags, nutrition provenance and user edits;
- nutritional completeness per item, warnings/blocking issues, predicted daily totals, origin information;
- commit ID and idempotency key to prevent repeated save.

Draft saves must not log eaten meals, mutate pantry or auto-add groceries. On explicit plan commit, materialize only selected generated recipes as durable immutable revisions linked to their planned meals; rejected candidates are never persisted. Keep personal Recipe Library membership as a user-controlled save action, while committed plan history retains the recipe snapshot for cooking history and future repeat/duplicate checks. Grocery-list additions are a separate post-commit review-and-confirm action; a user can commit a plan without changing groceries. Either use a transactionally bounded week commit or preserve a documented, recoverable partial-commit contract; prefer a single transaction.

Never overwrite previously scheduled meals without a clear review and user-selected replace/merge policy. Detect stale draft data and return a conflict that supports refresh.

### 5.4 Plan changes and history

Use `planned_meals.version` for optimistic concurrency and `deleted_at` for unplanning. Add a narrow change-history/audit table with old/new recipe revision, date, slot, servings, actor, source, reason, timestamp. A swap changes only the intended planned item, not its historic logged consumption. Undo should restore the prior plan if it is still compatible with current state/version.

### 5.5 Check-in snapshots and advisory records

Prefer calculate-on-read first to avoid scheduling infrastructure. Persist user-authored check-in reflections and accepted/rejected guidance only if valuable. Record period, input coverage, goal revision, generated summary algorithm version, created time and opt-in consent where relevant. Never store AI interpretations as factual logged intake.

All new tables require forced PostgreSQL RLS, least privilege grants, role checks, personal/household separation, account-deletion/export coverage and migration/idempotency tests.

## 6. Canonical contracts and APIs

Suggested contract shapes, not fixed identifiers:

```ts
type NutritionProvenance = {
    status: "complete" | "partial" | "unavailable";
    sourceTypes: string[];
    warnings: string[];
};

type DayTargetEvaluation = {
    date: string; // user's local YYYY-MM-DD
    planned: { calories: number | null; proteinG: number | null };
    target: { calories: number | null; proteinG: number | null };
    coverage: NutritionProvenance;
    hasBlockingConstraints: boolean;
};

type PlanDraft = {
    id: string;
    version: number;
    scope: { type: "personal" } | { type: "household"; householdId: string };
    startDate: string;
    endDate: string;
    timezone: string;
    status: "draft" | "committed" | "cancelled" | "expired";
    days: DayTargetEvaluation[];
    blockers: string[];
    warnings: string[];
    expectedPlanVersion?: number;
};

type GoalChangeProposal = {
    id: string;
    currentRevisionId: string;
    proposedTargets: Record<string, number | null>;
    evidence: { weightDays: number; loggedDays: number; timeframeDays: number };
    rationale: string[];
    limitations: string[];
    expiresAt: string;
};

type GeneratedRecipeProposal = {
    title: string;
    ingredients: Array<{
        name: string;
        quantity: number | null;
        unit: string | null;
        optional: boolean;
    }>;
    instructions: string[];
    servings: number;
    prepMinutes: number | null;
    cookMinutes: number | null;
    difficulty: "easy" | "moderate" | "advanced";
    requiredEquipment: string[];
    cuisineTags: string[];
    primaryProtein: string | null;
    cookingMethods: string[];
    // Nutrition is resolved and calculated by Munch; model-supplied macro values are not trusted.
    nutritionProvenance: NutritionProvenance;
};
```

Suggested shared service operations:

- `getGuidanceContext(userId, scope, dates)`: aggregate current goals, goal revision, scoped recipe-library and recent-plan summaries, pantry permission/matches (optional), constraints, available-equipment profile, existing plan and source status. Bound returned rows.
- `validateGeneratedRecipeProposal(userId, scope, proposal, profile, constraints, libraryContext)`: validate a structured proposal from the ChatGPT host or website AI adapter; perform deterministic ingredient, allergen, equipment, nutrition, novelty and variety checks, with no model-provider call.
- `previewGoalAdjustment(userId, proposedTargets | userConfiguredRule)` / `commitGoalAdjustment(userId, proposalId, expectedRevision, idempotencyKey, confirmation)`.
- `createPlanDraft(userId, scope, dates, proposalItems, constraints, idempotencyKey)`; `getPlanDraft`; `updatePlanDraft`; `validatePlanDraft`; `commitPlanDraft`; `cancelPlanDraft`.
- `rankMealSwapCandidates(userId, plannedMealId, filters)`; `previewMealSwap`; `commitMealSwap(userId, plannedMealId, candidate, expectedVersion, confirm, idempotencyKey)`; `undoMealSwap`.
- `getWeeklyCheckin(userId, inclusiveDateRange)` and `getDailyGuidance(userId, localDate)`.

**MCP**: Add a small set of clearly named, user-intent tools. Prioritize context/read, plan-draft preparation, plan confirmation, swap preview/apply, weekly review and daily guidance. Follow existing `registerTool` schema annotations (`readOnlyHint`, `destructiveHint`/write behavior, explicit `confirm` on impactful writes), auth, `structuredContent` and `MCP_TOOL_CAPABILITY_MAP`. Reserve specialized editing/cancel/undo tools for the existing advanced-action gateway if appropriate. Keep the direct model-facing tool catalog small and optimize for unambiguous intent.

**Website**: Add Hono endpoints under `/api/app` using authenticated sessions, existing CSRF rules and shared services. E.g. `GET /guidance/context`, `POST /guidance/goals/preview`, `POST /guidance/goals/commit`, `POST /planning/drafts`, `GET/PATCH /planning/drafts/:id`, `POST /planning/drafts/:id/commit`, `GET /planning/:id/swaps`, `POST /planning/:id/swap`, `GET /insights/checkin`, `GET /guidance/today`. Do not independently recalculate nutrition in browser JS. Keep idempotency keys, version conflict formats and `source_status` consistent across adapters.

**Critical separation**: meal planning ≠ meal logging ≠ grocery acquisition ≠ pantry depletion. Confirm each mutation explicitly; never infer that scheduled food was consumed.

## 7. Feature specifications

### 7.1 Adaptive goal guidance

The user's selected objective—maintain, gain, lose or track-only—must shape goal guidance and meal-plan scoring. Do not apply one generic target adjustment to every person. Build in phases: (a) user-specified target changes with historical comparison; (b) opt-in, transparent recommendations tied to objective-specific data and a documented product policy.

- Start with existing goal fields; don't create a conflicting target store.
- Define distinct behavior for maintaining, gaining, losing and track-only. Use a user-entered target or timeframe when available; otherwise explain what can and cannot be inferred. Keep target proposals evidence-gated, nonclinical, opt-in and explicitly approved. The model may explain a proposal but cannot invent or commit numeric targets.
- A proposal states current target, suggested target, plain-language basis, input window, number of measured weight days, number of logged nutrition days, uncertainty and user-editable target.
- Use **trend** weight rather than reacting to one measurement; apply configurable conservative change bounds. Set and document minimum evidence thresholds before any recommendation. If threshold fails, show "insufficient data" and let user edit their goals manually.
- Missing days are unknown, not zero consumption. Don't claim weight change was caused by a particular calorie intake or imply clinically precise TDEE.
- Persist user's acceptance/rejection and never silently update goals. User can turn adaptive suggestions off.
- Avoid medical conditions, clinical weight-loss prescriptions, rigid calorie floors, or claims of medical expertise. Product/legal review the altered nonmedical contract before exposure; if not supportable, ship only target-tracking and manual review in v1.
- Goal changes apply prospectively. Weekly reports retain the historical effective goal revision, not today's target retroactively.

### 7.2 Personalized weekly meal planning, including new recipes

The first release supports a deliberate mix of **saved recipes and new AI-generated recipe drafts**. Users can choose saved-only, generated-only or a mix when planning. The website AI adapter is part of v1, and the ChatGPT host model can propose recipes through MCP; both routes use the same Munch validation and persistence rules.

- Default to a seven-day local-date window with flexible start date; support selected meals (e.g. dinners only), servings, repeats, household scope, meal dates, preparation limits and objective-aligned targets.
- Provide a user-editable planning profile for allergies and hard exclusions; dislikes, likes, cuisine and flavor preferences; easy-to-cook/difficulty preference; prep and total-time limits; household servings; available equipment and preferred/avoided cooking methods; repeat tolerance and variety. Users can skip setup, edit the profile on either surface, and override it for one plan.
- Munch supplies the model with the authorized user's relevant saved-recipe summaries (such as title, ingredients, cuisine, primary protein, time and methods) and recent committed meal-plan history. Use only the scoped context needed for the request. This context helps avoid repeating saved or recently planned meals and helps the model suggest genuinely different options.
- Avoid exact and near-duplicate recipes using server-side normalized title, ingredient and recipe-tag comparisons. Apply variety across primary protein, cuisine, key ingredients and cooking method when compatible choices exist; do not default to chicken-and-rice. Let the user allow favorites/repeats or prioritize a requested dish. Do not promise absolute novelty when the recipe library or constraints are sparse.
- The model may select saved recipe revisions and return new recipes as structured drafts with ingredient quantities/units, servings, steps, prep/cook times, difficulty, equipment and tags. Users can edit the candidate recipe and meal slot before committing.
- Hard constraints: allergies and explicitly excluded ingredients, household access, valid immutable recipe revisions, available equipment when the user requires it, and specified meal/date bounds. Known allergen matches and unresolved allergen ingredients block a candidate. Never claim a generated recipe is allergy-safe based only on its text; remind users to verify product labels and cross-contact conditions. Allergy uncertainty must be surfaced, not silently downgraded.
- Soft preferences: favorite meals, disliked ingredients, cuisine/flavor variety, protein proximity, pantry matching when authorized, cooking skill, preparation time and grocery efficiency.
- The deterministic server resolves generated ingredients and calculates nutrition from existing trusted sources. Ignore model-supplied calories/macros. If an ingredient or nutrient cannot be resolved, show partial/unavailable nutrition and never claim target compliance. The scorer evaluates validated candidates and daily totals; the model cannot declare compliance itself.
- With insufficient compatible saved/generated recipes, return an honest partial plan and actionable unmet requirements rather than silently dropping constraints or fabricating nutrition.
- ChatGPT flow: get authorized profile and library context -> host proposes saved recipe IDs/revisions and/or structured generated drafts -> Munch validates and returns an editable draft -> user reviews/edits -> user explicitly commits.
- Website flow: "Generate week" -> Munch gathers bounded authorized context -> `MUNCH_AI_MODEL` proposes saved selections and/or generated recipe drafts -> the same validator/draft service -> editable calendar -> explicit commit. Users can also plan manually if AI is unavailable, over budget, declined or disabled.
- After the plan is committed, offer a separate review of grocery-list additions. Reconcile duplicates, exclude already-purchased items where supported, require a distinct confirmation, and never infer pantry consumption.

### 7.3 Meal swaps

- Offer 3–5 verified replacements for a specific **planned** meal (not historical consumption), ranked on nutrition similarity, hard dietary constraints, pantry availability, preparation time and user preferences.
- Show old vs new calories/protein, change to that day's target totals, time, missing ingredients and nutrition coverage.
- "Swap only this meal" is default. "Change future repeated occurrences" is an explicitly separate multi-item operation with its own review.
- Preview does not mutate anything; apply requires user confirmation, expected version and idempotency key.
- Plan history supports undo where safe; concurrency conflicts produce a non-destructive refresh path.

### 7.4 Weekly check-ins

Reuse `buildDailyBuckets`, `computeTrends`, `computeWeeklyDigest` and weight trends but implement a new structured analysis contract instead of parsing narrative text.

Show:

- period and timezone;
- days with any logging, percentage of target coverage, missing macro fields, uncertain estimates and source confidence;
- calories/protein and hydration on **recorded days**, clear denominator and separate total-period view when useful;
- weight trend based only on measurement dates and uncertainty;
- planned versus actually logged food, without falsely treating any scheduled meal as consumed;
- 1–3 evidence-based observations and optional next-week planning actions.

No moralizing "best/worst person" language or false certainty from incomplete logs. If a day is missing, say "not recorded." If there is insufficient evidence, omit automatic goal suggestions. Generate on demand; optional snapshots/push later.

### 7.5 Daily guidance

Provide a compact Today summary: goal and logged amounts, planned meals, remaining **recorded** nutrition context, hydration status, likely meal-prep needs, and one or two optional next actions. Do not frame unrecorded calories as exact remaining allowance. Allow user to dismiss guidance and hide it if data is sparse.

A minimal deterministic daily summary should work if website AI is disabled. ChatGPT can converse about the same factual context. No scheduled AI calls in v1.

## 8. Surface-specific UX acceptance

### MCP + ChatGPT

- Responses are useful in plain text if widgets fail or are disabled.
- Inline `goal-change` widget shows old/new values, rationale and a review/confirm action; no accidental "apply" from simply viewing.
- `guided-plan` widget has a seven-day overview, editable saved/generated recipe slots, recipe details and preference warnings, daily totals, data-coverage warnings, Confirm/Cancel. Request fullscreen when screen density requires; keep mobile usable.
- `plan-swap` widget compares verified candidates and re-renders after action.
- `weekly-checkin` uses compact trend/status visualization with clear "recorded days" coverage.
- Widget requests use host-approved APIs and existing CSP/resource versioning, no secret or credential exposure, no price/checkout/premium promotions, no medical claims.
- Follow current MCP Apps guidance for UI resource metadata; avoid assuming the platform automatically grants fullscreen or sidebar capabilities to this plugin.
- Keep existing widget templates, CSP checks, user preferences, reviewer account workflow and skill/metadata freeze policies functioning.

### Website

- Today: expandable daily-guidance summary, not a wall of coaching cards.
- Plan: clear week/month navigation, editable preference/equipment profile and per-plan overrides, Generate / Review / Commit, saved-or-new recipe choice, editable generated recipe details, per-meal swap, daily totals, missing-data notices, undo, responsive small-screen editing, and a separate confirmed grocery-list action.
- Insights: structured weekly check-in with logging coverage and historical target context.
- Goals: explicit "Review targets" and opt-in adjustment suggestion; show change history and disable toggle.
- Prefer existing `public/app.html`, `public/app.js`, `public/app-api.js`, `public/styles.css` structure; extract features modularly where maintainability demands it.
- Loading, empty, denied, stale, partial, error and offline states must be designed, not improvised.
- Website users can finish each workflow manually if model generation fails or declines.

## 9. Release-gating parity contract

Extend `src/capability-manifest.ts` with explicit outcomes:

```text
guidance.preferences
guidance.goalPreview
guidance.goalCommit
guidance.goalHistory
mealPlan.draftCreate
mealPlan.draftEdit
mealPlan.draftCommit
mealPlan.recipeGenerate
mealPlan.recipeCustomize
mealPlan.groceryPreview
mealPlan.groceryCommit
mealPlan.swapPreview
mealPlan.swapCommit
mealPlan.swapUndo
nutrition.weeklyCheckin
nutrition.dailyGuidance
```

For each, record MCP and website entry points, coverage, source-of-truth service, tests and documented exception only where genuinely surface-specific. Add corresponding `src/mobile/capabilities.ts` declarations; use `planned` when not actually built.

**Mandatory PR gate:** Feature PRs that introduce a new product outcome must include shared service + both MCP and website workflows, or be feature-flagged dark on all customer surfaces with a named follow-up implementation owner. CI should fail if (a) a registered MCP tool lacks an outcome map, (b) a new capability lacks website coverage or a documented intentional exception, (c) mobile declaration is missing, or (d) cross-surface behavior tests for a shipped feature are absent. Do not permit a permanent `partial` designation to evade release requirements.

Test at the **same persisted account state**, not parallel hand-coded mock outputs:

1. Create plan in MCP, read/edit on web, read updated plan in MCP.
2. Create plan on web, read/swap in MCP, read updated plan on web.
3. Preview/commit goal change via either route; historical effective date and revision must agree.
4. Repeat identical commit request: one logical mutation.
5. Stale version: conflict without overwriting other client's change.
6. A preference profile edited on one surface is honored by generation on the other.
7. Saved-only, generated-only and mixed plans honor the same hard constraints and nutrition validator.
8. Exact/near-duplicate saved or recently committed recipes are avoided unless the user allows repeats; variety responds to profile preferences.
9. Allergy matches/unknown ingredients and unavailable required equipment block or clearly qualify a generated recipe.
10. Generated nutrition is calculated by Munch; model-supplied macros cannot bypass validation.
11. Grocery additions are previewed and committed only after separate confirmation.
12. One client lacks premium/household permission: both reject consistently.
13. Uncertain nutrition: both return partial/unavailable, neither claims a met target.
14. Explicit logout/revocation and account deletion: no orphaned guidance data.
15. Plugin widget disabled: conversational fallback still allows outcome.
16. No-data period: neither client pretends the user ate zero or missed dietary obligations.

## 10. Delivery plan — small, reviewable PRs

### PR -1 — Existing-product test audit and baseline

Complete this before feature implementation so new work starts from a verified quality baseline.

- Reconfirm current `main`, open PRs, production revision, test workflows and dependency/runtime versions.
- Maintain and refresh `docs/testing/current-test-audit.md` with a capability-to-test map for nutrition logging/history/goals, recipes/import, planning/groceries, pantry, Cooks, auth/billing/households, website, MCP and mobile. For each capability record unit/contract, database, browser/device, and release-smoke coverage plus the CI trigger and latest evidence.
- Run and record the current-main baseline for `bun run format:check`, `bun run typecheck`, `bun run submission:check`, `bun test`, the PostgreSQL integration/smoke job, OAuth/mobile auth and Android build. Record skipped or secret-dependent checks honestly.
- Add coverage reporting for the unit suite and measure a baseline. Set a risk-based ratcheting threshold for new shared domain code after seeing the report; do not claim a repo-wide percentage before measuring it.
- Close high-risk gaps that affect this release before feature PRs. Add a real browser E2E harness for prioritized authenticated website workflows and reuse it for the new features. Keep static UI checks as a separate, faster layer.
- Review Android support expectations and add a representative emulator/device smoke only if the app's current support contract requires it; document the current build-only limits either way.
- Review manual and scheduled provider/corpus workflows for cost, reproducibility, result artifacts and clear release-gate criteria.
- Acceptance: the test map and baseline report are committed; high-risk existing failures are fixed or explicitly tracked; a future feature PR cannot claim website/MCP parity based only on matching unit fixtures.

### PR 0 — Contract and parity gate (nonfeature foundation)

- Update ADR-0011 and capability/CI scaffolding to require user-outcome parity on release.
- Introduce guidance capability IDs with `partial`/dark status during implementation, owned by named PRs. Do not advertise incomplete outcomes.
- Add shared request/response schemas, status/error conventions and fixture builders.
- Preserve current 90-tool baseline test semantics when mappings grow; replace brittle hard-coded counts with contract-derived assertions and an explicit expected catalog snapshot where warranted.
- Deliver working CI tests for classification, mobile declaration and dark-feature visibility.
- Acceptance: existing endpoints and MCP behavior unchanged; parity gate catches deliberate missing implementation in a fixture.

### PR 1 — Preferences, versioned targets, data-quality baseline

- SQL migrations, forced RLS, repositories, preference/equipment/variety profile UI and MCP read/update access.
- Goal-revision persistence, objective-aware target context, coverage-aware week calculations, retention/export/deletion.
- Explicit behavior for missing nutrition, units and historical goals; correct faulty weekly averaging/denominators in new structured output.
- Acceptance: manual goal changes work on both surfaces, revisions auditable, same numeric summaries, no AI inference.

### PR 2 — User-controlled goal suggestions

- Proposal/preview/evidence thresholds, conservative configurable bounds, opt-in setting, approve/reject, stale-proposal handling.
- MCP tool and widget, website Goals UI and tests.
- Complete nonmedical product-policy review, including updated docs/terms/listing if needed, before exposing as automatic suggestions.
- Acceptance: zero silent target changes; insufficient data visibly blocks auto-suggestions; old revision retained.

### PR 3 — Weekly draft planning and validation engine

- Candidate ranking/scoring, saved-recipe selection, structured AI-generated recipe drafts, allergy/equipment/dietary constraints, duplicate/variety checks, nutrition coverage, draft header/items, transactional commit and conflict handling.
- MCP planning context/create/review/commit and generated-recipe widget; website AI-assisted and manual draft-first planner with equivalent controls.
- Use existing recipes, immutable revisions and existing `planned_meals`.
- Acceptance: seven-day eligible schedule with true daily totals, editable draft, no logged consumption/pantry/grocery changes, idempotent commit.

### PR 4 — Website AI proposal adapter

- After PR 3's deterministic planner works, add the website AI proposal adapter behind `MUNCH_AI_MODEL` as a v1 capability; enforce JSON schema, timeouts, token/cost caps, model-call telemetry, circuit breaker and manual fallback.
- Test prompts against malformed results, injected instructions embedded in recipes, nonsensical macronutrients, allergy exclusion violations and empty catalog.
- Acceptance: same validation/commit outcome whether proposals originated from ChatGPT, website AI or manual selection. MCP path never invokes the website model.

### PR 5 — Meal swap + edit/undo lifecycle

- Targeted planned-item update/unschedule, version conflict guards, swap candidate ranking, comparison, approval, undo and audit trail.
- MCP controls and inline comparison UI; website per-meal swap/edit.
- Acceptance: one planned meal changes atomically; old historic logged meal unaffected; both channels show same day-total delta and undo status.

### PR 6 — Structured weekly check-in

- Extend existing insight engine with schema-based weekly readouts, coverage and historical goal snapshots.
- MCP read/tool/widget and website Insights view.
- Acceptance: missing day is unknown not zero; provenance displayed; logged-versus-planned disambiguation; weekly summaries are identical in underlying numerics across channels.

### PR 7 — Concise daily guidance

- Shared daily service and Today web panel; MCP direct status/get-guidance; optional widget if it clearly adds utility.
- No notifications or scheduled model workloads.
- Acceptance: deterministic useful status without AI; sparse data doesn't produce false coaching.

### PR 8 — End-to-end certification and staged release

- Scenario tests with actual DB/auth for all five outcomes; MCP client protocol smoke; website browser test at phone and desktop widths; widget host/CSP tests; generated-recipe, preference, variety and grocery-confirmation journeys; local migration and postdeploy smoke.
- Audit docs, submission manifest, reviewer seeded account, privacy/terms, analytics and feature flags.
- Railway deploy pinned exact SHA, validate health + identity, then enable in staged cohort. Preserve existing plugin tool schemas/resources until new tool scans have approved additions.
- Release is complete only when MCP and website customer outcomes are certified; mobile status remains honest.

**Parallelism:** PR 0/1 before feature branches. PR 3 can overlap PR 2 after shared contracts settle. PR 5 depends on draft/committed plan lifecycle; PR 6/7 can follow baseline contracts in parallel. Do not merge conflicting schema changes out of order.

## 11. Reliability, security and economics

- **Authorization:** derive identity from authenticated MCP/session, never client-supplied user IDs; enforce user/household RLS; honor existing capability resolver and subscription-source entitlements uniformly.
- **Strong writes:** explicit user confirmation, immutable proposal references, optimistic locking (`version`), idempotency keys, atomic transactions and audit trails.
- **Privacy:** limit AI context to data required for a plan; strip household data outside authorized scope; don't log raw meal histories, tokens, allergy descriptions or secrets in telemetry. Avoid clinical data intake.
- **Observability:** instrument candidate counts, draft acceptance, plan conflict, score/coverage failures, swap use, failed AI proposals, p50/p95 latency and model spend. No personal contents in metrics labels.
- **Cost:** no always-on workers/cron or automatic recurrent AI generation in v1. Prefer deterministic ranking and cached food-provider results. Cache only safe nonpersonal/shared catalog data broadly; partition account-specific context. Use token/model quotas and manual fallback on website.
- **Failure behavior:** source lookup unavailable -> return partial candidate/validation errors, not made-up nutrition. AI provider unavailable -> manual planner. No pantry entitlement -> proceed without pantry scoring. Widget load failure -> text/tool experience. Database conflict -> user-visible refresh, not lost updates.
- **Accessibility:** keyboard, contrast, readable mobile labels, screen reader announcements, accessible modal actions, stable loading/empty states.
- **Health framing:** Munch is a general consumer wellness/food record tool, not healthcare or medical advice. Avoid diagnoses, treatments, disease-specific diets, medical credentials and unqualified calorie prescriptions. If eligibility/review guidance conflicts with target-advice feature, safely degrade to user-managed targets.

## 12. Test plan and merge criteria

Run existing `bun run format:check`, `bun run typecheck`, `bun run submission:check`, `bun test` plus existing commerce and privacy/host-model-boundary checks. Review the full GitHub CI workflows for fresh DB migration/idempotency, OAuth browser smoke, widget CSP, generated submission and production image build.

Add dedicated tests:

- pure score invariants, unit conversions and nutrition provenance;
- partial/missing nutrient handling and incomplete tracking denominator;
- hard exclusions, allergen-unknown block and label/cross-contact caveat;
- preference-profile persistence, per-plan overrides and cross-surface read-after-write;
- saved/generated/mixed recipe modes, exact/near-duplicate avoidance and variety behavior;
- required-equipment compatibility and difficulty/time constraint validation;
- generated recipe schema validation, ingredient resolution, computed nutrition and user edit/commit lifecycle;
- grocery-list preview, duplicate reconciliation and separate confirmation;
- draft state transitions, merge/replace policy, rollback, duplicate requests;
- cross-account and household membership changes with forced RLS;
- concurrency and stale-proposal/version errors;
- historically correct target revisions;
- no accidental meal logging or pantry subtraction during planning;
- no external AI calls via MCP transitive dependency graph;
- low-model-budget/timeout/provider-error website fallback;
- widget content validation, mobile viewport usability and CSP/resource version;
- both directions of real persisted web↔MCP parity, including read-after-write.

**Definition of done per PR:** source/tests/documentation/migrations/security parity evidence; no partial app features accidentally visible. For release: all feature flags checked, production SHA verified, reviewer test account usable, no pricing/subscription offers in plugin UI, automated MCP scan status checked, rollback instructions documented and existing customer workflows unaffected.

## 13. Risk register / decisions taken

1. **Nutrition target advice vs existing scope:** user-owned manual targets and reviewable proposals only; nonclinical policy gate required; ship manual target comparison if automated suggestion is unreviewable.
2. **Incomplete meal nutrition:** never mark compliance when key macros unresolved; show unavailable/partial and data coverage.
3. **Host-model variation:** constrain to structured candidate references; server performs deterministic validation for all channels.
4. **Sparse recipe library or weak personalization data:** allow validated AI-generated drafts, disclose uncertainty and offer profile controls; never invent ingredient nutrition or claim dietary/allergy compliance. Compare candidates with saved recipes and committed plan history to reduce repeats.
5. **Household scope and billing:** existing premium/seat permissions remain authoritative; no new pricing surfaces inside MCP.
6. **Stale plugin metadata:** staged, backward-compatible schemas; approved tools/resources unchanged until scans; plugin rescan after deployment and approval verified.
7. **Mobile parity:** mandatory declarations and honest planned status, but do not misrepresent unfinished Android/iOS as certified.
8. **Scope inflation:** exclude workouts, coach marketplace, social features, proactive notifications, wearable ingestion and autonomous target editing from v1.
9. **Drifting current repo:** implementation agent rechecks HEAD, PRs, migrations and released MCP catalog before modifying code.

## 14. User-journey acceptance script

**Scenario A — initial personalized plan**
"Use my goals and preferences to plan weekday dinners next week, high protein, under 30 minutes. Avoid my dislikes, use only equipment I have, and make the meals varied."
Expected: retrieve the authorized profile, saved recipes and relevant plan history; propose a mix of saved and genuinely different generated recipes; validate allergens, equipment and nutrition; let the user edit the draft; commit only on approval; offer grocery additions separately; website calendar reflects the same plan.

**Scenario B — a swap**
"Thursday's dinner takes too long; replace it with something simpler."
Expected: show 3–5 verified alternatives and calorie/protein difference; user confirms one; only Thursday's planned item changes; web and MCP agree; optional undo.

**Scenario C — weekly review**
"How did I do last week?"
Expected: report exactly which days were recorded, estimates/missing data, logged food vs targets at effective historical goal, optionally compare weight trend if enough records; no inference that missing logs mean fasting.

**Scenario D — review goals**
"I've been losing weight steadily. Should my calorie target change?"
Expected: explain available evidence, uncertainties and nonmedical limits; only offer a preview if opt-in/evidence permits; never change current goal without explicit approval.

**Scenario E — website independence**
User signs into website without connecting ChatGPT. Expected: they can set goals/preferences/equipment, use website AI or plan manually, generate and customize a recipe, swap an item, review groceries separately, view the same weekly check-in and daily guidance, and export/delete records.

**Scenario F — allergy, equipment and novelty**
User has a tree-nut allergy, dislikes chicken, owns a pressure cooker and stovetop, and prefers easy meals. Expected: generated candidates exclude known and unresolved allergen ingredients, avoid chicken unless the user overrides the dislike, require only available equipment, favor easy preparation, and are compared with saved and recently committed recipes to avoid near-duplicates. The UI never guarantees packaged-food or cross-contact safety.

**Scenario G — objective-based goal guidance**
User switches between maintain and lose objectives and asks to review targets. Expected: Munch explains which objective and evidence support any proposed target change; the plan uses the active target context; no numeric goal changes without an explicit, version-checked approval.

## 15. Handoff instructions for coding agent

You are implementing this specification in `michaelhmiv/Munch`, not building a second app. Begin by fetching the latest main branch, examining current PR/deploy state, confirming current migration and authoritative feature flags, and reading the referenced ADRs. Treat this document as a product/architecture contract, but adjust example endpoint/file names to the current codebase.

Proceed in the staged PR order, writing real code and tests, not just architectural documents. Keep `main` production-safe; do not merge failed or incomplete PRs. Use existing source-of-truth services, auth, RLS, entitlements, shared frontend assets, MCP widget conventions, model boundary and CI tests. The plugin is the primary user interaction; the authenticated website must have full capability parity for every released user outcome. Add mobile declarations but do not falsely claim mobile certification. Preserve the current plugin's existing published/reviewer contracts and do not modify public listing or deploy breaking new tools without the correct scan/review process.

When completing each PR, report: changed files, domain behavior, MCP and web user paths, security/parity test results, known limitations and actual CI outcome. Do not claim tests passed unless they ran. Make independent implementation decisions within these fixed constraints, document any unavoidable divergence, and require release-gate certification before declaring the complete program finished.

## References

- Repository: https://github.com/michaelhmiv/Munch
- Existing outcome parity ADR: `docs/architecture/0011-cross-surface-capability-contracts.md`
- Mobile parity ADR: `docs/architecture/0012-mobile-product-surfaces.md`
- Host/website AI boundary: `docs/host-ai-mcp-boundary.md`
- Existing parity audit: `docs/mcp-website-parity-audit.md`
- Munch plugin checklist: `docs/openai-submission/release-checklist.md`
- OpenAI plugin UI guidelines: https://developers.openai.com/plugins/concepts/ui-guidelines
- OpenAI plugin MCP server docs: https://developers.openai.com/plugins/build/mcp-server
- OpenAI plugin submission/change scans: https://developers.openai.com/plugins/deploy/submission
- OpenAI MCP Apps UI reference: https://developers.openai.com/plugins/reference
- NIDDK Body Weight Planner: https://www.niddk.nih.gov/health-information/weight-management/body-weight-planner
- FDA food-allergy information: https://www.fda.gov/food/buy-store-serve-safe-food/food-allergies-what-you-need-know
