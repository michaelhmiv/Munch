import { z } from "zod";
import { resolveMunchCapabilities } from "./billing/capabilities.js";
import {
    requirePlanningAccess,
    requirePlanningScope,
} from "./mcp-capability-guard.js";
import {
    cancelGuidedPlanDraft,
    commitGoalChange,
    commitGuidedPlanDraft,
    commitMealSwap,
    confirmGuidedPlanGroceries,
    createGuidedPlanDraft,
    getDailyGuidance,
    getGoalReviewReadiness,
    getGuidanceContext,
    getGuidedPlanDraft,
    getWeeklyGuidance,
    listGoalHistory,
    previewGoalChange,
    previewGuidedPlanGroceries,
    previewMealSwaps,
    undoMealSwap,
    updateGuidancePreferences,
    updateGuidedPlanDraft,
} from "./guidance-repository.js";
import {
    generatedRecipeSchema,
    guidancePreferencesSchema,
    goalTargetsSchema,
    planItemSchema,
    planningPreferenceOverridesSchema,
} from "./guidance/contracts.js";
import { checkRecipeConstraints } from "./guidance/domain.js";

type GuidanceToolServer = {
    registerTool: (
        name: string,
        config: unknown,
        handler: (args: any) => unknown,
    ) => unknown;
};

function result(value: unknown) {
    const structuredContent =
        value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : { result: value };
    return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent,
    };
}

async function planningScope(
    userId: string,
    scope: "personal" | "household",
    write: boolean,
) {
    const capabilities = await resolveMunchCapabilities(userId);
    return requirePlanningScope(scope, capabilities, write);
}

async function assertDraftAccess(
    userId: string,
    draftId: string,
    write: boolean,
) {
    const draft = await getGuidedPlanDraft(userId, draftId);
    if (!draft) throw new Error("Plan draft was not found");
    await planningScope(userId, draft.scope.type, write);
    return draft;
}

