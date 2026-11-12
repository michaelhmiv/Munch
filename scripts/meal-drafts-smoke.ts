#!/usr/bin/env bun

import { createSmokeIdentity, createSmokeUser } from "./support/smoke-user.js";

const {
    addMealDraftQuestion,
    answerMealDraftQuestion,
    cancelMealDraft,
    confirmMealDraft,
    createMealDraft,
    deleteMealDraftItem,
    getMealDraft,
    prepareMealDraftConfirmation,
    updateMealDraftMetadata,
    upsertMealDraftItem,
} = await import("../src/meal-drafts/repository.js");
const { getStructuredMeal } =
    await import("../src/structured-meals/repository.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for meal-draft smoke tests");
}

const userA = await createSmokeUser("draft-a");
const userB = await createSmokeUser("draft-b");
let draft = await createMealDraft({
    userId: userA,
    sourceMode: "photo",
    description: "Chicken and rice plate",
    mealType: "lunch",
    loggedAt: "2026-08-03T18:00:00.000Z",
});
if (draft.status !== "open" || draft.version !== 1) {
    throw new Error("New draft did not start in the expected state");
}

const staleVersion = draft.version;
draft = await upsertMealDraftItem({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    position: 0,
    item: {
        name: "Chicken and rice",
        portionLabel: "1 plate",
        nutrients: {
            calories: 620,
            protein_g: 42,
            carbs_g: 70,
            fat_g: 18,
        },
        sourceType: "model_estimate",
        confidence: 0.7,
        assumptions: ["Initial plate-size estimate"],
        sourceSnapshot: { source: "photo", model: "host vision" },
    },
});
if (draft.status !== "awaiting_confirmation" || draft.version !== 2) {
    throw new Error("Adding a draft item did not update state/version");
}

let staleRejected = false;
try {
    await updateMealDraftMetadata({
        userId: userA,
        draftId: draft.id,
        expectedVersion: staleVersion,
        notes: "stale write",
    });
} catch (error) {
    staleRejected = String(error).includes("expected version");
}
if (!staleRejected) throw new Error("Stale draft update was not rejected");

const itemId = draft.items[0]!.id;
draft = await addMealDraftQuestion({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    itemId,
    questionKey: "portion_eaten",
    prompt: "How much of the plate did you eat?",
    impactScore: 95,
});
draft = await addMealDraftQuestion({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    itemId,
    questionKey: "hidden_oil",
    prompt: "Was oil or butter added?",
    impactScore: 80,
});
if (
    draft.status !== "awaiting_answers" ||
    draft.questions.find((question) => question.status === "open")
        ?.questionKey !== "portion_eaten"
) {
    throw new Error("Draft questions were not ordered by impact");
}

let prematureRejected = false;
try {
    await prepareMealDraftConfirmation({
        userId: userA,
        draftId: draft.id,
        expectedVersion: draft.version,
    });
} catch (error) {
    prematureRejected = String(error).includes("unresolved question");
}
if (!prematureRejected) {
    throw new Error("Draft prepared despite unresolved questions");
}

const portionQuestion = draft.questions.find(
    (question) => question.questionKey === "portion_eaten",
)!;
const currentItem = draft.items[0]!.item;
draft = await upsertMealDraftItem({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    position: 0,
    item: {
        ...currentItem,
        assumptions: [
            ...(currentItem.assumptions ?? []).filter(
                (assumption) => assumption !== "Initial plate-size estimate",
            ),
            "User confirmed the entire estimated plate was consumed.",
        ],
        sourceSnapshot: {
            ...(currentItem.sourceSnapshot ?? {}),
            established_facts: {
                consumed_fraction: 1,
                consumed_amount: "entire plate",
            },
        },
    },
});
draft = await answerMealDraftQuestion({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    questionId: portionQuestion.id,
    answer: "I ate the entire plate.",
});
if (
    draft.questions.find((question) => question.status === "open")
        ?.questionKey !== "hidden_oil"
) {
    throw new Error("Next draft question was not advanced correctly");
}

