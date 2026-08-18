#!/usr/bin/env bun

import { createSmokeUser } from "./support/smoke-user.js";

const {
    addMealDraftQuestion,
    answerMealDraftQuestion,
    confirmMealDraft,
    createMealDraft,
    prepareMealDraftConfirmation,
    upsertMealDraftItem,
} = await import("../src/meal-drafts/repository.js");
const { prepareMealReview, resolveMealReview } =
    await import("../src/meal-drafts/atomic.js");
const { closePlatformDatabase, withAuthDatabase } =
    await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the meal review benchmark");
}

const iterations = Math.max(
    3,
    Math.min(30, Number(process.env.MUNCH_BENCHMARK_ITERATIONS ?? 8)),
);

const items = [
    {
        name: "Roasted chicken thigh",
        portionLabel: "1 medium thigh",
        nutrients: { calories: 285, protein_g: 28, carbs_g: 0, fat_g: 19 },
        sourceType: "model_estimate" as const,
        confidence: 0.82,
        assumptions: ["Fork used as a scale reference"],
        sourceSnapshot: { source: "benchmark-photo" },
    },
    {
        name: "Rice",
        portionLabel: "1 cup",
        nutrients: { calories: 205, protein_g: 4, carbs_g: 45, fat_g: 0.4 },
        sourceType: "model_estimate" as const,
        confidence: 0.78,
        assumptions: [],
        sourceSnapshot: { source: "benchmark-photo" },
    },
    {
        name: "Mixed vegetables",
        portionLabel: "3/4 cup",
        nutrients: { calories: 90, protein_g: 3, carbs_g: 15, fat_g: 2 },
        sourceType: "model_estimate" as const,
        confidence: 0.76,
        assumptions: ["Light oil estimated"],
        sourceSnapshot: { source: "benchmark-photo" },
    },
];

async function deleteUser(userId: string) {
    await withAuthDatabase(async (tx) => {
        await tx`delete from munch.users where id = ${userId}`;
    });
}

async function time<T>(operation: () => Promise<T>) {
    const start = performance.now();
    const value = await operation();
    return { value, duration: performance.now() - start };
}

function stats(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
    return {
        n: sorted.length,
        min_ms: Number(sorted[0]!.toFixed(1)),
        median_ms: Number(percentile(0.5).toFixed(1)),
        p95_ms: Number(percentile(0.95).toFixed(1)),
        max_ms: Number(sorted[sorted.length - 1]!.toFixed(1)),
        mean_ms: Number(
            (
                sorted.reduce((sum, value) => sum + value, 0) / sorted.length
            ).toFixed(1),
        ),
    };
}

async function legacyClear(userId: string) {
    let draft = await createMealDraft({
        userId,
        sourceMode: "photo",
        mealType: "dinner",
        description: "Benchmark chicken, rice, and vegetables",
    });
    for (const [position, item] of items.entries()) {
        draft = await upsertMealDraftItem({
            userId,
            draftId: draft.id,
            expectedVersion: draft.version,
            position,
            item,
        });
    }
    draft = await prepareMealDraftConfirmation({
        userId,
        draftId: draft.id,
        expectedVersion: draft.version,
    });
    return draft;
}

async function atomicClear(userId: string) {
    return prepareMealReview({
        userId,
        sourceMode: "photo",
        mealType: "dinner",
        description: "Benchmark chicken, rice, and vegetables",
        requestId: crypto.randomUUID(),
        items,
    });
}

async function legacyQuestion(userId: string) {
    let draft = await createMealDraft({
        userId,
        sourceMode: "photo",
        mealType: "dinner",
        description: "Benchmark chicken, rice, and vegetables",
    });
    for (const [position, item] of items.entries()) {
        draft = await upsertMealDraftItem({
            userId,
            draftId: draft.id,
            expectedVersion: draft.version,
            position,
            item,
        });
    }
    draft = await addMealDraftQuestion({
        userId,
        draftId: draft.id,
        expectedVersion: draft.version,
        itemId: draft.items[0]!.id,
        questionKey: "sauce_amount",
        prompt: "How much sauce was used?",
        impactScore: 90,
    });
    const question = draft.questions.find((value) => value.status === "open")!;
    draft = await answerMealDraftQuestion({
        userId,
        draftId: draft.id,
        expectedVersion: draft.version,
        questionId: question.id,
        answer: "One tablespoon",
    });
    draft = await prepareMealDraftConfirmation({
        userId,
        draftId: draft.id,
        expectedVersion: draft.version,
    });
    return draft;
}

