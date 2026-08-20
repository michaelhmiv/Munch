import { Hono, type Context } from "hono";
import { resolveMunchCapabilities } from "../billing/capabilities.js";
import {
    getHouseholdSeatCoverage,
    ownerCanPurchaseHouseholdSeats,
} from "../billing/household-seats.js";
import {
    listHouseholdMembers,
    listPendingHouseholdInvitations,
} from "../households/repository.js";
import { requireSameOrigin } from "../accounts/csrf.js";
import { requireWebSession } from "../accounts/session.js";
import { getSubscriptionSnapshot } from "../billing/repository.js";
import {
    listOAuthConnections,
    revokeOAuthConnection,
} from "../portal/repository.js";
import {
    deleteMeal,
    deleteWater,
    deleteWeight,
    getNutritionGoals,
    insertWater,
    insertWeight,
    updateMeal,
    upsertNutritionGoals,
    upsertProfile,
} from "../storage.js";
import { getStructuredMeal } from "../structured-meals/repository.js";
import {
    archiveRecipe,
    getRecipe,
    logRecipe,
    scheduleRecipe,
    updateRecipe,
    type PlanningScope,
    type RecipeInput,
} from "../planning/repository.js";
import { validateTz } from "../tz.js";
import { isPlausibleWeightGrams, isWeightUnit, toGrams } from "../units.js";
import {
    addStructuredMealItem,
    copyMeal,
    deleteStructuredMealItem,
    updateStructuredMealItem,
} from "./meal-mutations.js";
import {
    createAppMeal,
    getAppFoodDetails,
    lookupAppFoodBarcode,
    resolveWebMealItem,
    searchAppFoods,
} from "./meal-entry.js";
import {
    draftItemInputFromBody,
    serializeMealDraftForApp,
} from "./meal-draft-review.js";
import {
    answerMealDraftQuestion,
    cancelMealDraft,
    confirmMealDraft,
    deleteMealDraftItem,
    getMealDraft,
    prepareMealDraftConfirmation,
    updateMealDraftMetadata,
    upsertMealDraftItem,
} from "../meal-drafts/index.js";
import {
    getAppBootstrap,
    getFoodsWorkspace,
    getHouseholdWorkspace,
    getInsightsWorkspace,
    getMealHistoryWorkspace,
    getPlanningWorkspace,
    getRecipeWorkspace,
    getTodayWorkspace,
} from "./repository.js";

function requiredQuery(value: string | undefined, name: string): string {
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function optionalLimit(value: string | undefined): number | undefined {
    if (value === undefined || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 25) {
        throw new Error("Invalid result limit");
    }
    return parsed;
}

function numberOrNull(value: unknown): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("Invalid number");
    }
    return parsed;
}

function positiveNumber(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("Invalid quantity");
    }
    return parsed;
}

function nonnegativeNumber(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("Invalid nonnegative number");
    }
    return parsed;
}

function privateJson(c: Context, data: unknown) {
    return c.json(data, 200, {
        "Cache-Control": "no-store, private",
        Pragma: "no-cache",
    });
}

function mealType(value: unknown) {
    if (
        value === "breakfast" ||
        value === "lunch" ||
        value === "dinner" ||
        value === "snack"
    ) {
        return value;
    }
    throw new Error("Invalid meal type");
}

function structuredSourceType(value: unknown) {
    if (
        value === "usda" ||
        value === "open_food_facts" ||
        value === "published_restaurant" ||
        value === "saved_food" ||
        value === "past_meal" ||
        value === "user_supplied" ||
        value === "model_estimate" ||
        value === "legacy_aggregate"
    ) {
        return value;
    }
    throw new Error("Invalid food source type");
}

function recipeSourceType(value: unknown): RecipeInput["sourceType"] {
    if (
        value === "user_entered" ||
        value === "chatgpt_generated" ||
        value === "imported"
    ) {
        return value;
    }
    throw new Error("Invalid recipe source type");
}

function recipeIngredientSourceType(
    value: unknown,
): RecipeInput["ingredients"][number]["sourceType"] {
    if (
        value === "usda" ||
        value === "open_food_facts" ||
        value === "published_restaurant" ||
        value === "saved_food" ||
        value === "past_meal" ||
        value === "user_supplied" ||
        value === "model_estimate"
    ) {
        return value;
    }
    throw new Error("Invalid recipe ingredient source type");
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function draftExpectedVersion(body: Record<string, unknown>): number {
    const value = Number(body.expected_version);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error("Meal draft expected_version is required");
    }
    return value;
}

function draftText(
    body: Record<string, unknown>,
    key: string,
    maxLength: number,
): string | null | undefined {
    const value = body[key];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "string" || value.trim().length > maxLength) {
        throw new Error(`Meal draft ${key} is invalid`);
    }
    return value.trim() || null;
}