draft = await prepareMealDraftConfirmation({
    userId: userA,
    draftId: draft.id,
    expectedVersion: draft.version,
    acceptRemainingAssumptions: true,
});
if (
    draft.status !== "awaiting_confirmation" ||
    draft.questions.some((question) => question.status === "open")
) {
    throw new Error("Draft assumptions were not accepted for confirmation");
}

const confirmVersion = draft.version;
draft = await confirmMealDraft({
    userId: userA,
    draftId: draft.id,
    expectedVersion: confirmVersion,
    confirmed: true,
});
if (draft.status !== "confirmed" || !draft.confirmedMealId) {
    throw new Error("Prepared draft was not confirmed");
}
const meal = await getStructuredMeal(userA, draft.confirmedMealId);
if (!meal || meal.items.length !== 1 || meal.calories !== 620) {
    throw new Error("Confirmed draft did not create the structured meal");
}
if (
    !meal.items[0]?.assumptions.some((value) =>
        value.includes("User accepted unresolved assumption"),
    )
) {
    throw new Error(
        "Accepted unresolved assumption was not preserved on the meal",
    );
}
if (
    !meal.items[0]?.assumptions.some((value) =>
        value.includes("entire estimated plate was consumed"),
    )
) {
    throw new Error("Reconciled portion answer was not preserved on the meal");
}

const retry = await confirmMealDraft({
    userId: userA,
    draftId: draft.id,
    expectedVersion: confirmVersion,
    confirmed: true,
});
if (retry.confirmedMealId !== draft.confirmedMealId) {
    throw new Error("Confirmation retry created or returned a different meal");
}
if (await getMealDraft(userB, draft.id)) {
    throw new Error("Cross-tenant draft read was allowed");
}
if (await getStructuredMeal(userB, draft.confirmedMealId)) {
    throw new Error("Cross-tenant confirmed meal read was allowed");
}

let cancelled = await createMealDraft({
    userId: userA,
    sourceMode: "text",
    description: "Cancelled snack",
    mealType: "snack",
});
cancelled = await cancelMealDraft({
    userId: userA,
    draftId: cancelled.id,
    expectedVersion: cancelled.version,
});
if (cancelled.status !== "cancelled" || cancelled.confirmedMealId) {
    throw new Error("Draft cancellation created an unexpected meal");
}

let removable = await createMealDraft({
    userId: userA,
    sourceMode: "text",
    description: "Draft with removable items",
    mealType: "dinner",
});
for (const [position, name] of (
    ["First item", "Second item"] as const
).entries()) {
    removable = await upsertMealDraftItem({
        userId: userA,
        draftId: removable.id,
        expectedVersion: removable.version,
        position,
        item: {
            name,
            nutrients: { calories: 100 + position },
            sourceType: "user_supplied",
        },
    });
}
removable = await deleteMealDraftItem({
    userId: userA,
    draftId: removable.id,
    itemId: removable.items[0]!.id,
    expectedVersion: removable.version,
});
if (
    removable.items.length !== 1 ||
    removable.items[0]?.position !== 0 ||
    removable.items[0]?.item.name !== "Second item"
) {
    throw new Error("Draft item deletion did not compact positions safely");
}

