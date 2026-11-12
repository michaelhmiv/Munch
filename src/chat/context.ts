import { getTodayWorkspace } from "../app/repository.js";
import { getNutritionGoals } from "../storage.js";
import { getProfile } from "../nutrition-platform/profiles.js";
import { assembleGoalsContext } from "../goals-context-repository.js";
import { goalsContextForModel, type GoalsContext } from "../goals-context.js";
import { dateInTz } from "../tz.js";

/**
 * Chat v2 slim static context (chat-v2 brief, decision 3).
 *
 * The ONLY facts baked into the agent's prompt are the user's goals
 * (numeric targets plus — via the shared goals-context module — the
 * goal they stated in their own words and their intake answers) and
 * today's totals — the things nearly every exchange needs.
 * Everything else (today's meals in detail, pantry, plans, history,
 * recipes) is fetched live through the MCP tools the agent calls, so
 * the agent always works from current data instead of a snapshot
 * assembled at send time. (Chat v1 assembled pantry + recent history
 * + today's meal list into every prompt; v2 deliberately reduced this
 * surface — see the brief.)
 *
 * Assembly stays deterministic and code-side: every figure here
 * traces to a logged meal (provider-grounded at log time) or a
 * stated goal. Each gatherer fails soft (its section is simply
 * absent), and the summary records which sections were included.
 */

export interface ChatContextSummary {
    date: string;
    timezone: string;
    sections: string[];
    goals: {
        daily_calories: number | null;
        daily_protein_g: number | null;
        daily_carbs_g: number | null;
        daily_fat_g: number | null;
        daily_fiber_g: number | null;
    } | null;
    today: {
        totals: {
            calories: number;
            proteinG: number;
            carbsG: number;
            fatG: number;
            fiberG: number;
        };
    } | null;
    /**
     * The user's stated goal + intake answers, assembled by the
     * shared goals-context module (goals law rule 6). Present only
     * when the user has answered the Goals intake — omitted entirely
     * when they have not, never an empty shell.
     */
    goals_context?: ReturnType<typeof goalsContextForModel>;
}

export interface ChatContextData {
    date: string;
    timezone: string;
    goals: ChatContextSummary["goals"];
    goalsContext?: GoalsContext | null;
    today: {
        totals: {
            calories: number;
            proteinG: number;
            carbsG: number;
            fatG: number;
            fiberG: number;
        };
    } | null;
}

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

/** Pure summary of gathered context data (unit-tested). */
export function summarizeChatContext(
    data: ChatContextData,
): ChatContextSummary {
    const sections: string[] = [];
    if (data.goals) sections.push("goals");
    if (data.today) sections.push("today_totals");
    const goalsContext = data.goalsContext
        ? goalsContextForModel(data.goalsContext)
        : null;
    if (goalsContext) sections.push("goals_context");
    return {
        date: data.date,
        timezone: data.timezone,
        sections,
        goals: data.goals,
        today: data.today
            ? {
                  totals: {
                      calories: round1(data.today.totals.calories),
                      proteinG: round1(data.today.totals.proteinG),
                      carbsG: round1(data.today.totals.carbsG),
                      fatG: round1(data.today.totals.fatG),
                      fiberG: round1(data.today.totals.fiberG),
                  },
              }
            : null,
        // Omitted entirely when the user has not answered the
        // intake — the slim-summary contract keeps unset sections
        // absent, never null shells.
        ...(goalsContext ? { goals_context: goalsContext } : {}),
    };
}

export interface ChatContextDependencies {
    profile?: (userId: string) => Promise<{ timezone: string | null } | null>;
    goals?: typeof getNutritionGoals;
    today?: typeof getTodayWorkspace;
    goalsContext?: typeof assembleGoalsContext;
}

async function soft<T>(run: () => Promise<T>): Promise<T | null> {
    try {
        return await run();
    } catch (error) {
        console.warn("Chat context section failed; continuing without it", {
            errorName: error instanceof Error ? error.name : "unknown",
        });
        return null;
    }
}

/** Gather the slim static context deterministically and summarize it. */
export async function assembleChatContext(
    userId: string,
    dependencies: ChatContextDependencies = {},
): Promise<ChatContextSummary> {
    const profileOf = dependencies.profile ?? getProfile;
    const profile = await soft(() => profileOf(userId));
    const timezone = profile?.timezone ?? "UTC";
    const date = dateInTz(new Date(), timezone);

    const [goals, today, goalsContext] = await Promise.all([
        soft(() => (dependencies.goals ?? getNutritionGoals)(userId)),
        soft(() => (dependencies.today ?? getTodayWorkspace)(userId, date)),
        soft(() => (dependencies.goalsContext ?? assembleGoalsContext)(userId)),
    ]);

    return summarizeChatContext({
        date,
        timezone,
        goalsContext,
        goals: goals
            ? {
                  daily_calories: goals.daily_calories ?? null,
                  daily_protein_g: goals.daily_protein_g ?? null,
                  daily_carbs_g: goals.daily_carbs_g ?? null,
                  daily_fat_g: goals.daily_fat_g ?? null,
                  daily_fiber_g: goals.daily_fiber_g ?? null,
              }
            : null,
        today: today ? { totals: today.totals } : null,
    });
}