function recipeInputFromBody(value: unknown): RecipeInput {
    const body = recordValue(value, "Recipe");
    const name = typeof body.name === "string" ? body.name : "";
    const servings = positiveNumber(body.servings);
    const instructions = Array.isArray(body.instructions)
        ? body.instructions.filter(
              (item): item is string => typeof item === "string",
          )
        : [];
    if (
        !servings ||
        !name.trim() ||
        instructions.length !==
            (body.instructions as unknown[] | undefined)?.length
    ) {
        throw new Error("Recipe name, servings, and instructions are required");
    }
    if (!Array.isArray(body.ingredients)) {
        throw new Error("Recipe ingredients are required");
    }
    return {
        name,
        servings,
        description:
            typeof body.description === "string" ? body.description : undefined,
        instructions,
        preparationMinutes:
            body.preparation_minutes === undefined
                ? undefined
                : nonnegativeNumber(body.preparation_minutes),
        cookingMinutes:
            body.cooking_minutes === undefined
                ? undefined
                : nonnegativeNumber(body.cooking_minutes),
        sourceType: recipeSourceType(body.source_type),
        sourceTitle:
            typeof body.source_title === "string"
                ? body.source_title
                : undefined,
        sourceUrl:
            typeof body.source_url === "string" ? body.source_url : undefined,
        ingredients: body.ingredients.map((raw) => {
            const ingredient = recordValue(raw, "Recipe ingredient");
            const quantity =
                ingredient.quantity === undefined
                    ? undefined
                    : positiveNumber(ingredient.quantity);
            const gramWeight =
                ingredient.gram_weight === undefined
                    ? undefined
                    : positiveNumber(ingredient.gram_weight);
            const confidence =
                ingredient.confidence === undefined
                    ? undefined
                    : Number(ingredient.confidence);
            if (
                typeof ingredient.name !== "string" ||
                (confidence !== undefined &&
                    (!Number.isFinite(confidence) ||
                        confidence < 0 ||
                        confidence > 1))
            ) {
                throw new Error("Recipe ingredient fields are invalid");
            }
            const sourceSnapshot =
                ingredient.source_snapshot &&
                typeof ingredient.source_snapshot === "object" &&
                !Array.isArray(ingredient.source_snapshot)
                    ? (ingredient.source_snapshot as Record<string, unknown>)
                    : undefined;
            const nutrients =
                ingredient.nutrients &&
                typeof ingredient.nutrients === "object" &&
                !Array.isArray(ingredient.nutrients)
                    ? (ingredient.nutrients as RecipeInput["ingredients"][number]["nutrients"])
                    : undefined;
            return {
                name: ingredient.name,
                quantity,
                unit:
                    typeof ingredient.unit === "string"
                        ? ingredient.unit
                        : undefined,
                preparation:
                    typeof ingredient.preparation === "string"
                        ? ingredient.preparation
                        : undefined,
                optional:
                    typeof ingredient.optional === "boolean"
                        ? ingredient.optional
                        : undefined,
                gramWeight,
                nutrients,
                provider:
                    typeof ingredient.provider === "string"
                        ? ingredient.provider
                        : undefined,
                providerFoodId:
                    typeof ingredient.provider_food_id === "string"
                        ? ingredient.provider_food_id
                        : undefined,
                sourceType: recipeIngredientSourceType(ingredient.source_type),
                sourceUrl:
                    typeof ingredient.source_url === "string"
                        ? ingredient.source_url
                        : undefined,
                confidence,
                sourceSnapshot,
            };
        }),
    };
}

function recipeScopeForCapabilities(
    recipe: NonNullable<Awaited<ReturnType<typeof getRecipe>>>,
    capabilities: Awaited<ReturnType<typeof resolveMunchCapabilities>>,
    write: boolean,
    planning = false,
): PlanningScope {
    if (recipe.ownership.type === "personal") {
        const allowed = planning
            ? write
                ? capabilities.personalPlanningWrite
                : capabilities.personalPlanningRead
            : write
              ? capabilities.personalRecipesWrite
              : capabilities.personalRecipesRead;
        if (!allowed)
            throw new Error("Personal recipe capability is unavailable");
        return { type: "personal" };
    }
    const household = capabilities.household;
    const allowed = planning
        ? write
            ? capabilities.householdWrite
            : capabilities.householdRead
        : write
          ? capabilities.householdWrite
          : capabilities.householdRead;
    if (
        !allowed ||
        !household ||
        household.householdId !== recipe.ownership.household_id
    ) {
        throw new Error("Household recipe capability is unavailable");
    }
    return { type: "household", householdId: household.householdId };
}

const STRUCTURED_NUTRIENT_FIELDS = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "alcohol_g",
] as const;