// S3 hardening: a BLOCKING question (photo item with no nutrition
// values) cannot be accepted away — prepare must refuse even with
// acceptRemainingAssumptions, naming the item; supplying the item's
// nutrition and answering the question unblocks confirmation.
let blocked = await createMealDraft({
    userId: userA,
    sourceMode: "photo",
    description: "Plate with an unestimated item",
    mealType: "lunch",
});
blocked = await upsertMealDraftItem({
    userId: userA,
    draftId: blocked.id,
    expectedVersion: blocked.version,
    position: 0,
    item: {
        name: "cooked white rice",
        quantity: 1,
        portionLabel: "1 cup",
        nutrients: {},
        sourceType: "model_estimate",
        confidence: 0.8,
        assumptions: [],
        sourceSnapshot: {
            resolution_layer: "meal_photo_grounding",
            estimate_status: "unavailable",
        },
    },
});
const blockedItemId = blocked.items[0]!.id;
blocked = await addMealDraftQuestion({
    userId: userA,
    draftId: blocked.id,
    expectedVersion: blocked.version,
    itemId: blockedItemId,
    questionKey: "photo_estimate_missing_0",
    prompt: "We couldn't find nutrition for cooked white rice (1 cup). Please supply or confirm its nutrition, or remove the item.",
    impactScore: 100,
});
let blockingRefusal = "";
try {
    await prepareMealDraftConfirmation({
        userId: userA,
        draftId: blocked.id,
        expectedVersion: blocked.version,
        acceptRemainingAssumptions: true,
    });
} catch (error) {
    blockingRefusal = String(error);
}
if (
    !blockingRefusal.includes("cannot be confirmed") ||
    !blockingRefusal.includes("cooked white rice")
) {
    throw new Error(
        `Blocking question was accepted away or the refusal did not name the item: ${blockingRefusal}`,
    );
}
if (
    blocked.questions.find(
        (question) => question.questionKey === "photo_estimate_missing_0",
    )?.status !== "open"
) {
    throw new Error("Blocking question did not remain open after refusal");
}
// Supply the nutrition (item update reconciles the question), answer
// it, then preparation and confirmation succeed.
blocked = await upsertMealDraftItem({
    userId: userA,
    draftId: blocked.id,
    expectedVersion: blocked.version,
    position: 0,
    item: {
        ...blocked.items[0]!.item,
        nutrients: { calories: 205, protein_g: 4.3, carbs_g: 44.5, fat_g: 0.4 },
        sourceType: "user_supplied",
    },
});
const blockingQuestion = blocked.questions.find(
    (question) => question.questionKey === "photo_estimate_missing_0",
)!;
blocked = await answerMealDraftQuestion({
    userId: userA,
    draftId: blocked.id,
    expectedVersion: blocked.version,
    questionId: blockingQuestion.id,
    answer: "Confirmed the rice nutrition from the package label.",
});
blocked = await prepareMealDraftConfirmation({
    userId: userA,
    draftId: blocked.id,
    expectedVersion: blocked.version,
});
blocked = await confirmMealDraft({
    userId: userA,
    draftId: blocked.id,
    expectedVersion: blocked.version,
    confirmed: true,
});
if (blocked.status !== "confirmed" || !blocked.confirmedMealId) {
    throw new Error("Resolved blocking draft was not confirmed");
}
const blockedMeal = await getStructuredMeal(userA, blocked.confirmedMealId);
if (!blockedMeal || blockedMeal.calories !== 205) {
    throw new Error("Resolved blocking draft logged the wrong totals");
}

// Amendment E item 3: conversational add-to-draft on a photo draft,
// exercised end-to-end against the real draft machinery with stub
// grounding deps (recorded data only — no live model calls).
const { addTextToPhotoDraft } = await import("../src/meal-photo/draft-add.js");
const butterCandidate = {
    provider: "usda",
    providerFoodId: "173430",
    name: "Butter, salted",
    dataKind: "generic",
    nutrientsPer100g: {
        calories: 717,
        protein_g: 0.85,
        carbs_g: 0.06,
        fat_g: 81.1,
    },
    portions: [
        {
            id: "tbsp",
            amount: 1,
            unit: "tbsp",
            label: "1 tbsp",
            gramWeight: 14.2,
            nutrients: {
                calories: 102,
                protein_g: 0.12,
                carbs_g: 0.01,
                fat_g: 11.5,
            },
        },
    ],
    attribution: {
        label: "USDA FoodData Central",
        url: "https://fdc.nal.usda.gov/food/173430",
    },
    confidence: 0.95,
};
const broccoliCandidate = {
    ...butterCandidate,
    providerFoodId: "170379",
    name: "Broccoli, cooked",
    nutrientsPer100g: {
        calories: 35,
        protein_g: 2.4,
        carbs_g: 7.2,
        fat_g: 0.4,
    },
    portions: [
        {
            id: "serving",
            amount: 1,
            unit: "serving",
            label: "1 serving",
            gramWeight: 100,
            nutrients: {
                calories: 35,
                protein_g: 2.4,
                carbs_g: 7.2,
                fat_g: 0.4,
            },
        },
    ],
    attribution: {
        label: "USDA FoodData Central",
        url: "https://fdc.nal.usda.gov/food/170379",
    },
};
const addSearch = async (query: string) => {
    if (query.includes("butter")) {
        return { candidates: [butterCandidate], failures: [] };
    }
    if (query.includes("broccoli")) {
        return { candidates: [broccoliCandidate], failures: [] };
    }
    return { candidates: [], failures: [] };
};

