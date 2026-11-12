import {
    allergenKeysForName,
    canonicalAllergen,
    containsTerm,
} from "./guidance/domain.js";
import type { GuidancePreferences } from "./guidance/contracts.js";
import type { NutritionGoals } from "./nutrition-platform/types.js";

/**
 * Goals context — the ONE shared module every AI surface consumes
 * (goals law rule 6, goals intake brief). It assembles three things
 * the user stated, and nothing inferred:
 *
 *   1. their goal in their own words (the Goals page free-text box),
 *   2. the five skippable intake answers (activity band, eating
 *      pattern, hardest meal, never-suggest list, allergies), and
 *   3. the numeric targets they set (nutrition goals).
 *
 * AI surfaces consume the assembled context from here — never their
 * own ad-hoc reads of the intake columns or the goals table — so an
 * answer given once is context everywhere: chat, guidance / Next up,
 * meal ideas, and every future surface. The assembly itself lives in
 * goals-context-repository.ts; this file is the contract, the pure
 * assembly, and the deterministic allergy post-filter (rule 5:
 * user-stated allergies are a HARD filter on suggestion outputs,
 * applied in code, never left to model discretion).
 */

export const ACTIVITY_BANDS = ["under_30", "30_to_60", "over_60"] as const;
export type ActivityBand = (typeof ACTIVITY_BANDS)[number];

export const EATING_PATTERNS = ["cook_home", "mix", "mostly_out"] as const;
export type EatingPattern = (typeof EATING_PATTERNS)[number];

export const HARDEST_MEALS = [
    "breakfast",
    "lunch",
    "dinner",
    "snacks",
] as const;
export type HardestMeal = (typeof HARDEST_MEALS)[number];

export interface GoalsIntake {
    stated_goal: string | null;
    activity_band: ActivityBand | null;
    eating_pattern: EatingPattern | null;
    hardest_meal: HardestMeal | null;
    never_suggest: string[];
    allergies: string[];
}

export const EMPTY_GOALS_INTAKE: GoalsIntake = {
    stated_goal: null,
    activity_band: null,
    eating_pattern: null,
    hardest_meal: null,
    never_suggest: [],
    allergies: [],
};

const MAX_STATED_GOAL_CHARS = 500;
const MAX_LIST_ITEMS = 30;
const MAX_LIST_ITEM_CHARS = 80;

function enumOrNull<T extends string>(
    value: unknown,
    allowed: readonly T[],
): T | null {
    return typeof value === "string" &&
        (allowed as readonly string[]).includes(value)
        ? (value as T)
        : null;
}

/** Trim, drop empties, dedupe case-insensitively, cap list + item size. */
export function normalizeTextList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of value) {
        if (typeof entry !== "string") continue;
        const item = entry.trim().slice(0, MAX_LIST_ITEM_CHARS);
        if (!item) continue;
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
        if (result.length >= MAX_LIST_ITEMS) break;
    }
    return result;
}

/**
 * Normalize an untrusted intake payload (a stored row or a PUT body)
 * into the contract shape. Anything unrecognized becomes unset —
 * the intake is self-reported context, never a gate, so a malformed
 * field degrades to "not answered" instead of failing the request.
 */
export function normalizeGoalsIntake(value: unknown): GoalsIntake {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ...EMPTY_GOALS_INTAKE };
    }
    const record = value as Record<string, unknown>;
    const stated =
        typeof record.stated_goal === "string"
            ? record.stated_goal.trim().slice(0, MAX_STATED_GOAL_CHARS)
            : "";
    return {
        stated_goal: stated || null,
        activity_band: enumOrNull(record.activity_band, ACTIVITY_BANDS),
        eating_pattern: enumOrNull(record.eating_pattern, EATING_PATTERNS),
        hardest_meal: enumOrNull(record.hardest_meal, HARDEST_MEALS),
        never_suggest: normalizeTextList(record.never_suggest),
        allergies: normalizeTextList(record.allergies),
    };
}

/**
 * Apply a partial PUT patch over the stored intake. A field that is
 * present in the patch replaces the stored value (an explicit null
 * or empty list clears it); a field that is absent keeps the stored
 * value. Returns null when the patch carries no intake field at all.
 */
export function goalsIntakePatch(
    current: GoalsIntake,
    patch: unknown,
): GoalsIntake | null {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return null;
    }
    const record = patch as Record<string, unknown>;
    const fields = [
        "stated_goal",
        "activity_band",
        "eating_pattern",
        "hardest_meal",
        "never_suggest",
        "allergies",
    ] as const;
    if (!fields.some((field) => field in record)) return null;
    return normalizeGoalsIntake({ ...current, ...record });
}

