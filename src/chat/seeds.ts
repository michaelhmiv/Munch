import {
    getMealHistoryWorkspace,
    getTodayWorkspace,
} from "../app/repository.js";
import {
    allergenMatchesForIngredients,
    objectiveLabel,
} from "../guidance/domain.js";
import { getGuidancePreferences } from "../guidance-repository.js";
import {
    CHAT_SURFACE_FEATURE_MODULES,
    DEFAULT_FEATURE_MODULES,
    type FeatureModules,
} from "../feature-modules.js";
import { getFeatureModules } from "../feature-modules-repository.js";
import {
    evaluateRecipeAvailability,
    normalizeInventoryName,
} from "../inventory/matching.js";
import { listSavedRecipesWithIngredients } from "../inventory/meal-planning.js";
import { getPantry } from "../inventory/repository.js";
import { getProfile } from "../nutrition-platform/profiles.js";
import { getMealPlan } from "../planning/repository.js";
import { getNutritionGoals } from "../storage.js";
import { dateInTz } from "../tz.js";
import type { ChatEntrySurface } from "./repository.js";

/**
 * Chat v2 entry seeds (Contextual-only placement, brief Rulings
 * addendum 4; concept-2 pattern from the placement comparison book).
 *
 * A conversation opened from a surface entry starts already knowing
 * that surface's context: the client renders a CONTEXT ATTACHED
 * strip with this module's one-line summary, a deterministic opener
 * written from the same live data, and starters derived from it.
 * The structured `data` payload rides along on every send in the
 * conversation as the agent's entry_seed, re-assembled per send so
 * it never goes stale.
 *
 * Everything here is gathered by code from the same repositories the
 * surfaces themselves read — the model never assembles its own seed.
 * Each gatherer fails soft: a section that cannot be read produces a
 * plainer seed, never an error that blocks the conversation.
 */

export interface ChatEntrySeed {
    surface: ChatEntrySurface;
    summary: string;
    opener: string;
    starters: string[];
    data: Record<string, unknown>;
}

export interface ChatSeedDependencies {
    profile?: (userId: string) => Promise<{ timezone: string | null } | null>;
    today?: typeof getTodayWorkspace;
    goals?: typeof getNutritionGoals;
    history?: typeof getMealHistoryWorkspace;
    pantry?: typeof getPantry;
    plan?: typeof getMealPlan;
    preferences?: typeof getGuidancePreferences;
    recipes?: typeof listSavedRecipesWithIngredients;
    features?: (userId: string) => Promise<FeatureModules>;
}

const MAX_SEED_MEALS = 12;
const MAX_SEED_PANTRY_ITEMS = 40;
const MAX_SEED_HISTORY_MEALS = 14;
const MAX_SEED_RECIPE_CANDIDATES = 8;
const MAX_SEED_LIBRARY_RECIPES = 24;

async function soft<T>(run: () => Promise<T>): Promise<T | null> {
    try {
        return await run();
    } catch (error) {
        console.warn("Chat seed section failed; continuing without it", {
            errorName: error instanceof Error ? error.name : "unknown",
        });
        return null;
    }
}

function shiftDate(date: string, days: number): string {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function weekdayName(date: string): string {
    return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
        weekday: "long",
        timeZone: "UTC",
    });
}

function kcal(value: number): string {
    return `${Math.round(value).toLocaleString("en-US")} kcal`;
}

const SURFACE_LABEL: Record<ChatEntrySurface, string> = {
    today: "Today",
    meal_plan: "Meal Plan",
    pantry: "Pantry",
    insights: "Insights",
};

export function entrySurfaceLabel(surface: ChatEntrySurface): string {
    return SURFACE_LABEL[surface];
}