let photoAdd = await createMealDraft({
    userId: userA,
    sourceMode: "photo",
    description: "Photo estimate — check portions",
    mealType: "dinner",
});
photoAdd = await upsertMealDraftItem({
    userId: userA,
    draftId: photoAdd.id,
    expectedVersion: photoAdd.version,
    position: 0,
    item: {
        name: "grilled chicken breast",
        quantity: 160,
        portionLabel: "160 g",
        nutrients: { calories: 264, protein_g: 49.6, carbs_g: 0, fat_g: 5.8 },
        sourceType: "usda",
        confidence: 0.85,
        assumptions: ["assumed skinless breast"],
        sourceSnapshot: { resolution_layer: "meal_photo_grounding" },
    },
});
const addedOutcome = await addTextToPhotoDraft({
    userId: userA,
    draft: photoAdd,
    text: "I added a good bit of butter",
    deps: { search: addSearch as never },
});
if (addedOutcome.status !== "added") {
    throw new Error(`Butter add did not land: ${addedOutcome.status}`);
}
photoAdd = addedOutcome.draft;
const butterItem = photoAdd.items.find((record) =>
    record.item.name.includes("Butter"),
);
if (
    photoAdd.items.length !== 2 ||
    !butterItem ||
    butterItem.item.nutrients.calories !== 102 ||
    !butterItem.item.assumptions.some((value) =>
        value.startsWith('Added by you: "I added a good bit of butter"'),
    ) ||
    !butterItem.item.assumptions.some((value) => value.includes("a good bit"))
) {
    throw new Error(
        "Butter add was not persisted with provenance + assumption",
    );
}
const photoTotal = photoAdd.items.reduce(
    (sum, record) => sum + (record.item.nutrients.calories ?? 0),
    0,
);
if (photoTotal !== 366) {
    throw new Error(`Photo draft totals did not recompute: ${photoTotal}`);
}

// Weak ungrounded add → draft question, items unchanged.
const questionOutcome = await addTextToPhotoDraft({
    userId: userA,
    draft: photoAdd,
    text: "added qwixle",
    deps: { search: addSearch as never },
});
if (questionOutcome.status !== "question") {
    throw new Error("Weak ungrounded add did not become a question");
}
photoAdd = questionOutcome.draft;
if (
    photoAdd.items.length !== 2 ||
    !photoAdd.questions.some(
        (question) =>
            question.status === "open" &&
            question.questionKey.startsWith("photo_draft_add_unresolved_"),
    )
) {
    throw new Error("Unresolved add question was not persisted on the draft");
}

// Unparseable add → honest no-add, draft completely unchanged.
const versionBeforeNoAdd = photoAdd.version;
const noAddOutcome = await addTextToPhotoDraft({
    userId: userA,
    draft: photoAdd,
    text: "the weather is nice today",
    deps: {
        search: addSearch as never,
        parseWithModel: async () => ({ items: [], replaces: null }),
    },
});
if (
    noAddOutcome.status !== "no_add" ||
    noAddOutcome.draft.version !== versionBeforeNoAdd ||
    noAddOutcome.draft.items.length !== 2
) {
    throw new Error("Unparseable add changed the draft");
}

// Replacement rides remove+add: chicken out, broccoli in.
const replaceOutcome = await addTextToPhotoDraft({
    userId: userA,
    draft: photoAdd,
    text: "actually steamed broccoli, not grilled chicken breast",
    deps: { search: addSearch as never },
});
if (
    replaceOutcome.status !== "added" ||
    replaceOutcome.replacedItemName !== "grilled chicken breast"
) {
    throw new Error("Replacement add did not report the removed item");
}
photoAdd = replaceOutcome.draft;
if (
    photoAdd.items.some((record) =>
        record.item.name.includes("chicken breast"),
    ) ||
    !photoAdd.items.some((record) => record.item.name.includes("Broccoli"))
) {
    throw new Error("Replacement did not swap the draft items");
}