export interface GoalsContextTargets {
    daily_calories: number | null;
    daily_protein_g: number | null;
    daily_carbs_g: number | null;
    daily_fat_g: number | null;
    daily_fiber_g: number | null;
}

/**
 * The assembled context AI surfaces consume. The intake slice mirrors
 * GoalsIntake; `allergies` and `never_suggest` are the EFFECTIVE
 * lists — the intake answers merged with the older guidance
 * preferences, so an allergen stated in either place is a hard
 * filter everywhere (rule 5). `has_intake` is true when the user has
 * answered anything at all on the Goals page.
 */
export interface GoalsContext {
    stated_goal: string | null;
    activity_band: ActivityBand | null;
    eating_pattern: EatingPattern | null;
    hardest_meal: HardestMeal | null;
    never_suggest: string[];
    allergies: string[];
    targets: GoalsContextTargets | null;
    has_intake: boolean;
}

function mergeLists(...lists: string[][]): string[] {
    return normalizeTextList(lists.flat());
}

export function buildGoalsContext(input: {
    intake?: GoalsIntake | null;
    targets?: NutritionGoals | null;
    guidancePreferences?: GuidancePreferences | null;
}): GoalsContext {
    const intake = input.intake ?? EMPTY_GOALS_INTAKE;
    const guidance = input.guidancePreferences;
    const targets = input.targets
        ? {
              daily_calories: input.targets.daily_calories ?? null,
              daily_protein_g: input.targets.daily_protein_g ?? null,
              daily_carbs_g: input.targets.daily_carbs_g ?? null,
              daily_fat_g: input.targets.daily_fat_g ?? null,
              daily_fiber_g: input.targets.daily_fiber_g ?? null,
          }
        : null;
    return {
        stated_goal: intake.stated_goal,
        activity_band: intake.activity_band,
        eating_pattern: intake.eating_pattern,
        hardest_meal: intake.hardest_meal,
        never_suggest: mergeLists(
            intake.never_suggest,
            guidance?.excluded_ingredients ?? [],
        ),
        allergies: mergeLists(intake.allergies, guidance?.allergies ?? []),
        targets,
        has_intake: Boolean(
            intake.stated_goal ||
            intake.activity_band ||
            intake.eating_pattern ||
            intake.hardest_meal ||
            intake.never_suggest.length > 0 ||
            intake.allergies.length > 0,
        ),
    };
}

/**
 * The compose-facing slice of the context: what a suggestion model
 * may be told. Targets ride along because the composers already work
 * from them; the lists are the user's own words, presented as data.
 * Returns null when the user has stated nothing, so consumers omit
 * the section cleanly instead of sending an empty shell.
 */
export function goalsContextForModel(context: GoalsContext) {
    if (!context.has_intake) return null;
    return {
        stated_goal: context.stated_goal,
        activity_band: context.activity_band,
        eating_pattern: context.eating_pattern,
        hardest_meal: context.hardest_meal,
        never_suggest: context.never_suggest,
        allergies: context.allergies,
    };
}

/**
 * The canonical allergen keys a user's stated allergies implicate:
 * each stated term contributes its canonical key ("tree nuts" →
 * tree_nut, "dairy" → milk) plus the keys its own name implicates
 * ("shrimp" → shellfish), so a category answer and an ingredient
 * answer filter identically.
 */
export function allergenKeySet(allergies: readonly string[]): Set<string> {
    const keys = new Set<string>();
    for (const allergy of allergies) {
        keys.add(canonicalAllergen(allergy));
        for (const key of allergenKeysForName(allergy)) keys.add(key);
    }
    return keys;
}

/**
 * Does this food/dish text implicate any stated allergy? Matches on
 * canonical allergen keys via the shared alias table (domain.ts) and,
 * for allergens outside the catalog, on the stated term itself
 * appearing in the text — the same word-boundary containment the
 * plan-draft screener uses.
 */
export function textMatchesAllergy(
    text: string,
    allergies: readonly string[],
): boolean {
    if (allergies.length === 0 || !text) return false;
    const keys = allergenKeySet(allergies);
    if (allergenKeysForName(text).some((key) => keys.has(key))) return true;
    return allergies.some((allergy) => containsTerm(text, allergy));
}

/** True when any of the names implicates a stated allergy. */
export function namesMatchAllergy(
    names: readonly string[],
    allergies: readonly string[],
): boolean {
    return names.some((name) => textMatchesAllergy(name, allergies));
}