export function registerGuidanceTools(
    server: GuidanceToolServer,
    userId: string,
) {
    const register = (
        name: string,
        title: string,
        description: string,
        inputSchema: Record<string, unknown>,
        handler: (args: any) => Promise<unknown>,
        readOnly = true,
    ) =>
        server.registerTool(
            name,
            {
                title,
                description,
                inputSchema,
                annotations: {
                    readOnlyHint: readOnly,
                    destructiveHint: false,
                    idempotentHint: readOnly,
                    openWorldHint: false,
                },
            },
            async (args) => result(await handler(args)),
        );

    register(
        "get_guidance_context",
        "Get Guidance Context",
        "Read the user's saved nutrition guidance preferences, current goal targets, saved recipes, recent committed meal-plan history, and current calendar plan. Does not call an AI provider or make changes.",
        { scope: z.enum(["personal", "household"]).default("personal") },
        async ({ scope }) =>
            getGuidanceContext({
                userId,
                scope: await planningScope(userId, scope, false),
            }),
    );
    register(
        "set_guidance_preferences",
        "Set Guidance Preferences",
        "Save the user's explicit guidance objective and recipe preferences. Requires confirmation and an optional expected version to prevent overwriting changes from another surface.",
        {
            preferences: guidancePreferencesSchema,
            expected_version: z.number().int().nonnegative().optional(),
            confirm: z.boolean(),
        },
        async (args) => {
            if (!args.confirm)
                throw new Error(
                    "Explicit confirmation is required to save guidance preferences",
                );
            return updateGuidancePreferences(
                userId,
                args.preferences,
                args.expected_version,
                "mcp",
            );
        },
        false,
    );
    register(
        "get_goal_review",
        "Review Goal Readiness",
        "Read current user-selected nutrition targets, objective and recorded-data coverage. This tool does not prescribe targets.",
        {},
        async () => getGoalReviewReadiness(userId),
    );
    register(
        "get_goal_history",
        "Get Goal History",
        "Read the user's confirmed nutrition-goal and objective history.",
        { limit: z.number().int().min(1).max(50).optional() },
        async ({ limit }) => listGoalHistory(userId, limit),
    );
    register(
        "preview_goal_change",
        "Preview Goal Change",
        "Compare user-entered daily targets with the current revision. Previewing does not change targets; use commit_goal_change only after the user explicitly confirms.",
        {
            targets: goalTargetsSchema,
            idempotency_key: z.string().min(8).max(120),
            rationale: z.array(z.string().max(200)).max(6).optional(),
        },
        async (args) =>
            previewGoalChange({
                userId,
                targets: args.targets,
                idempotencyKey: args.idempotency_key,
                rationale: args.rationale,
            }),
        false,
    );
    register(
        "commit_goal_change",
        "Commit Goal Change",
        "Apply a previously previewed goal change after the user confirms. Stale goal revisions return a conflict and require a new preview.",
        {
            proposal_id: z.string().uuid(),
            expected_revision: z.number().int().nonnegative(),
            idempotency_key: z.string().min(8).max(120),
            confirm: z.boolean(),
        },
        async (args) =>
            commitGoalChange({
                userId,
                proposalId: args.proposal_id,
                expectedRevision: args.expected_revision,
                idempotencyKey: args.idempotency_key,
                confirm: args.confirm,
                origin: "mcp",
            }),
        false,
    );
    register(
        "get_weekly_checkin",
        "Get Weekly Check-in",
        "Summarize recorded meal and hydration data for a local date range, with coverage and historical goal context. Missing records are unknown, not zero.",
        {
            start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            timezone: z.string().max(100).optional(),
        },
        async (args) =>
            getWeeklyGuidance({
                userId,
                startDate: args.start_date,
                endDate: args.end_date,
                timezone: args.timezone,
            }),
    );
    register(
        "get_daily_guidance",
        "Get Daily Guidance",
        "Read a concise daily status based only on logged meals, hydration and separately identified planned meals. Does not invent consumption.",
        { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
        async ({ date }) => getDailyGuidance({ userId, date }),
    );
    register(
        "create_meal_plan_draft",
        "Create Meal Plan Draft",
        "Create an editable one-to-seven-day plan draft from saved recipe revisions and/or host-proposed recipe details. Nutrition is resolved by Munch. Draft creation does not schedule meals.",
        {
            start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            timezone: z.string().min(1).max(100),
            scope: z.enum(["personal", "household"]).default("personal"),
            household_id: z.string().uuid().optional(),
            mode: z.enum(["saved_only", "generated_only", "mixed"]),
            preferences_override: planningPreferenceOverridesSchema.optional(),
            allow_repeats: z.boolean().optional(),
            replace_existing: z.boolean().default(false),
            idempotency_key: z.string().min(8).max(120),
            items: z.array(planItemSchema).min(1).max(35),
        },
        async (args) => {
            const selectedScope = await planningScope(userId, args.scope, true);
            if (
                args.scope === "household" &&
                args.household_id &&
                args.household_id !==
                    (selectedScope as { householdId: string }).householdId
            ) {
                throw new Error(
                    "Household scope is unavailable for this connection",
                );
            }
            return createGuidedPlanDraft(
                {
                    ...args,
                    household_id:
                        args.scope === "household"
                            ? (selectedScope as { householdId: string })
                                  .householdId
                            : undefined,
                },
                userId,
            );
        },
        false,
    );
    register(
        "get_meal_plan_draft",
        "Get Meal Plan Draft",
        "Read a guided plan draft and its nutrition-resolution status, constraints and warnings.",
        { draft_id: z.string().uuid() },
        async ({ draft_id }) => assertDraftAccess(userId, draft_id, false),
    );
    register(
        "validate_meal_plan_recipe",
        "Validate Meal Plan Recipe",
        "Validate a host-proposed recipe's structure and compare its ingredients and equipment with the saved guidance preferences. Munch does not call a model provider here or accept model-supplied nutrition; submit it to a plan draft to resolve nutrition.",
        { recipe: generatedRecipeSchema },
        async ({ recipe }) => {
            await planningScope(userId, "personal", false);
            const proposal = generatedRecipeSchema.parse(recipe);
            const context = await getGuidanceContext({ userId });
            return {
                recipe: proposal,
                ...checkRecipeConstraints(proposal, context.preferences),
                nutrition_status: "unresolved",
                note: "Nutrition is calculated by Munch only after the recipe is added to a plan draft.",
            };
        },
    );
    register(
        "update_meal_plan_draft",
        "Update Meal Plan Draft",
        "Replace the items in an uncommitted plan draft after reviewing recipe details and warnings. Requires the current draft version.",
        {
            draft_id: z.string().uuid(),
            expected_version: z.number().int().positive(),
            items: z.array(planItemSchema).min(1).max(35),
            preferences_override: planningPreferenceOverridesSchema.optional(),
        },
        async (args) => {
            await assertDraftAccess(userId, args.draft_id, true);
            return updateGuidedPlanDraft({
                userId,
                draftId: args.draft_id,
                expectedVersion: args.expected_version,
                items: args.items,
                preferencesOverride: args.preferences_override,
            });
        },
        false,
    );
    register(
        "customize_meal_plan_recipe",
        "Customize Meal Plan Recipe",
        "Replace one recipe proposal in an open plan draft with an edited host-proposed recipe. The shared validator recalculates nutrition and constraints for every item. Requires the current draft version.",
        {
            draft_id: z.string().uuid(),
            expected_version: z.number().int().positive(),
            item_position: z.number().int().nonnegative().max(34),
            generated_recipe: generatedRecipeSchema,
        },
        async (args) => {
            const draft = await assertDraftAccess(userId, args.draft_id, true);
            const item = draft.items.find(
                (entry) => entry.position === args.item_position,
            );
            if (!item) throw new Error("Plan draft item was not found");
            const items = draft.items.map((entry) =>
                entry.position === args.item_position
                    ? {
                          date: entry.date,
                          meal_slot: entry.meal_slot,
                          servings: entry.servings,
                          note: entry.note ?? undefined,
                          generated_recipe: generatedRecipeSchema.parse(
                              args.generated_recipe,
                          ),
                      }
                    : {
                          date: entry.date,
                          meal_slot: entry.meal_slot,
                          servings: entry.servings,
                          note: entry.note ?? undefined,
                          ...(entry.source_type === "saved"
                              ? {
                                    recipe_id: entry.recipe_id!,
                                    recipe_revision_id:
                                        entry.recipe_revision_id!,
                                }
                              : {
                                    generated_recipe:
                                        generatedRecipeSchema.parse(
                                            entry.generated_recipe,
                                        ),
                                }),
                      },
            );
            return updateGuidedPlanDraft({
                userId,
                draftId: draft.id,
                expectedVersion: args.expected_version,
                items,
                preferencesOverride: draft.preferences_override,
            });
        },
        false,
    );
    register(
        "commit_meal_plan_draft",
        "Commit Meal Plan Draft",
        "Schedule every item in a reviewed plan draft. Requires explicit confirmation and the current draft version. Does not mark meals as eaten or add groceries.",
        {
            draft_id: z.string().uuid(),
            expected_version: z.number().int().positive(),
            confirm: z.boolean(),
        },
        async (args) => {
            await assertDraftAccess(userId, args.draft_id, true);
            return commitGuidedPlanDraft({
                userId,
                draftId: args.draft_id,
                expectedVersion: args.expected_version,
                confirm: args.confirm,
            });
        },
        false,
    );
    register(
        "cancel_meal_plan_draft",
        "Cancel Meal Plan Draft",
        "Cancel an open plan draft after explicit confirmation. No calendar changes are made.",
        {
            draft_id: z.string().uuid(),
            expected_version: z.number().int().positive(),
            confirm: z.boolean(),
        },
        async (args) => {
            await assertDraftAccess(userId, args.draft_id, true);
            return cancelGuidedPlanDraft({
                userId,
                draftId: args.draft_id,
                expectedVersion: args.expected_version,
                confirm: args.confirm,
            });
        },
        false,
    );
    register(
        "preview_plan_groceries",
        "Preview Plan Groceries",
        "Preview grocery suggestions for a committed plan. Adding items requires a separate confirmation.",
        { draft_id: z.string().uuid() },
        async ({ draft_id }) => {
            const draft = await assertDraftAccess(userId, draft_id, false);
            return previewGuidedPlanGroceries(userId, draft.id);
        },
    );
    register(
        "confirm_plan_groceries",
        "Confirm Plan Groceries",
        "Add selected grocery suggestions after a separate explicit confirmation. This does not change pantry inventory or mark foods eaten.",
        {
            draft_id: z.string().uuid(),
            selected_indices: z.array(z.number().int().nonnegative()).max(60),
            confirm: z.boolean(),
            idempotency_key: z.string().min(8).max(120),
        },
        async (args) => {
            await assertDraftAccess(userId, args.draft_id, true);
            return confirmGuidedPlanGroceries({
                userId,
                draftId: args.draft_id,
                selectedIndices: args.selected_indices,
                confirm: args.confirm,
                idempotencyKey: args.idempotency_key,
            });
        },
        false,
    );
    register(
        "preview_meal_swaps",
        "Preview Meal Swaps",
        "Suggest three to five saved-recipe alternatives and show per-serving nutrient deltas and known day-total changes. Does not apply the swap.",
        {
            planned_meal_id: z.string().uuid(),
            limit: z.number().int().min(3).max(5).optional(),
        },
        async (args) => {
            const capabilities = await resolveMunchCapabilities(userId);
            requirePlanningAccess(capabilities, "all", false);
            return previewMealSwaps({
                userId,
                plannedMealId: args.planned_meal_id,
                limit: args.limit,
            });
        },
    );
    register(
        "commit_meal_swap",
        "Commit Meal Swap",
        "Apply a selected saved-recipe swap after explicit confirmation and a planned-meal version check.",
        {
            planned_meal_id: z.string().uuid(),
            recipe_id: z.string().uuid(),
            recipe_revision_id: z.string().uuid(),
            expected_version: z.number().int().positive(),
            confirm: z.boolean(),
            idempotency_key: z.string().min(8).max(120),
        },
        async (args) => {
            const capabilities = await resolveMunchCapabilities(userId);
            requirePlanningAccess(capabilities, "all", true);
            return commitMealSwap({
                userId,
                plannedMealId: args.planned_meal_id,
                recipeId: args.recipe_id,
                recipeRevisionId: args.recipe_revision_id,
                expectedVersion: args.expected_version,
                confirm: args.confirm,
                idempotencyKey: args.idempotency_key,
            });
        },
        false,
    );
    register(
        "undo_meal_swap",
        "Undo Meal Swap",
        "Restore the previous recipe only if the planned meal has not changed since the swap. Requires explicit confirmation.",
        {
            change_id: z.string().uuid(),
            expected_version: z.number().int().positive(),
            confirm: z.boolean(),
            idempotency_key: z.string().min(8).max(120),
        },
        async (args) => {
            const capabilities = await resolveMunchCapabilities(userId);
            requirePlanningAccess(capabilities, "all", true);
            return undoMealSwap({
                userId,
                changeId: args.change_id,
                expectedVersion: args.expected_version,
                confirm: args.confirm,
                idempotencyKey: args.idempotency_key,
            });
        },
        false,
    );
}
