#!/usr/bin/env bun

import { createSmokeIdentity } from "./support/smoke-user.js";

const {
    addCookUpdate,
    compareCooks,
    createCook,
    deleteCook,
    finishCook,
    getCook,
    logCookPortion,
    parseNaturalCookUpdate,
    prepareCookRecipeDraft,
    recordCookOutcome,
    repeatCook,
    saveCookAsRecipe,
    searchCooks,
    setPreferredCook,
    updateCook,
    updateCookDish,
} = await import("../src/cooks/repository.js");
const { updateRecipe } = await import("../src/planning/repository.js");
const { closePlatformDatabase, withUserDatabase } =
    await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Cooks smoke tests");
}

const owner = await createSmokeIdentity("cooks-owner");
const outsider = await createSmokeIdentity("cooks-outsider");

function photo(fileName: string, byte: number) {
    return {
        bytes: new Uint8Array([0xff, 0xd8, 0xff, byte]),
        mimeType: "image/jpeg",
        fileName,
    };
}

async function sideEffectCounts(userId: string) {
    return withUserDatabase(userId, async (tx) => {
        const meals = await tx<Array<{ count: string }>>`
            select count(*)::text as count from munch.meals where user_id = ${userId}
        `;
        const pantry = await tx<Array<{ count: string }>>`
            select count(*)::text as count
            from munch.inventory_events event
            join munch.inventory_spaces space
              on space.id = event.inventory_space_id
            where space.personal_owner_user_id = ${userId}
        `;
        return {
            meals: Number(meals[0]?.count ?? 0),
            pantryEvents: Number(pantry[0]?.count ?? 0),
        };
    });
}

const before = await sideEffectCounts(owner.userId);
const initialMessage =
    "I'm starting these wings. I heated the grill to 250°F a couple minutes ago.";
const initialEvents = parseNaturalCookUpdate(
    initialMessage,
    "2026-09-14T18:00:00.000Z",
    "America/New_York",
).events;
const started = await createCook(owner.userId, {
    title: "Smoked lemon pepper wings",
    cookDate: "2026-09-14",
    timezone: "America/New_York",
    originalMessage: initialMessage,
    message: initialMessage,
    events: initialEvents,
    dishes: [
        {
            name: "Wings",
            ingredientOrCut: "chicken wings",
            method: "smoked",
            flavor: "lemon pepper",
            equipment: "grill",
            actualIngredients: [
                { name: "Chicken wings", quantity: 2, unit: "lb" },
                { name: "Lemon pepper", quantity: 2, unit: "tbsp" },
            ],
        },
    ],
    photos: [photo("starting-wings.jpg", 1)],
    source: "website",
    idempotencyKey: "cooks-start-website",
});
let cook = await getCook(owner.userId, started.cookId);
if (!cook || cook.media.length !== 1 || cook.events.length !== 1) {
    throw new Error(
        "Website-style cook creation did not persist its photo/event",
    );
}
const editedDish = await updateCookDish(
    owner.userId,
    started.cookId,
    cook.dishes[0]!.id,
    {
        equipment: "pellet grill",
        actualIngredients: [
            { name: "Chicken wings", quantity: 2, unit: "lb" },
            { name: "Lemon pepper", quantity: 2, unit: "tbsp" },
        ],
        expectedVersion: cook.cook.version,
    },
);
if (
    editedDish.dish.equipment !== "pellet grill" ||
    !Array.isArray(editedDish.dish.actual_ingredients) ||
    editedDish.dish.actual_ingredients.length !== 2
) {
    throw new Error(
        "Cook dish labels and actual ingredients were not editable",
    );
}

const updateMessage =
    "A couple minutes ago I wrapped and sauced the wings. Internal temp was 155°F.";
const updateEvents = parseNaturalCookUpdate(
    updateMessage,
    "2026-09-14T18:10:00.000Z",
    "America/New_York",
).events;
const updated = await addCookUpdate(owner.userId, started.cookId, {
    source: "mcp",
    message: updateMessage,
    timezone: "America/New_York",
    submittedAt: "2026-09-14T18:10:00.000Z",
    events: updateEvents,
    photos: [photo("wrapped-wings.jpg", 2)],
    idempotencyKey: "cooks-update-mcp",
});
if (updated.eventIds.length !== 2 || updated.mediaIds.length !== 1) {
    throw new Error(
        "MCP-style cook update did not persist multiple events/photo",
    );
}

const question = await addCookUpdate(owner.userId, started.cookId, {
    source: "mcp",
    message: "Should I add more smoke now?",
    events: parseNaturalCookUpdate("Should I add more smoke now?").events,
    idempotencyKey: "cooks-advisory-question",
});
if (question.eventIds.length !== 0) {
    throw new Error("Advisory question became a factual cook event");
}