// Confirm-before-save is unchanged: the open add question must be
// accepted through the existing path before confirmation succeeds,
// and the logged meal carries butter + broccoli only (102 + 35).
photoAdd = await prepareMealDraftConfirmation({
    userId: userA,
    draftId: photoAdd.id,
    expectedVersion: photoAdd.version,
    acceptRemainingAssumptions: true,
});
photoAdd = await confirmMealDraft({
    userId: userA,
    draftId: photoAdd.id,
    expectedVersion: photoAdd.version,
    confirmed: true,
});
const photoMeal = await getStructuredMeal(userA, photoAdd.confirmedMealId!);
if (!photoMeal || photoMeal.calories !== 137 || photoMeal.items.length !== 2) {
    throw new Error(
        `Confirmed photo-add draft logged wrong totals: ${photoMeal?.calories}`,
    );
}

// --- Photo-draft answer route regression (2026-11-12) ---------------
// Production failure (draft 26907262-644c-4fb2-b4ef-c96eae561fd5,
// question photo_portion_0): answering a photo draft's item-linked
// portion question through the app route returned 400 twice and the
// dinner could not be logged. The repository's prior-reconciliation
// precondition — written for MODEL callers — is unsatisfiable for
// pipeline-created drafts: items are inserted before their questions,
// so an item's updated_at can never be later than its question's
// created_at. The app route is exercised over real HTTP here, exactly
// as the packaged client calls it (bearer session, answer-only body).
const { createAppRouter } = await import("../src/app/routes.js");
const { createMealPhotoDraft } = await import("../src/meal-photo/pipeline.js");
const routeIdentity = await createSmokeIdentity("draft-route");
const routeBearer = `smoke-${crypto.randomUUID()}`;
{
    const { SQL } = await import("bun");
    const sql = new SQL({ url: process.env.DATABASE_URL!, max: 1 });
    await sql`
        insert into munch.auth_sessions (id, user_id, token, expires_at)
        values (
            ${crypto.randomUUID()}, ${routeIdentity.userId},
            ${routeBearer}, now() + interval '1 hour'
        )
    `;
    await sql.close();
}
const appRouter = createAppRouter();
async function answerQuestionViaRoute(
    draftId: string,
    questionId: string,
    expectedVersion: number,
    answer: string,
): Promise<Response> {
    return appRouter.request(
        `https://munch.example/api/app/meal-drafts/${draftId}/questions/${questionId}/answer`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${routeBearer}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                expected_version: expectedVersion,
                answer,
            }),
        },
    );
}
const lasagnaVision = {
    items: [
        {
            name: "lasagna",
            cooking_method: "baked",
            quantity: 1.5,
            unit: "cup",
            portion_confidence: 0.6,
            assumptions: ["Estimated portion from bowl size"],
        },
    ],
};
const noCandidates = async () => ({ candidates: [], failures: [] });
const lasagnaEstimate = async () =>
    new Map([
        [
            "item:0",
            {
                nutrients: {
                    calories: 600,
                    protein_g: 28,
                    carbs_g: 48,
                    fat_g: 26,
                },
            },
        ],
    ]);

// (a) Ordinary portion question: the answer-only POST must succeed,
// and the pipeline's one-transaction persistence must land the same
// draft shape the sequential writes produced.
const photoResult = await createMealPhotoDraft({
    userId: routeIdentity.userId,
    vision: lasagnaVision,
    mealType: "dinner",
    groundingDeps: { search: noCandidates, estimateNutrients: lasagnaEstimate },
});
if (
    photoResult.draft.items.length !== 1 ||
    photoResult.draft.questions.length !== 1 ||
    photoResult.draft.status !== "awaiting_answers" ||
    photoResult.draft.version !== 1
) {
    throw new Error(
        `Bulk photo draft persistence landed the wrong shape: ${JSON.stringify(photoResult.draft)}`,
    );
}
const photoPortionQuestion = photoResult.draft.questions[0]!;
if (
    photoPortionQuestion.questionKey !== "photo_portion_0" ||
    photoPortionQuestion.itemId !== photoResult.draft.items[0]!.id
) {
    throw new Error("Photo portion question was not item-linked as expected");
}
const answerResponse = await answerQuestionViaRoute(
    photoResult.draft.id,
    photoPortionQuestion.id,
    photoResult.draft.version,
    "About 1.5 cups — that's right.",
);
if (answerResponse.status !== 200) {
    throw new Error(
        `Photo portion answer via the app route failed: ${answerResponse.status} ${await answerResponse.text()}`,
    );
}
const answeredBody = (await answerResponse.json()) as {
    draft: { questions: Array<{ status: string }> };
};
if (answeredBody.draft.questions[0]?.status !== "answered") {
    throw new Error("App-route answer did not close the portion question");
}

