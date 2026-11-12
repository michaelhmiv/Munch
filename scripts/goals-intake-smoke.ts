#!/usr/bin/env bun

import {
    getGoalsIntake,
    saveGoalsIntake,
    assembleGoalsContext,
} from "../src/goals-context-repository.js";
import {
    closePlatformDatabase,
    withUserDatabase,
} from "../src/platform/database.js";
import { createSmokeIdentity } from "./support/smoke-user.js";

// Goals intake (goals intake brief): the stated goal and the five
// skippable answers persist per account on the server (migration
// 0043), default to fully unset for an account that has never
// answered, and are invisible to other accounts under RLS. The
// shared goals-context assembly reads the same answers back, so the
// intake is context for the AI surfaces, not a form that dead-ends.

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the goals intake smoke");
}

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}

const owner = await createSmokeIdentity("goals-owner");
const other = await createSmokeIdentity("goals-other");
const EMPTY = {
    stated_goal: null,
    activity_band: null,
    eating_pattern: null,
    hardest_meal: null,
    never_suggest: [],
    allergies: [],
};
const ANSWERED = {
    stated_goal: "Lower my fat intake at dinner",
    activity_band: "30_to_60" as const,
    eating_pattern: "mix" as const,
    hardest_meal: "dinner" as const,
    never_suggest: ["cilantro"],
    allergies: ["peanuts", "shellfish"],
};

try {
    // A fresh account reads as fully unset — the intake is opt-in,
    // and "not answered" must assemble to no intake context at all.
    const initial = await getGoalsIntake(owner.userId);
    assert(
        JSON.stringify(initial) === JSON.stringify(EMPTY),
        `fresh account should read unset, got ${JSON.stringify(initial)}`,
    );
    const emptyContext = await assembleGoalsContext(owner.userId);
    assert(
        emptyContext.has_intake === false &&
            emptyContext.stated_goal === null &&
            emptyContext.allergies.length === 0,
        "an unanswered intake assembled into context",
    );

    // The full answer set persists and round-trips exactly.
    const saved = await saveGoalsIntake(owner.userId, ANSWERED);
    assert(
        JSON.stringify(saved) === JSON.stringify(ANSWERED),
        `saved intake did not round-trip, got ${JSON.stringify(saved)}`,
    );
    const reread = await getGoalsIntake(owner.userId);
    assert(
        JSON.stringify(reread) === JSON.stringify(ANSWERED),
        "intake did not survive a re-read",
    );

    // The shared assembly surfaces the answers as AI context.
    const context = await assembleGoalsContext(owner.userId);
    assert(
        context.has_intake === true &&
            context.stated_goal === ANSWERED.stated_goal &&
            context.activity_band === "30_to_60" &&
            context.allergies.includes("peanuts") &&
            context.allergies.includes("shellfish") &&
            context.never_suggest.includes("cilantro"),
        `assembled context is missing intake answers: ${JSON.stringify(context)}`,
    );

    // Clearing works too: an explicit empty save returns the account
    // to fully unset (the page's "No answer" / blank-fields state).
    const cleared = await saveGoalsIntake(owner.userId, EMPTY);
    assert(
        JSON.stringify(cleared) === JSON.stringify(EMPTY),
        "clearing the intake did not persist",
    );

    // RLS: the other account still reads its own (unset) intake and
    // cannot see the owner's preference row at all.
    const otherIntake = await getGoalsIntake(other.userId);
    assert(
        JSON.stringify(otherIntake) === JSON.stringify(EMPTY),
        "another account's intake was affected by the owner's saves",
    );
    const visibleRows = await withUserDatabase(other.userId, async (tx) => {
        return tx<Array<{ user_id: string }>>`
            select user_id from munch.account_preferences
            where user_id = ${owner.userId}
        `;
    });
    assert(
        visibleRows.length === 0,
        "RLS leaked the owner's preference row to another account",
    );

    console.log("Goals intake smoke passed.");
} finally {
    await closePlatformDatabase();
}