async function atomicQuestion(userId: string) {
    let draft = await prepareMealReview({
        userId,
        sourceMode: "photo",
        mealType: "dinner",
        description: "Benchmark chicken, rice, and vegetables",
        requestId: crypto.randomUUID(),
        items,
        questions: [
            {
                questionKey: "sauce_amount",
                prompt: "How much sauce was used?",
                impactScore: 90,
                itemPosition: 0,
            },
        ],
    });
    const question = draft.questions.find((value) => value.status === "open")!;
    draft = await resolveMealReview({
        userId,
        draftId: draft.id,
        expectedVersion: draft.version,
        answers: [{ questionId: question.id, answer: "One tablespoon" }],
        questions: [],
    });
    return draft;
}

const results: Record<string, number[]> = {
    legacy_clear: [],
    atomic_clear: [],
    legacy_one_question: [],
    atomic_one_question: [],
};

for (let iteration = 0; iteration < iterations; iteration++) {
    const users = await Promise.all([
        createSmokeUser("bench-legacy-clear"),
        createSmokeUser("bench-atomic-clear"),
        createSmokeUser("bench-legacy-question"),
        createSmokeUser("bench-atomic-question"),
    ]);
    try {
        const legacyClearRun = await time(() => legacyClear(users[0]!));
        results.legacy_clear.push(legacyClearRun.duration);
        const atomicClearRun = await time(() => atomicClear(users[1]!));
        results.atomic_clear.push(atomicClearRun.duration);
        const legacyQuestionRun = await time(() => legacyQuestion(users[2]!));
        results.legacy_one_question.push(legacyQuestionRun.duration);
        const atomicQuestionRun = await time(() => atomicQuestion(users[3]!));
        results.atomic_one_question.push(atomicQuestionRun.duration);

        await Promise.all([
            confirmMealDraft({
                userId: users[0]!,
                draftId: legacyClearRun.value.id,
                expectedVersion: legacyClearRun.value.version,
                confirmed: true,
            }),
            confirmMealDraft({
                userId: users[1]!,
                draftId: atomicClearRun.value.id,
                expectedVersion: atomicClearRun.value.version,
                confirmed: true,
            }),
            confirmMealDraft({
                userId: users[2]!,
                draftId: legacyQuestionRun.value.id,
                expectedVersion: legacyQuestionRun.value.version,
                confirmed: true,
            }),
            confirmMealDraft({
                userId: users[3]!,
                draftId: atomicQuestionRun.value.id,
                expectedVersion: atomicQuestionRun.value.version,
                confirmed: true,
            }),
        ]);
    } finally {
        await Promise.all(users.map(deleteUser));
    }
}

const report = Object.fromEntries(
    Object.entries(results).map(([key, values]) => [key, stats(values)]),
);
const improvement = {
    clear_median_percent: Number(
        (
            (1 -
                report.atomic_clear.median_ms / report.legacy_clear.median_ms) *
            100
        ).toFixed(1),
    ),
    one_question_median_percent: Number(
        (
            (1 -
                report.atomic_one_question.median_ms /
                    report.legacy_one_question.median_ms) *
            100
        ).toFixed(1),
    ),
    clear_server_operations_before: 5,
    clear_server_operations_after: 1,
    one_question_server_operations_before: 7,
    one_question_server_operations_after: 2,
};

console.log(
    `[meal_review_benchmark] ${JSON.stringify({ iterations, report, improvement })}`,
);
await closePlatformDatabase();

export {};