// (b) The model-surface default still refuses answer-only closure:
// the same repository call WITHOUT the app route's opt-out must keep
// requiring prior item reconciliation.
const modelDraft = await createMealPhotoDraft({
    userId: routeIdentity.userId,
    vision: lasagnaVision,
    mealType: "dinner",
    groundingDeps: { search: noCandidates, estimateNutrients: lasagnaEstimate },
});
let modelRefusal = "";
try {
    await answerMealDraftQuestion({
        userId: routeIdentity.userId,
        draftId: modelDraft.draft.id,
        expectedVersion: modelDraft.draft.version,
        questionId: modelDraft.draft.questions[0]!.id,
        answer: "About 1.5 cups.",
    });
} catch (error) {
    modelRefusal = String(error);
}
if (!modelRefusal.includes("requires reconciling")) {
    throw new Error(
        `Model-surface answer-only closure was not refused: ${modelRefusal}`,
    );
}

// (c) A BLOCKING question (no nutrition values) still cannot be
// closed by answer text alone — even through the app route — but the
// refusal must say what to do; once the item carries values (the
// editor save), the same answer succeeds.
const blockedResult = await createMealPhotoDraft({
    userId: routeIdentity.userId,
    vision: lasagnaVision,
    mealType: "dinner",
    groundingDeps: {
        search: noCandidates,
        estimateNutrients: async () => new Map(),
    },
});
const photoBlockingQuestion = blockedResult.draft.questions[0]!;
if (photoBlockingQuestion.questionKey !== "photo_estimate_missing_0") {
    throw new Error("Estimate-missing draft did not raise a blocking question");
}
const blockedResponse = await answerQuestionViaRoute(
    blockedResult.draft.id,
    photoBlockingQuestion.id,
    blockedResult.draft.version,
    "I don't know its nutrition.",
);
if (blockedResponse.status !== 400) {
    throw new Error(
        `Blocking question was closed by answer text alone: ${blockedResponse.status}`,
    );
}
const blockedBody = (await blockedResponse.json()) as { message?: string };
if (!blockedBody.message?.includes("needs nutrition")) {
    throw new Error(
        `Blocking refusal did not explain the fix: ${JSON.stringify(blockedBody)}`,
    );
}
let blockedDraft = await getMealDraft(
    routeIdentity.userId,
    blockedResult.draft.id,
);
blockedDraft = await upsertMealDraftItem({
    userId: routeIdentity.userId,
    draftId: blockedResult.draft.id,
    expectedVersion: blockedDraft!.version,
    position: 0,
    item: {
        ...blockedDraft!.items[0]!.item,
        nutrients: { calories: 600, protein_g: 28, carbs_g: 48, fat_g: 26 },
        sourceType: "user_supplied",
    },
});
const resolvedResponse = await answerQuestionViaRoute(
    blockedResult.draft.id,
    photoBlockingQuestion.id,
    blockedDraft.version,
    "Confirmed the lasagna nutrition from the recipe card.",
);
if (resolvedResponse.status !== 200) {
    throw new Error(
        `Blocking answer after supplying nutrition failed: ${resolvedResponse.status} ${await resolvedResponse.text()}`,
    );
}

await closePlatformDatabase();
console.log(
    "Munch meal draft state, confirmation, idempotency, and RLS smoke test passed.",
);