const failedKey = "cooks-interrupted-upload";
const failed = await createCook(owner.userId, {
    title: "Spicy smoked wings",
    cookDate: "2026-09-13",
    timezone: "America/New_York",
    message: "I started spicy smoked wings.",
    dishes: [
        {
            name: "Wings",
            ingredientOrCut: "chicken wings",
            method: "smoked",
            flavor: "spicy",
            actualIngredients: [{ name: "Chicken wings" }],
        },
    ],
    mediaFailures: [
        {
            fileName: "spicy-wings.jpg",
            code: "download_failed",
            message: "The photo was not saved: interrupted transfer",
        },
    ],
    source: "mcp",
    idempotencyKey: failedKey,
});
if (!failed.update || failed.update.mediaFailures.length !== 1) {
    throw new Error("Interrupted photo transfer was not reported separately");
}
const retried = await createCook(owner.userId, {
    title: "Spicy smoked wings",
    message: "I started spicy smoked wings.",
    photos: [photo("spicy-wings.jpg", 3)],
    source: "mcp",
    idempotencyKey: failedKey,
});
if (!retried.deduplicated || !retried.update?.mediaIds.length) {
    throw new Error(
        "Retry did not attach a recovered photo to the original cook",
    );
}

const mac = await createCook(owner.userId, {
    title: "Smoked mac and cheese",
    cookDate: "2026-09-12",
    timezone: "America/New_York",
    notes: "The top browned evenly and the smoke stayed mild.",
    message:
        "Finished smoked mac and cheese; next time use a little more smoke.",
    dishes: [
        { name: "Mac and cheese", method: "smoked", flavor: "cheesy" },
        { name: "Garlic bread", method: "grilled", flavor: "garlic" },
    ],
    photos: [photo("mac-and-cheese.jpg", 4)],
    status: "finished",
    source: "website",
    idempotencyKey: "cooks-mac-and-cheese",
});

const broad = await searchCooks(owner.userId, { query: "wings" });
const grouped = await searchCooks(owner.userId, {
    query: "smoked chicken wings",
});
const lemon = await searchCooks(owner.userId, { flavor: "lemon pepper" });
const spicy = await searchCooks(owner.userId, { flavor: "spicy" });
if (
    broad.length < 2 ||
    grouped.length < 2 ||
    lemon.length !== 1 ||
    lemon[0]?.title !== "Smoked lemon pepper wings" ||
    spicy.length !== 1 ||
    spicy[0]?.title !== "Spicy smoked wings"
) {
    throw new Error(
        "Cook history search did not separate broad and flavor filters",
    );
}
const macHistory = await searchCooks(owner.userId, {
    query: "smoked mac and cheese",
});
const macDetail = await getCook(owner.userId, mac.cookId);
if (!macHistory.length || !macDetail?.media.length || !macDetail.cook.notes) {
    throw new Error(
        "Fresh cook-history recall omitted mac-and-cheese photo/notes",
    );
}

const outcome = await recordCookOutcome(owner.userId, started.cookId, {
    writtenFeedback:
        "Bright lemon flavor and crisp skin; a little dry at the edges.",
    overallAssessment: 4,
    characteristics: {
        flavor: "bright",
        smoke_intensity: "medium",
        tenderness: "good",
        crispness: "high",
    },
    worked: "Lemon pepper and the final high-heat finish.",
    disappointed: "Edges dried out.",
    nextTimeNotes: "Finish hotter and pull two minutes earlier.",
    isPreferred: true,
});
if (!outcome.next_time_notes || !outcome.is_preferred) {
    throw new Error("Cook outcome did not preserve user result and preference");
}
await setPreferredCook(owner.userId, started.cookId);
const comparison = await compareCooks(owner.userId, [
    started.cookId,
    failed.cookId,
]);
if (comparison.cooks.length !== 2 || comparison.photos[0]?.length !== 2) {
    throw new Error("Cook comparison did not include selected attempts/photos");
}