async function todaySeed(
    userId: string,
    date: string,
    deps: ChatSeedDependencies,
): Promise<ChatEntrySeed> {
    const [today, goals] = await Promise.all([
        soft(() => (deps.today ?? getTodayWorkspace)(userId, date)),
        soft(() => (deps.goals ?? getNutritionGoals)(userId)),
    ]);
    const meals = (today?.meals ?? []).slice(0, MAX_SEED_MEALS).map((meal) => ({
        description: meal.description,
        meal_type: meal.meal_type ?? null,
        calories: meal.calories ?? null,
    }));
    const totals = today?.totals ?? null;
    const goalCalories = goals?.daily_calories ?? null;
    const mealCount = today?.meals.length ?? 0;
    const summary = totals
        ? `Today so far: ${kcal(totals.calories)} across ${mealCount} meal${mealCount === 1 ? "" : "s"}${goalCalories ? ` · goal ${kcal(goalCalories)}` : ""}.`
        : "Today's log could not be read just now.";
    const opener =
        mealCount === 0
            ? "Nothing is logged yet today. Tell me what you've eaten and I'll prepare it as a draft for you to confirm — or ask how to shape the rest of the day."
            : `You've logged ${mealCount} meal${mealCount === 1 ? "" : "s"} so far today${totals ? ` — ${kcal(totals.calories)}${goalCalories ? ` against a ${kcal(goalCalories)} goal` : ""}` : ""}. I can log something else, explain the day, or help land dinner.`;
    return {
        surface: "today",
        summary,
        opener,
        starters: [
            "How is today looking against my goals?",
            "What should dinner be to land the day well?",
            "Log what I just ate",
        ],
        data: {
            date,
            meals,
            totals,
            goal_calories: goalCalories,
        },
    };
}

/**
 * The Plan brain seed (plan-brain brief, Part 1).
 *
 * The conversation this seed opens has ONE named job: pantry-first
 * dinner ideas for this week — the synthesis a screen cannot do
 * (this week's plan × pantry on hand × the recipe library × the
 * user's stated goals). The seed assembles that job's material
 * deterministically:
 *
 * - the week's plan (as before — ideas never duplicate a planned
 *   meal, and gaps are where ideas land);
 * - the pantry contents (personal scope), minus any item that
 *   positively matches a stated allergy — allergen stock is not
 *   idea material;
 * - the recipe library as CANDIDATES: each saved recipe screened
 *   through the deterministic hard allergy filter (goals law
 *   rule 5 — a positively-matching recipe is excluded before the
 *   model ever sees it, never left to model discretion) and, when
 *   the pantry was readable, scored against it into the exact
 *   split every idea must name: uses-from-pantry vs to-buy;
 * - the goals context: the user's stated objective, allergies,
 *   never-suggest list, dislikes, likes, and cuisines.
 *
 * GOALS-CONTEXT SEAM: the goals-intake slice is building a shared
 * goals-context module (goals-law addendum rule 6) that assembles
 * intake + stated goals + numeric targets for every AI surface.
 * Until it lands, this seed reads the same sources that module
 * assembles — guidance preferences (the stated-goals record) here,
 * numeric targets via the chat context's goals section on the same
 * send. When the module lands, this gatherer swaps to it; no second
 * context path is introduced.
 *
 * Module-off honesty (feature toggles): Pantry off → no pantry
 * section is gathered and the opener says the conversation cannot
 * plan from the pantry. Recipes off → no candidates. Groceries off
 * → no grocery starter. The allergy filter reports itself in the
 * data (applied or not) instead of failing silently: if the
 * preferences read fails, candidates are NOT screened and
 * `allergy_filter.applied` is false, so the gap is visible rather
 * than implied-safe.
 */