export function createAppRouter(): Hono {
    const app = new Hono();

    app.get("/app.js", async (c) =>
        c.body(await Bun.file("./public/app.js").text(), 200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
        }),
    );
    app.get("/weight-display.js", async (c) =>
        c.body(await Bun.file("./public/weight-display.js").text(), 200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
        }),
    );
    app.get("/app-account.js", async (c) =>
        c.body(await Bun.file("./public/app-account.js").text(), 200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
        }),
    );
    app.get("/account-settings.css", async (c) =>
        c.body(await Bun.file("./public/account-settings.css").text(), 200, {
            "Content-Type": "text/css; charset=utf-8",
            "Cache-Control": "no-cache",
        }),
    );
    app.get("/app", async (c) =>
        c.html(await Bun.file("./public/app.html").text(), 200, {
            "Cache-Control": "no-store, private",
        }),
    );
    app.get("/app/*", async (c) =>
        c.html(await Bun.file("./public/app.html").text(), 200, {
            "Cache-Control": "no-store, private",
        }),
    );

    app.use("/api/app/*", requireWebSession);

    app.get("/api/app/bootstrap", async (c) =>
        privateJson(
            c,
            await getAppBootstrap(
                c.get("munchUserId"),
                c.get("munchUserEmail"),
            ),
        ),
    );

    app.get("/api/app/today", async (c) =>
        privateJson(
            c,
            await getTodayWorkspace(
                c.get("munchUserId"),
                requiredQuery(c.req.query("date"), "date"),
            ),
        ),
    );

    app.get("/api/app/meals", async (c) =>
        privateJson(
            c,
            await getMealHistoryWorkspace(
                c.get("munchUserId"),
                requiredQuery(c.req.query("start"), "start"),
                requiredQuery(c.req.query("end"), "end"),
            ),
        ),
    );

    app.post("/api/app/meals", requireSameOrigin, async (c) => {
        const body = recordValue(await c.req.json(), "Meal");
        if (!Array.isArray(body.items)) {
            throw new Error("Meal items are required");
        }
        const result = await createAppMeal(c.get("munchUserId"), {
            description: body.description,
            mealType: body.meal_type,
            loggedAt: body.logged_at,
            notes: body.notes,
            idempotencyKey: body.idempotency_key,
            items: body.items.map((item) => recordValue(item, "Meal item")),
        });
        return privateJson(c, {
            meal: result.meal,
            deduplicated: result.deduplicated,
        });
    });

    app.get("/api/app/meals/:id", async (c) => {
        const meal = await getStructuredMeal(
            c.get("munchUserId"),
            c.req.param("id")!,
        );
        if (!meal) throw new Error("Meal not found");
        return privateJson(c, { meal });
    });

    app.get("/api/app/foods", async (c) =>
        privateJson(c, await getFoodsWorkspace(c.get("munchUserId"))),
    );

    app.get("/api/app/food-search", async (c) =>
        privateJson(
            c,
            await searchAppFoods(
                c.get("munchUserId"),
                c.req.query("query") ?? c.req.query("q") ?? "",
                optionalLimit(c.req.query("limit")),
            ),
        ),
    );

    app.get("/api/app/food-details", async (c) => {
        const candidateId = requiredQuery(
            c.req.query("candidate_id"),
            "candidate_id",
        );
        const food = await getAppFoodDetails(candidateId);
        if (!food) throw new Error("Food candidate not found");
        return privateJson(c, { food });
    });

    app.get("/api/app/food-barcode", async (c) =>
        privateJson(
            c,
            await lookupAppFoodBarcode(
                requiredQuery(c.req.query("barcode"), "barcode"),
            ),
        ),
    );

    app.get("/api/app/meal-drafts/:id", async (c) => {
        const draft = await getMealDraft(
            c.get("munchUserId"),
            c.req.param("id")!,
        );
        if (!draft) throw new Error("Meal draft not found");
        return privateJson(c, { draft: serializeMealDraftForApp(draft) });
    });

    app.patch("/api/app/meal-drafts/:id", requireSameOrigin, async (c) => {
        const body = recordValue(await c.req.json(), "Meal draft");
        const draft = await updateMealDraftMetadata({
            userId: c.get("munchUserId"),
            draftId: c.req.param("id")!,
            expectedVersion: draftExpectedVersion(body),
            mealType:
                body.meal_type === undefined
                    ? undefined
                    : body.meal_type === null
                      ? null
                      : mealType(body.meal_type),
            description: draftText(body, "description", 2_000),
            loggedAt: draftText(body, "logged_at", 100),
            notes: draftText(body, "notes", 4_000),
        });
        return privateJson(c, {
            draft: serializeMealDraftForApp(draft),
        });
    });

    app.post("/api/app/meal-drafts/:id/items", requireSameOrigin, async (c) => {
        const body = recordValue(await c.req.json(), "Meal draft item");
        const userId = c.get("munchUserId");
        const draftId = c.req.param("id")!;
        const current = await getMealDraft(userId, draftId);
        if (!current) throw new Error("Meal draft not found");
        const rawItem = body.item === undefined ? body : body.item;
        const item =
            rawItem &&
            typeof rawItem === "object" &&
            !Array.isArray(rawItem) &&
            "candidate_id" in rawItem
                ? await resolveWebMealItem(rawItem)
                : draftItemInputFromBody(rawItem);
        const draft = await upsertMealDraftItem({
            userId,
            draftId,
            expectedVersion: draftExpectedVersion(body),
            position: current.items.length,
            item,
        });
        return privateJson(c, {
            draft: serializeMealDraftForApp(draft),
        });
    });

    app.patch(
        "/api/app/meal-drafts/:draftId/items/:itemId",
        requireSameOrigin,
        async (c) => {
            const body = recordValue(await c.req.json(), "Meal draft item");
            const userId = c.get("munchUserId");
            const draftId = c.req.param("draftId")!;
            const current = await getMealDraft(userId, draftId);
            if (!current) throw new Error("Meal draft not found");
            const currentItem = current.items.find(
                (item) => item.id === c.req.param("itemId"),
            );
            if (!currentItem) throw new Error("Meal draft item not found");
            const rawItem = body.item === undefined ? body : body.item;
            const item = draftItemInputFromBody(rawItem);
            const draft = await upsertMealDraftItem({
                userId,
                draftId,
                expectedVersion: draftExpectedVersion(body),
                position: currentItem.position,
                item,
            });
            return privateJson(c, {
                draft: serializeMealDraftForApp(draft),
            });
        },
    );

    app.delete(
        "/api/app/meal-drafts/:draftId/items/:itemId",
        requireSameOrigin,
        async (c) => {
            const body = recordValue(
                await c.req.json().catch(() => ({})),
                "Meal draft item delete",
            );
            const draft = await deleteMealDraftItem({
                userId: c.get("munchUserId"),
                draftId: c.req.param("draftId")!,
                itemId: c.req.param("itemId")!,
                expectedVersion: draftExpectedVersion(body),
            });
            return privateJson(c, {
                draft: serializeMealDraftForApp(draft),
            });
        },
    );

    app.post(
        "/api/app/meal-drafts/:draftId/questions/:questionId/answer",
        requireSameOrigin,
        async (c) => {
            const body = recordValue(
                await c.req.json(),
                "Meal draft question answer",
            );
            if (typeof body.answer !== "string" || !body.answer.trim()) {
                throw new Error("Meal draft answer is required");
            }
            const draft = await answerMealDraftQuestion({
                userId: c.get("munchUserId"),
                draftId: c.req.param("draftId")!,
                expectedVersion: draftExpectedVersion(body),
                questionId: c.req.param("questionId")!,
                answer: body.answer,
            });
            return privateJson(c, {
                draft: serializeMealDraftForApp(draft),
            });
        },
    );

    app.post(
        "/api/app/meal-drafts/:id/prepare",
        requireSameOrigin,
        async (c) => {
            const body = recordValue(await c.req.json(), "Meal draft prepare");
            const draft = await prepareMealDraftConfirmation({
                userId: c.get("munchUserId"),
                draftId: c.req.param("id")!,
                expectedVersion: draftExpectedVersion(body),
                acceptRemainingAssumptions:
                    body.accept_remaining_assumptions === true,
            });
            return privateJson(c, {
                draft: serializeMealDraftForApp(draft),
            });
        },
    );

    app.post(
        "/api/app/meal-drafts/:id/confirm",
        requireSameOrigin,
        async (c) => {
            const body = recordValue(await c.req.json(), "Meal draft confirm");
            if (body.confirmed !== true) {
                throw new Error("Meal draft confirmation is required");
            }
            const userId = c.get("munchUserId");
            const draftId = c.req.param("id")!;
            let current = await getMealDraft(userId, draftId);
            if (!current) throw new Error("Meal draft not found");
            if (
                current.status !== "awaiting_confirmation" ||
                current.questions.some((question) => question.status === "open")
            ) {
                current = await prepareMealDraftConfirmation({
                    userId,
                    draftId,
                    expectedVersion: draftExpectedVersion(body),
                    acceptRemainingAssumptions:
                        body.accept_remaining_assumptions === true,
                });
            } else if (current.version !== draftExpectedVersion(body)) {
                throw new Error(
                    `Meal draft changed: expected version ${draftExpectedVersion(body)}, current version ${current.version}`,
                );
            }
            const draft = await confirmMealDraft({
                userId,
                draftId,
                expectedVersion: current.version,
                confirmed: true,
            });
            return privateJson(c, {
                draft: serializeMealDraftForApp(draft),
                meal_id: draft.confirmedMealId,
            });
        },
    );

    app.post(
        "/api/app/meal-drafts/:id/cancel",
        requireSameOrigin,
        async (c) => {
            const body = recordValue(await c.req.json(), "Meal draft cancel");
            if (body.confirm !== true) {
                throw new Error("Meal draft cancellation is required");
            }
            const draft = await cancelMealDraft({
                userId: c.get("munchUserId"),
                draftId: c.req.param("id")!,
                expectedVersion: draftExpectedVersion(body),
            });
            return privateJson(c, {
                draft: serializeMealDraftForApp(draft),
            });
        },
    );

    app.get("/api/app/insights", async (c) =>
        privateJson(
            c,
            await getInsightsWorkspace(
                c.get("munchUserId"),
                requiredQuery(c.req.query("start"), "start"),
                requiredQuery(c.req.query("end"), "end"),
            ),
        ),
    );

    app.get("/api/app/planning", async (c) =>
        privateJson(
            c,
            await getPlanningWorkspace(
                c.get("munchUserId"),
                requiredQuery(c.req.query("start"), "start"),
                requiredQuery(c.req.query("end"), "end"),
            ),
        ),
    );

    app.get("/api/app/recipes/:id", async (c) => {
        const workspace = await getRecipeWorkspace(
            c.get("munchUserId"),
            c.req.param("id")!,
            c.req.query("revision_id") || undefined,
        );
        if (!workspace.available || !workspace.recipe) {
            throw new Error("Recipe not found");
        }
        return privateJson(c, { recipe: workspace.recipe });
    });

    app.patch("/api/app/recipes/:id", requireSameOrigin, async (c) => {
        const userId = c.get("munchUserId");
        const current = await getRecipe(userId, c.req.param("id")!);
        if (!current) throw new Error("Recipe not found");
        const body = recordValue(await c.req.json(), "Recipe update");
        const capabilities = await resolveMunchCapabilities(userId);
        const expectedVersion = Number(body.expected_version);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
            throw new Error("Recipe expected_version is required");
        }
        const result = await updateRecipe({
            userId,
            scope: recipeScopeForCapabilities(current, capabilities, true),
            recipeId: current.id,
            recipe: recipeInputFromBody(body.recipe),
            expectedVersion,
            idempotencyKey:
                typeof body.idempotency_key === "string"
                    ? body.idempotency_key
                    : crypto.randomUUID(),
        });
        return privateJson(c, {
            result,
            recipe: await getRecipe(userId, current.id),
        });
    });

    app.delete("/api/app/recipes/:id", requireSameOrigin, async (c) => {
        const userId = c.get("munchUserId");
        const current = await getRecipe(userId, c.req.param("id")!);
        if (!current) throw new Error("Recipe not found");
        const body = recordValue(
            await c.req.json().catch(() => ({})),
            "Recipe delete",
        );
        const expectedVersion =
            body.expected_version === undefined
                ? undefined
                : Number(body.expected_version);
        const capabilities = await resolveMunchCapabilities(userId);
        const result = await archiveRecipe({
            userId,
            scope: recipeScopeForCapabilities(current, capabilities, true),
            recipeId: current.id,
            expectedVersion,
        });
        return privateJson(c, { recipe: result });
    });

    app.post("/api/app/recipes/:id/log", requireSameOrigin, async (c) => {
        const userId = c.get("munchUserId");
        const current = await getRecipe(userId, c.req.param("id")!);
        if (!current) throw new Error("Recipe not found");
        const body = recordValue(await c.req.json(), "Recipe log");
        const servingsConsumed = positiveNumber(body.servings_consumed);
        if (!servingsConsumed) throw new Error("Serving amount is required");
        const capabilities = await resolveMunchCapabilities(userId);
        recipeScopeForCapabilities(current, capabilities, false);
        const result = await logRecipe({
            userId,
            recipeId: current.id,
            recipeRevisionId:
                typeof body.recipe_revision_id === "string"
                    ? body.recipe_revision_id
                    : undefined,
            servingsConsumed,
            mealType: mealType(body.meal_type),
            loggedAt:
                typeof body.logged_at === "string" ? body.logged_at : undefined,
            notes: typeof body.notes === "string" ? body.notes : undefined,
            plannedMealId:
                typeof body.planned_meal_id === "string"
                    ? body.planned_meal_id
                    : undefined,
            idempotencyKey:
                typeof body.idempotency_key === "string"
                    ? body.idempotency_key
                    : crypto.randomUUID(),
        });
        return privateJson(c, { result });
    });

    app.post("/api/app/recipes/:id/plan", requireSameOrigin, async (c) => {
        const userId = c.get("munchUserId");
        const current = await getRecipe(userId, c.req.param("id")!);
        if (!current) throw new Error("Recipe not found");
        const body = recordValue(await c.req.json(), "Recipe plan");
        const plannedDate =
            typeof body.planned_date === "string" ? body.planned_date : "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate)) {
            throw new Error("Planned date is required");
        }
        const servings = positiveNumber(body.servings);
        if (!servings) throw new Error("Planned servings are required");
        const capabilities = await resolveMunchCapabilities(userId);
        const result = await scheduleRecipe({
            userId,
            scope: recipeScopeForCapabilities(
                current,
                capabilities,
                true,
                true,
            ),
            recipeId: current.id,
            recipeRevisionId: current.revision_id,
            plannedDate,
            mealSlot:
                body.meal_slot === undefined
                    ? undefined
                    : mealType(body.meal_slot),
            servings,
            note: typeof body.note === "string" ? body.note : undefined,
            idempotencyKey:
                typeof body.idempotency_key === "string"
                    ? body.idempotency_key
                    : crypto.randomUUID(),
        });
        return privateJson(c, { planned_meal: result });
    });

    app.get("/api/app/household", async (c) =>
        privateJson(c, await getHouseholdWorkspace(c.get("munchUserId"))),
    );

    app.get("/api/app/household/manage", async (c) => {
        const userId = c.get("munchUserId");
        const capabilities = await resolveMunchCapabilities(userId);
        const household = capabilities.household;
        if (!household) {
            return privateJson(c, {
                household: null,
                members: [],
                pendingInvitations: [],
                tier: capabilities.tier,
                entitlementSource: capabilities.entitlementSource,
                canInvite: false,
                canWrite: false,
                activeNonOwnerCount: 0,
                billedSeatQuantity: 0,
                seatCoverage: true,
            });
        }

        const owner = household.role === "owner";
        const [members, coverage, pendingInvitations, canInvite] =
            await Promise.all([
                listHouseholdMembers(userId, household.householdId),
                getHouseholdSeatCoverage({
                    ownerUserId: household.ownerUserId,
                    householdId: household.householdId,
                }),
                owner
                    ? listPendingHouseholdInvitations(
                          userId,
                          household.householdId,
                      )
                    : Promise.resolve([]),
                owner
                    ? ownerCanPurchaseHouseholdSeats(userId)
                    : Promise.resolve(false),
            ]);

        return privateJson(c, {
            household: {
                householdId: household.householdId,
                householdName: household.householdName,
                role: household.role,
                displayName: household.displayName,
            },
            members: members.map((member) => ({
                membershipId: member.membershipId,
                displayName: member.displayName,
                role: member.role,
                joinedAt: member.joinedAt,
            })),
            pendingInvitations,
            tier: capabilities.tier,
            entitlementSource: capabilities.entitlementSource,
            canInvite,
            canWrite: capabilities.householdWrite,
            activeNonOwnerCount: coverage.activeNonOwnerCount,
            billedSeatQuantity: coverage.billedSeatQuantity,
            seatCoverage: coverage.covered,
        });
    });

    app.get("/api/app/settings", async (c) => {
        const userId = c.get("munchUserId");
        const [bootstrap, goals, subscription, connections] = await Promise.all(
            [
                getAppBootstrap(userId, c.get("munchUserEmail")),
                getNutritionGoals(userId),
                getSubscriptionSnapshot(userId),
                listOAuthConnections(userId),
            ],
        );
        return privateJson(c, {
            ...bootstrap,
            goals,
            subscription,
            connections,
        });
    });

    app.patch("/api/app/meals/:id", requireSameOrigin, async (c) => {
        const body = (await c.req.json()) as Record<string, unknown>;
        const userId = c.get("munchUserId");
        if (
            STRUCTURED_NUTRIENT_FIELDS.some(
                (field) => body[field] !== undefined,
            )
        ) {
            const structured = await getStructuredMeal(
                userId,
                c.req.param("id")!,
            );
            if (structured?.items.length) {
                throw new Error(
                    "Structured meal nutrition must be edited by item",
                );
            }
        }
        const meal = await updateMeal(userId, c.req.param("id")!, {
            ...(typeof body.description === "string"
                ? { description: body.description }
                : {}),
            ...(body.meal_type !== undefined
                ? { meal_type: mealType(body.meal_type) }
                : {}),
            ...(body.calories !== undefined
                ? { calories: numberOrNull(body.calories) ?? undefined }
                : {}),
            ...(body.protein_g !== undefined
                ? { protein_g: numberOrNull(body.protein_g) ?? undefined }
                : {}),
            ...(body.carbs_g !== undefined
                ? { carbs_g: numberOrNull(body.carbs_g) ?? undefined }
                : {}),
            ...(body.fat_g !== undefined
                ? { fat_g: numberOrNull(body.fat_g) ?? undefined }
                : {}),
            ...(body.fiber_g !== undefined
                ? { fiber_g: numberOrNull(body.fiber_g) ?? undefined }
                : {}),
            ...(body.sugar_g !== undefined
                ? { sugar_g: numberOrNull(body.sugar_g) ?? undefined }
                : {}),
            ...(body.alcohol_g !== undefined
                ? { alcohol_g: numberOrNull(body.alcohol_g) ?? undefined }
                : {}),
            ...(typeof body.logged_at === "string"
                ? { logged_at: body.logged_at }
                : {}),
            ...(body.notes === null || typeof body.notes === "string"
                ? { notes: body.notes as string | null }
                : {}),
        });
        return privateJson(c, { meal });
    });

    app.patch(
        "/api/app/meals/:mealId/items/:itemId",
        requireSameOrigin,
        async (c) => {
            const body = (await c.req.json()) as Record<string, unknown>;
            const nutrientBody =
                body.nutrients && typeof body.nutrients === "object"
                    ? (body.nutrients as Record<string, unknown>)
                    : {};
            const nutrients: Record<string, number | null> = {};
            for (const field of [
                "calories",
                "protein_g",
                "carbs_g",
                "fat_g",
                "fiber_g",
                "sugar_g",
                "alcohol_g",
                "sodium_mg",
                "saturated_fat_g",
                "cholesterol_mg",
                "potassium_mg",
            ]) {
                const value = numberOrNull(nutrientBody[field]);
                if (value !== undefined) nutrients[field] = value;
            }
            const meal = await updateStructuredMealItem(
                c.get("munchUserId"),
                c.req.param("mealId")!,
                c.req.param("itemId")!,
                {
                    ...(body.quantity !== undefined
                        ? { quantity: positiveNumber(body.quantity) }
                        : {}),
                    ...(typeof body.portion_label === "string"
                        ? { portionLabel: body.portion_label }
                        : {}),
                    ...(Object.keys(nutrients).length ? { nutrients } : {}),
                },
            );
            return privateJson(c, { meal });
        },
    );

    app.post("/api/app/meals/:mealId/items", requireSameOrigin, async (c) => {
        const body = (await c.req.json()) as Record<string, unknown>;
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) throw new Error("Meal item name is required");
        const nutrientBody =
            body.nutrients && typeof body.nutrients === "object"
                ? (body.nutrients as Record<string, unknown>)
                : {};
        const nutrients: Record<string, number> = {};
        for (const field of [
            "calories",
            "protein_g",
            "carbs_g",
            "fat_g",
            "fiber_g",
            "sugar_g",
            "alcohol_g",
            "sodium_mg",
            "saturated_fat_g",
            "cholesterol_mg",
            "potassium_mg",
        ]) {
            const value = numberOrNull(nutrientBody[field]);
            if (typeof value === "number") nutrients[field] = value;
        }
        const assumptions = Array.isArray(body.assumptions)
            ? body.assumptions.filter(
                  (value): value is string =>
                      typeof value === "string" && value.trim().length > 0,
              )
            : [];
        const sourceSnapshot =
            body.source_snapshot && typeof body.source_snapshot === "object"
                ? (body.source_snapshot as Record<string, unknown>)
                : {};
        const meal = await addStructuredMealItem(
            c.get("munchUserId"),
            c.req.param("mealId")!,
            {
                name,
                ...(body.quantity !== undefined
                    ? { quantity: positiveNumber(body.quantity) }
                    : {}),
                ...(typeof body.portion_label === "string"
                    ? { portionLabel: body.portion_label }
                    : {}),
                nutrients,
                sourceType: structuredSourceType(body.source_type),
                ...(typeof body.provider === "string"
                    ? { provider: body.provider }
                    : {}),
                ...(typeof body.source_url === "string"
                    ? { sourceUrl: body.source_url }
                    : {}),
                ...(typeof body.confidence === "number"
                    ? { confidence: body.confidence }
                    : {}),
                assumptions,
                sourceSnapshot,
            },
        );
        return privateJson(c, { meal });
    });

    app.delete(
        "/api/app/meals/:mealId/items/:itemId",
        requireSameOrigin,
        async (c) => {
            const meal = await deleteStructuredMealItem(
                c.get("munchUserId"),
                c.req.param("mealId")!,
                c.req.param("itemId")!,
            );
            return privateJson(c, { meal });
        },
    );

    app.post("/api/app/meals/:id/copy", requireSameOrigin, async (c) => {
        const body = (await c.req.json()) as Record<string, unknown>;
        const copied = await copyMeal(
            c.get("munchUserId"),
            c.req.param("id")!,
            {
                ...(typeof body.logged_at === "string"
                    ? { loggedAt: body.logged_at }
                    : {}),
                ...(body.meal_type !== undefined
                    ? { mealType: mealType(body.meal_type) }
                    : {}),
            },
        );
        return privateJson(c, copied);
    });

    app.delete("/api/app/meals/:id", requireSameOrigin, async (c) => {
        await deleteMeal(c.get("munchUserId"), c.req.param("id")!);
        return privateJson(c, { deleted: true });
    });

    app.post("/api/app/water", requireSameOrigin, async (c) => {
        const body = (await c.req.json()) as Record<string, unknown>;
        const amountMl = Number(body.amount_ml);
        if (!Number.isInteger(amountMl) || amountMl <= 0 || amountMl > 20_000) {
            throw new Error("Invalid water amount");
        }
        const result = await insertWater(c.get("munchUserId"), {
            amount_ml: amountMl,
            ...(typeof body.logged_at === "string"
                ? { logged_at: body.logged_at }
                : {}),
            ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
        });
        return privateJson(c, result);
    });

    app.delete("/api/app/water/:id", requireSameOrigin, async (c) => {
        await deleteWater(c.get("munchUserId"), c.req.param("id")!);
        return privateJson(c, { deleted: true });
    });

    app.post("/api/app/weight", requireSameOrigin, async (c) => {
        const body = (await c.req.json()) as Record<string, unknown>;
        const value = Number(body.weight);
        if (!Number.isFinite(value) || value <= 0 || !isWeightUnit(body.unit)) {
            throw new Error("Invalid weight");
        }
        const weightG = toGrams(value, body.unit);
        if (!isPlausibleWeightGrams(weightG)) {
            throw new Error("Weight is outside the supported range");
        }
        const result = await insertWeight(c.get("munchUserId"), {
            weight_g: weightG,
            ...(typeof body.logged_at === "string"
                ? { logged_at: body.logged_at }
                : {}),
            ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
        });
        return privateJson(c, result);
    });

    app.delete("/api/app/weight/:id", requireSameOrigin, async (c) => {
        await deleteWeight(c.get("munchUserId"), c.req.param("id")!);
        return privateJson(c, { deleted: true });
    });

    app.put("/api/app/goals", requireSameOrigin, async (c) => {
        const body = (await c.req.json()) as Record<string, unknown>;
        const unit = isWeightUnit(body.unit) ? body.unit : null;
        const targetWeight = numberOrNull(body.target_weight);
        if (targetWeight !== undefined && targetWeight !== null && !unit) {
            throw new Error("Weight unit is required");
        }
        const targetWeightG =
            targetWeight == null || unit == null
                ? targetWeight
                : toGrams(targetWeight, unit);
        if (
            typeof targetWeightG === "number" &&
            !isPlausibleWeightGrams(targetWeightG)
        ) {
            throw new Error("Target weight is outside the supported range");
        }
        const goals = await upsertNutritionGoals(c.get("munchUserId"), {
            daily_calories: numberOrNull(body.daily_calories),
            daily_protein_g: numberOrNull(body.daily_protein_g),
            daily_carbs_g: numberOrNull(body.daily_carbs_g),
            daily_fat_g: numberOrNull(body.daily_fat_g),
            daily_fiber_g: numberOrNull(body.daily_fiber_g),
            daily_sugar_g: numberOrNull(body.daily_sugar_g),
            daily_alcohol_g: numberOrNull(body.daily_alcohol_g),
            daily_water_ml: numberOrNull(body.daily_water_ml),
            target_weight_g: targetWeightG,
        });
        return privateJson(c, { goals });
    });

    app.put("/api/app/preferences", requireSameOrigin, async (c) => {
        const body = (await c.req.json()) as Record<string, unknown>;
        const patch: Parameters<typeof upsertProfile>[1] = {};
        if (typeof body.timezone === "string") {
            if (!validateTz(body.timezone)) {
                throw new Error("Invalid timezone");
            }
            patch.timezone = body.timezone;
        }
        if (
            body.preferred_weight_unit === null ||
            isWeightUnit(body.preferred_weight_unit)
        ) {
            patch.preferred_weight_unit = body.preferred_weight_unit;
        }
        if (typeof body.widgets_enabled === "boolean") {
            patch.widgets_enabled = body.widgets_enabled;
        }
        if (typeof body.alcohol_tracking_enabled === "boolean") {
            patch.alcohol_tracking_enabled = body.alcohol_tracking_enabled;
        }
        if (
            body.preferred_drink_unit === null ||
            body.preferred_drink_unit === "us" ||
            body.preferred_drink_unit === "uk"
        ) {
            patch.preferred_drink_unit = body.preferred_drink_unit;
        }
        const profile = await upsertProfile(c.get("munchUserId"), patch);
        return privateJson(c, { profile });
    });

    app.delete(
        "/api/app/connections/:tokenFamilyId",
        requireSameOrigin,
        async (c) => {
            const revoked = await revokeOAuthConnection(
                c.get("munchUserId"),
                c.req.param("tokenFamilyId")!,
            );
            if (!revoked) throw new Error("Connection not found");
            return privateJson(c, { revoked: true });
        },
    );

    app.onError((error, c) => {
        console.error("App route failed", { name: error.name });
        const knownMessage =
            error instanceof Error &&
            /^(Invalid|Connection not found|Date range|Weight|Target weight|Meal item|Meal |Meal$|Meal not found|Food |Nutrition|Add at least|A meal|Structured meal|A structured meal|Draft )/.test(
                error.message,
            )
                ? error.message
                : "The request could not be completed.";
        const status: 400 | 404 = knownMessage.includes("not found")
            ? 404
            : 400;
        return c.json(
            { error: "app_request_failed", message: knownMessage },
            status,
            { "Cache-Control": "no-store, private" },
        );
    });

    return app;
}