const draft = await prepareCookRecipeDraft(owner.userId, started.cookId);
if (
    draft.missing_fields.length !== 0 ||
    draft.draft.instructions.length === 0 ||
    draft.draft.ingredients.length === 0
) {
    throw new Error(
        "Cook recipe draft did not carry forward reviewable cook details",
    );
}
const saved = await saveCookAsRecipe({
    userId: owner.userId,
    cookId: started.cookId,
    scope: { type: "personal" },
    recipe: {
        name: "Smoked lemon pepper wings",
        servings: 4,
        instructions: [
            "Season the wings.",
            "Smoke until cooked.",
            "Finish hot for crisp skin.",
        ],
        sourceType: "user_entered",
        ingredients: [
            {
                name: "Chicken wings",
                quantity: 2,
                unit: "lb",
                sourceType: "user_supplied",
                nutrients: { calories: 1_200, protein_g: 120, fat_g: 80 },
            },
            {
                name: "Lemon pepper",
                quantity: 2,
                unit: "tbsp",
                sourceType: "user_supplied",
                nutrients: { calories: 10, sodium_mg: 100 },
            },
        ],
    },
    idempotencyKey: "cooks-save-recipe",
});
const linked = await getCook(owner.userId, started.cookId);
const linkedDish = linked?.dishes[0];
if (
    linkedDish?.recipe_id !== saved.result.recipeId ||
    linkedDish.recipe_revision_id !== saved.result.revisionId
) {
    throw new Error(
        "Reviewed recipe was not linked to the exact cook revision",
    );
}
const revisionTwo = await updateRecipe({
    userId: owner.userId,
    scope: { type: "personal" },
    recipeId: saved.result.recipeId,
    recipe: {
        name: "Smoked lemon pepper wings",
        servings: 4,
        instructions: [
            "Season more boldly.",
            "Smoke until cooked.",
            "Finish hot.",
        ],
        sourceType: "user_entered",
        ingredients: [
            {
                name: "Chicken wings",
                quantity: 2,
                unit: "lb",
                sourceType: "user_supplied",
                nutrients: { calories: 1_200, protein_g: 120, fat_g: 80 },
            },
        ],
    },
    expectedVersion: 1,
    idempotencyKey: "cooks-save-recipe-revision-2",
});
const preserved = await getCook(owner.userId, started.cookId);
if (
    revisionTwo.revisionId === saved.result.revisionId ||
    preserved?.dishes[0]?.recipe_revision_id !== saved.result.revisionId
) {
    throw new Error("Later recipe revision rewrote the cook's historical link");
}

const repeated = await repeatCook(
    owner.userId,
    started.cookId,
    "cooks-repeat-attempt",
);
const repeatedDetail = await getCook(owner.userId, repeated.cookId);
if (
    repeated.sourceCookId !== started.cookId ||
    repeatedDetail?.events.length !== 0 ||
    repeatedDetail.media.length !== 0 ||
    repeatedDetail.dishes[0]?.recipe_revision_id !== saved.result.revisionId
) {
    throw new Error(
        "Cook again did not create a fresh history with useful setup",
    );
}

const beforeMeal = await sideEffectCounts(owner.userId);
const logged = await logCookPortion({
    userId: owner.userId,
    cookId: started.cookId,
    servingsConsumed: 0.5,
    mealType: "dinner",
    idempotencyKey: "cooks-explicit-portion",
});
const afterMeal = await sideEffectCounts(owner.userId);
if (
    logged.recipe_revision_id !== saved.result.revisionId ||
    afterMeal.meals !== beforeMeal.meals + 1 ||
    afterMeal.pantryEvents !== beforeMeal.pantryEvents
) {
    throw new Error(
        "Explicit portion boundary changed the wrong persistence paths",
    );
}

const current = await getCook(owner.userId, started.cookId);
if (!current) throw new Error("Cook disappeared before concurrency check");
const concurrent = await Promise.allSettled([
    updateCook(owner.userId, started.cookId, {
        notes: "Concurrent edit A",
        expectedVersion: current.cook.version,
    }),
    updateCook(owner.userId, started.cookId, {
        notes: "Concurrent edit B",
        expectedVersion: current.cook.version,
    }),
]);
if (
    concurrent.filter((result) => result.status === "fulfilled").length !== 1 ||
    concurrent.filter((result) => result.status === "rejected").length !== 1
) {
    throw new Error(
        "Optimistic cook edits did not reject one stale concurrent write",
    );
}

if (await getCook(outsider.userId, started.cookId)) {
    throw new Error("Outsider could read another user's cook");
}
if (await deleteCook(outsider.userId, started.cookId)) {
    throw new Error("Outsider could delete another user's cook");
}

const mediaBytes = await withUserDatabase(
    owner.userId,
    async (tx) =>
        tx<Array<{ byte_length: number; sha256: string }>>`
        select octet_length(bytes) as byte_length, sha256
        from munch.cook_media
        where cook_id = ${started.cookId}
        order by created_at, id
    `,
);
if (
    mediaBytes.length !== 2 ||
    mediaBytes.some((row) => row.byte_length !== 4)
) {
    throw new Error("Durable cook photo bytes were not retained");
}

await finishCook(owner.userId, started.cookId);
await closePlatformDatabase();
const freshSession = await getCook(owner.userId, started.cookId);
if (!freshSession?.media.length || !freshSession.updates.length) {
    throw new Error(
        "Cook history was not available after reopening the database session",
    );
}
await closePlatformDatabase();
console.log(
    "Munch Cooks PostgreSQL persistence, media retry, timeline, RLS, concurrency, recipe, nutrition, and Pantry-boundary smoke test passed.",
);