async function mealPlanSeed(
    userId: string,
    date: string,
    deps: ChatSeedDependencies,
    features: FeatureModules,
): Promise<ChatEntrySeed> {
    const endDate = shiftDate(date, 6);
    const [plan, pantry, preferences] = await Promise.all([
        soft(() =>
            (deps.plan ?? getMealPlan)({
                userId,
                startDate: date,
                endDate,
                scope: "all",
            }),
        ),
        features.pantry
            ? soft(() =>
                  (deps.pantry ?? getPantry)({
                      userId,
                      scope: { type: "personal" },
                      limit: MAX_SEED_PANTRY_ITEMS,
                  }),
              )
            : Promise.resolve(null),
        soft(() => (deps.preferences ?? getGuidancePreferences)(userId)),
    ]);
    const days: Array<{
        date: string;
        entries: Array<{ meal_slot: string | null; recipe_name: string }>;
    }> = [];
    for (let offset = 0; offset < 7; offset++) {
        const day = shiftDate(date, offset);
        const entries = (plan ?? [])
            .filter((entry) => entry.planned_date === day)
            .map((entry) => ({
                meal_slot: entry.meal_slot,
                recipe_name: entry.recipe_name,
            }));
        days.push({ date: day, entries });
    }
    const plannedDays = days.filter((day) => day.entries.length > 0).length;
    const firstGap = days.find((day) => day.entries.length === 0);

    const allergies = preferences?.allergies ?? [];
    const allergyFilterApplied = preferences != null;

    // Pantry items that positively match a stated allergy are
    // excluded from the usable stock before anything else reads it.
    let pantryItemsExcludedForAllergy = 0;
    const usablePantryItems = (pantry?.items ?? []).filter((item) => {
        if (
            allergyFilterApplied &&
            allergenMatchesForIngredients([item.name], allergies).length > 0
        ) {
            pantryItemsExcludedForAllergy += 1;
            return false;
        }
        return true;
    });
    const pantryItems = usablePantryItems.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        stock_state: item.stock_state,
        location: item.location,
    }));

    // Recipe candidates: allergy-screened, pantry-split.
    let recipesExcludedForAllergy = 0;
    let candidates: Array<{
        recipe_id: string;
        revision_id: string;
        name: string;
        nutrition_per_serving: {
            calories: number | null;
            protein_g: number | null;
        };
        uses_from_pantry: string[] | null;
        to_buy: string[] | null;
    }> = [];
    if (features.recipes) {
        const library = await soft(() =>
            (deps.recipes ?? listSavedRecipesWithIngredients)({
                userId,
                scope: { type: "personal" },
                limit: MAX_SEED_LIBRARY_RECIPES,
            }),
        );
        const inventory = usablePantryItems.map((item) => ({
            id: item.id,
            name: item.name,
            normalized_name:
                item.normalized_name ?? normalizeInventoryName(item.name),
            quantity: item.quantity,
            unit: item.unit,
            quantity_mode: item.quantity_mode ?? "presence_only",
            stock_state: item.stock_state,
            food_provider: item.food_provider ?? null,
            provider_food_id: item.provider_food_id ?? null,
        }));
        const scored = (library ?? []).flatMap((recipe) => {
            if (
                allergyFilterApplied &&
                allergenMatchesForIngredients(
                    recipe.ingredients.map((ingredient) => ingredient.name),
                    allergies,
                ).length > 0
            ) {
                recipesExcludedForAllergy += 1;
                return [];
            }
            const availability =
                features.pantry && pantry
                    ? evaluateRecipeAvailability(
                          recipe.ingredients,
                          inventory,
                          [],
                      )
                    : null;
            return [
                {
                    recipe_id: recipe.recipe_id,
                    revision_id: recipe.revision_id,
                    name: recipe.name,
                    nutrition_per_serving: {
                        calories: recipe.nutrition_per_serving.calories,
                        protein_g: recipe.nutrition_per_serving.protein_g,
                    },
                    uses_from_pantry: availability
                        ? availability.matched.map((match) => match.ingredient)
                        : null,
                    to_buy: availability
                        ? [
                              ...availability.missing_required,
                              ...availability.shortages.map(
                                  (shortage) => shortage.ingredient,
                              ),
                          ]
                        : null,
                },
            ];
        });
        scored.sort((a, b) => {
            const aBuy = a.to_buy?.length ?? 0;
            const bBuy = b.to_buy?.length ?? 0;
            if (aBuy !== bBuy) return aBuy - bBuy;
            return (
                (b.uses_from_pantry?.length ?? 0) -
                (a.uses_from_pantry?.length ?? 0)
            );
        });
        candidates = scored.slice(0, MAX_SEED_RECIPE_CANDIDATES);
    }

    const goalsContext = preferences
        ? {
              objective: objectiveLabel(preferences.objective),
              allergies: preferences.allergies,
              never_suggest: preferences.excluded_ingredients,
              disliked_ingredients: preferences.disliked_ingredients,
              liked_ingredients: preferences.liked_ingredients,
              cuisines: preferences.cuisines,
          }
        : null;

    const pantryState = !features.pantry
        ? "module_off"
        : !pantry
          ? "unreadable"
          : pantryItems.length > 0
            ? "usable"
            : "empty";
    const topPantryNames = pantryItems.slice(0, 3).map((item) => item.name);

    const summaryParts = [
        plan
            ? `${plannedDays} of 7 days have something planned${firstGap ? ` · ${weekdayName(firstGap.date)} is empty` : ""}.`
            : "This week's plan could not be read just now.",
    ];
    if (pantryState === "usable")
        summaryParts.push(
            `${pantryItems.length} pantry item${pantryItems.length === 1 ? "" : "s"} on hand.`,
        );
    if (features.recipes && candidates.length > 0)
        summaryParts.push(
            `${candidates.length} saved recipe${candidates.length === 1 ? "" : "s"} screened in as dinner candidates.`,
        );
    if (allergyFilterApplied && allergies.length > 0)
        summaryParts.push(
            `Allergy filter on (${allergies.join(", ")}): ${recipesExcludedForAllergy} recipe${recipesExcludedForAllergy === 1 ? "" : "s"} excluded.`,
        );

    const gapLead = firstGap
        ? `This week has a gap on ${weekdayName(firstGap.date)}.`
        : "Every day this week has something planned.";
    let opener: string;
    if (pantryState === "usable") {
        opener = `${gapLead} For dinners, start from your pantry — ${topPantryNames.join(", ")} on hand. Ask for three dinners that use mostly what's here, each with at most a couple of things to buy, or name a night and I'll draft one into the plan and list what's missing for groceries.`;
    } else if (pantryState === "empty") {
        opener = `${gapLead} Your pantry is empty right now, so dinner ideas lean on ${features.recipes ? "your saved recipes" : "new dishes"} with a short buy list. Ask for three dinners for this week, or name a night and I'll draft one in.`;
    } else if (pantryState === "module_off") {
        opener = `${gapLead} Pantry is off in Settings → Features, so I can't plan dinners from what's on hand — ideas will come from ${features.recipes ? "your saved recipes and " : ""}this week's open days instead. Name a night and I'll draft one into the plan.`;
    } else {
        opener = `${gapLead} I couldn't read your pantry just now, so dinner ideas will come from ${features.recipes ? "your saved recipes" : "this week's open days"}. Name a night and I'll draft one into the plan.`;
    }

    const starters = [
        ...(pantryState === "usable"
            ? [
                  "Three dinners from my pantry this week",
                  `What can I make with ${topPantryNames[0]}?`,
              ]
            : []),
        ...(firstGap
            ? [`Plan a dinner for ${weekdayName(firstGap.date)}`]
            : []),
        "Explain this week's plan",
        ...(features.groceries
            ? ["Build the grocery list from this plan"]
            : []),
    ].slice(0, 5);

    return {
        surface: "meal_plan",
        summary: summaryParts.join(" "),
        opener,
        starters,
        data: {
            start_date: date,
            end_date: endDate,
            days,
            job: "pantry_first_dinner_ideas",
            dinner_ideas: { max_bought_ingredients_per_idea: 2 },
            pantry:
                pantryState === "module_off"
                    ? { available: false, module_off: true }
                    : pantryState === "unreadable"
                      ? { available: false }
                      : { available: true, items: pantryItems },
            recipe_candidates: candidates,
            allergy_filter: {
                applied: allergyFilterApplied,
                allergies,
                recipes_excluded: recipesExcludedForAllergy,
                pantry_items_excluded: pantryItemsExcludedForAllergy,
            },
            goals_context: goalsContext,
        },
    };
}

