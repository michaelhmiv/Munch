import { withUserDatabase } from "./platform/database.js";
import {
    normalizeGoalsIntake,
    buildGoalsContext,
    type GoalsContext,
    type GoalsIntake,
} from "./goals-context.js";
import { getNutritionGoals } from "./nutrition-platform/goals.js";
import { getGuidancePreferences } from "./guidance-repository.js";
import type { GuidancePreferences } from "./guidance/contracts.js";
import type { NutritionGoals } from "./nutrition-platform/types.js";

/**
 * Server-side storage + assembly for the goals context (goals law
 * rule 6). The intake lives on the account-preferences row
 * (migration 0043) under the user's RLS context, like the feature
 * toggles, so web, Android, and iOS — and every server-side AI
 * context assembly — read the same answers. `assembleGoalsContext`
 * is the single entry point AI surfaces call: it merges the intake,
 * the numeric targets, and the guidance preferences' allergy /
 * exclusion lists into the effective context. Each source fails
 * soft (its slice is simply absent), matching the other context
 * assemblers — a context read must never break a surface.
 */

interface GoalsIntakeRow {
    goals_stated: string | null;
    goals_activity_band: string | null;
    goals_eating_pattern: string | null;
    goals_hardest_meal: string | null;
    goals_never_suggest: string[] | null;
    goals_allergies: string[] | null;
}

function rowToGoalsIntake(row: GoalsIntakeRow | undefined): GoalsIntake {
    if (!row) return normalizeGoalsIntake(null);
    return normalizeGoalsIntake({
        stated_goal: row.goals_stated,
        activity_band: row.goals_activity_band,
        eating_pattern: row.goals_eating_pattern,
        hardest_meal: row.goals_hardest_meal,
        never_suggest: row.goals_never_suggest ?? [],
        allergies: row.goals_allergies ?? [],
    });
}

export async function getGoalsIntake(userId: string): Promise<GoalsIntake> {
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<GoalsIntakeRow[]>`
            select goals_stated, goals_activity_band, goals_eating_pattern,
                   goals_hardest_meal, goals_never_suggest, goals_allergies
            from munch.account_preferences
            where user_id = ${userId}
        `;
        return rowToGoalsIntake(rows[0]);
    });
}

export async function saveGoalsIntake(
    userId: string,
    intake: GoalsIntake,
): Promise<GoalsIntake> {
    const next = normalizeGoalsIntake(intake);
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<GoalsIntakeRow[]>`
            insert into munch.account_preferences (
                user_id, goals_stated, goals_activity_band,
                goals_eating_pattern, goals_hardest_meal,
                goals_never_suggest, goals_allergies
            ) values (
                ${userId}, ${next.stated_goal}, ${next.activity_band},
                ${next.eating_pattern}, ${next.hardest_meal},
                ${next.never_suggest}, ${next.allergies}
            )
            on conflict (user_id) do update
                set goals_stated = excluded.goals_stated,
                    goals_activity_band = excluded.goals_activity_band,
                    goals_eating_pattern = excluded.goals_eating_pattern,
                    goals_hardest_meal = excluded.goals_hardest_meal,
                    goals_never_suggest = excluded.goals_never_suggest,
                    goals_allergies = excluded.goals_allergies,
                    updated_at = now()
            returning goals_stated, goals_activity_band,
                      goals_eating_pattern, goals_hardest_meal,
                      goals_never_suggest, goals_allergies
        `;
        return rowToGoalsIntake(rows[0]);
    });
}

export interface GoalsContextDependencies {
    intake?: (userId: string) => Promise<GoalsIntake>;
    targets?: (userId: string) => Promise<NutritionGoals | null>;
    guidancePreferences?: (
        userId: string,
    ) => Promise<GuidancePreferences | null>;
    /** Preloaded slices (a consumer that already read them pays no second read). */
    preloaded?: {
        targets?: NutritionGoals | null;
        guidancePreferences?: GuidancePreferences | null;
    };
}

async function soft<T>(run: () => Promise<T>): Promise<T | null> {
    try {
        return await run();
    } catch (error) {
        console.warn("Goals context section failed; continuing without it", {
            errorName: error instanceof Error ? error.name : "unknown",
        });
        return null;
    }
}

/**
 * Assemble the goals context for a user. Consumers pass preloaded
 * slices when they already hold them (Next up already reads goals
 * and guidance preferences); everything else is read here, once,
 * through this module — never ad hoc at the surface (rule 6).
 */
export async function assembleGoalsContext(
    userId: string,
    dependencies: GoalsContextDependencies = {},
): Promise<GoalsContext> {
    const preloaded = dependencies.preloaded ?? {};
    const [intake, targets, guidancePreferences] = await Promise.all([
        soft(() => (dependencies.intake ?? getGoalsIntake)(userId)),
        "targets" in preloaded
            ? Promise.resolve(preloaded.targets ?? null)
            : soft(() => (dependencies.targets ?? getNutritionGoals)(userId)),
        "guidancePreferences" in preloaded
            ? Promise.resolve(preloaded.guidancePreferences ?? null)
            : soft(() =>
                  (dependencies.guidancePreferences ?? getGuidancePreferences)(
                      userId,
                  ),
              ),
    ]);
    return buildGoalsContext({
        intake,
        targets,
        guidancePreferences,
    });
}