async function pantrySeed(
    userId: string,
    deps: ChatSeedDependencies,
): Promise<ChatEntrySeed> {
    const pantry = await soft(() =>
        (deps.pantry ?? getPantry)({
            userId,
            scope: { type: "personal" },
            limit: MAX_SEED_PANTRY_ITEMS,
        }),
    );
    const items = (pantry?.items ?? []).map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        stock_state: item.stock_state,
        location: item.location,
    }));
    const names = items.slice(0, 3).map((item) => item.name);
    const summary = pantry
        ? `${items.length} item${items.length === 1 ? "" : "s"} on hand${names.length ? ` — including ${names.join(", ")}` : ""}.`
        : "Your pantry could not be read just now.";
    const opener =
        items.length === 0
            ? "Your pantry is empty right now, so cooking from it is a short conversation — but I can help you plan a first shop, or log a meal instead."
            : `You have ${items.length} item${items.length === 1 ? "" : "s"} on hand${names.length ? ` — ${names.join(", ")} among them` : ""}. Ask what to cook tonight, what to use up first, or what's missing for a full meal.`;
    return {
        surface: "pantry",
        summary,
        opener,
        starters: [
            "What can I cook tonight from this?",
            "What should I use up first?",
            "What am I missing for a full meal?",
        ],
        data: { items },
    };
}

async function insightsSeed(
    userId: string,
    date: string,
    deps: ChatSeedDependencies,
): Promise<ChatEntrySeed> {
    const startDate = shiftDate(date, -6);
    const history = await soft(() =>
        (deps.history ?? getMealHistoryWorkspace)(userId, startDate, date),
    );
    const meals = (history?.meals ?? [])
        .slice(0, MAX_SEED_HISTORY_MEALS)
        .map((meal) => meal.description);
    const totals = history?.totals ?? null;
    const summary = totals
        ? `Last 7 days: ${kcal(totals.calories ?? 0)} logged across ${history?.meals.length ?? 0} meals.`
        : "Last week's log could not be read just now.";
    return {
        surface: "insights",
        summary,
        opener: "This starts with your last seven days — ask about a month or a year and I'll pull that instead. I can explain the pattern or find where protein dipped, measured against your own targets.",
        starters: [
            "Explain my week",
            "Where did my protein dip?",
            "How about last month?",
        ],
        data: {
            start_date: startDate,
            end_date: date,
            totals,
            meals,
        },
    };
}

/**
 * Assemble the live seed for one entry surface. Never throws.
 *
 * Feature toggles (T3): a surface owned by a disabled module has no
 * seed at all — the conversation opens unseeded and the agent's
 * context contains nothing from that module. Returns null only for
 * that case; every enabled surface assembles as before.
 */
export async function assembleEntrySeed(
    userId: string,
    surface: ChatEntrySurface,
    dependencies: ChatSeedDependencies = {},
): Promise<ChatEntrySeed | null> {
    const features =
        (await soft(() =>
            (dependencies.features ?? getFeatureModules)(userId),
        )) ?? DEFAULT_FEATURE_MODULES;
    const surfaceModule = CHAT_SURFACE_FEATURE_MODULES[surface];
    if (surfaceModule && !features[surfaceModule]) return null;
    const profileOf = dependencies.profile ?? getProfile;
    const profile = await soft(() => profileOf(userId));
    const timezone = profile?.timezone ?? "UTC";
    const date = dateInTz(new Date(), timezone);
    switch (surface) {
        case "today":
            return todaySeed(userId, date, dependencies);
        case "meal_plan":
            return mealPlanSeed(userId, date, dependencies, features);
        case "pantry":
            return pantrySeed(userId, dependencies);
        case "insights":
            return insightsSeed(userId, date, dependencies);
    }
}
