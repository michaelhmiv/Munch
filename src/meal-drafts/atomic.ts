import type { NutrientValues } from "../food-providers/types.js";
import {
    withUserDatabase,
    type DatabaseTransaction,
} from "../platform/database.js";
import type { StructuredMealItemInput } from "../structured-meals/types.js";
import { getMealDraft } from "./repository.js";
import type { MealDraft, MealDraftSourceMode } from "./types.js";

const ACTIVE_STATUSES = new Set([
    "open",
    "awaiting_answers",
    "awaiting_confirmation",
]);

export interface AtomicReviewQuestionInput {
    questionKey: string;
    prompt: string;
    impactScore?: number;
    itemPosition?: number;
}

export interface AtomicReviewAnswerInput {
    questionId?: string;
    questionKey?: string;
    answer: string;
}

export interface PrepareMealReviewInput {
    userId: string;
    sourceMode: MealDraftSourceMode;
    mealType: NonNullable<MealDraft["mealType"]>;
    description: string;
    loggedAt?: string;
    notes?: string;
    items: StructuredMealItemInput[];
    questions?: AtomicReviewQuestionInput[];
    requestId?: string;
    draftId?: string;
    expectedVersion?: number;
}

export interface ResolveMealReviewInput {
    userId: string;
    draftId: string;
    expectedVersion: number;
    answers?: AtomicReviewAnswerInput[];
    mealType?: NonNullable<MealDraft["mealType"]>;
    description?: string;
    loggedAt?: string | null;
    notes?: string | null;
    items?: StructuredMealItemInput[];
    questions?: AtomicReviewQuestionInput[];
    acceptRemainingAssumptions?: boolean;
}

function normalizeItem(item: StructuredMealItemInput): StructuredMealItemInput {
    const name = item.name?.trim();
    if (!name || name.length > 500) {
        throw new Error(
            "Review item name is required and must be at most 500 characters",
        );
    }
    if (
        item.quantity !== undefined &&
        (!Number.isFinite(item.quantity) || item.quantity <= 0)
    ) {
        throw new Error("Review item quantity must be positive");
    }
    if (
        item.gramWeight !== undefined &&
        (!Number.isFinite(item.gramWeight) || item.gramWeight <= 0)
    ) {
        throw new Error("Review item gram weight must be positive");
    }
    if (
        item.confidence !== undefined &&
        (!Number.isFinite(item.confidence) ||
            item.confidence < 0 ||
            item.confidence > 1)
    ) {
        throw new Error("Review item confidence must be between 0 and 1");
    }

    const assumptions = (item.assumptions ?? []).map((value) => value.trim());
    if (
        assumptions.length > 20 ||
        assumptions.some((value) => !value || value.length > 500)
    ) {
        throw new Error("Review item assumptions exceed limits");
    }

    const nutrients: NutrientValues = {};
    for (const [key, value] of Object.entries(item.nutrients ?? {}) as Array<
        [keyof NutrientValues, number]
    >) {
        if (!Number.isFinite(value) || value < 0) {
            throw new Error(
                `Review item nutrient ${String(key)} must be finite and nonnegative`,
            );
        }
        nutrients[key] = Math.round(value * 100) / 100;
    }

    const sourceSnapshot = item.sourceSnapshot ?? {};
    if (JSON.stringify(sourceSnapshot).length > 50_000) {
        throw new Error("Review item source snapshot is too large");
    }

    return {
        ...item,
        name,
        portionLabel: item.portionLabel?.trim() || undefined,
        assumptions,
        nutrients,
        sourceSnapshot,
    };
}

function normalizeQuestions(
    questions: AtomicReviewQuestionInput[] | undefined,
    itemCount: number,
): AtomicReviewQuestionInput[] {
    const seen = new Set<string>();
    return (questions ?? []).map((question) => {
        const questionKey = question.questionKey.trim();
        const prompt = question.prompt.trim();
        const impactScore = question.impactScore ?? 50;
        if (!questionKey || questionKey.length > 200) {
            throw new Error("Review question key is invalid");
        }
        if (seen.has(questionKey)) {
            throw new Error(`Duplicate review question key: ${questionKey}`);
        }
        seen.add(questionKey);
        if (!prompt || prompt.length > 1_000) {
            throw new Error("Review question prompt is invalid");
        }
        if (
            !Number.isInteger(impactScore) ||
            impactScore < 0 ||
            impactScore > 100
        ) {
            throw new Error("Review question impact score must be 0 to 100");
        }
        if (
            question.itemPosition !== undefined &&
            (!Number.isInteger(question.itemPosition) ||
                question.itemPosition < 0 ||
                question.itemPosition >= itemCount)
        ) {
            throw new Error(
                `Review question ${questionKey} references an unknown item`,
            );
        }
        return {
            questionKey,
            prompt,
            impactScore,
            itemPosition: question.itemPosition,
        };
    });
}

function normalizeLoggedAt(
    value: string | null | undefined,
): Date | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new Error("Review logged_at is invalid");
    }
    return date;
}

function assertEditableRow(
    row: Record<string, unknown>,
    expectedVersion?: number,
): void {
    if (!ACTIVE_STATUSES.has(String(row.status))) {
        throw new Error(
            `Meal draft is ${String(row.status)} and cannot be edited`,
        );
    }
    if (new Date(String(row.expires_at)) <= new Date()) {
        throw new Error("Meal draft has expired");
    }
    if (
        expectedVersion !== undefined &&
        Number(row.version) !== expectedVersion
    ) {
        throw new Error(
            `Meal draft changed: expected version ${expectedVersion}, current version ${Number(row.version)}`,
        );
    }
}

async function insertItems(
    tx: DatabaseTransaction,
    draftId: string,
    userId: string,
    items: StructuredMealItemInput[],
): Promise<Map<number, string>> {
    const ids = new Map<number, string>();
    for (const [position, rawItem] of items.entries()) {
        const item = normalizeItem(rawItem);
        const rows = await tx<Array<{ id: string }>>`
            insert into munch.meal_draft_items (
                draft_id, user_id, position, item_payload
            ) values (
                ${draftId}, ${userId}, ${position}, ${item}::jsonb
            )
            returning id
        `;
        ids.set(position, rows[0]!.id);
    }
    return ids;
}

async function insertQuestions(
    tx: DatabaseTransaction,
    draftId: string,
    userId: string,
    questions: AtomicReviewQuestionInput[],
    itemIds: Map<number, string>,
): Promise<void> {
    for (const question of questions) {
        await tx`
            insert into munch.meal_draft_questions (
                draft_id, user_id, item_id, question_key, prompt, impact_score
            ) values (
                ${draftId}, ${userId},
                ${question.itemPosition === undefined ? null : (itemIds.get(question.itemPosition) ?? null)},
                ${question.questionKey}, ${question.prompt},
                ${question.impactScore ?? 50}
            )
        `;
    }
}

async function requireDraftAfterWrite(
    userId: string,
    draftId: string,
): Promise<MealDraft> {
    const draft = await getMealDraft(userId, draftId);
    if (!draft) throw new Error("Meal review could not be loaded after write");
    return draft;
}

export async function prepareMealReview(
    input: PrepareMealReviewInput,
): Promise<MealDraft> {
    const description = input.description.trim();
    if (!description || description.length > 2_000) {
        throw new Error(
            "Meal review description is required and must be at most 2,000 characters",
        );
    }
    if (input.items.length < 1 || input.items.length > 100) {
        throw new Error("Meal review must contain between 1 and 100 items");
    }
    const items = input.items.map(normalizeItem);
    const questions = normalizeQuestions(input.questions, items.length);
    const loggedAt = normalizeLoggedAt(input.loggedAt);
    const notes = input.notes?.trim() || null;
    const requestId = input.requestId?.trim() || null;
    if (requestId && requestId.length > 200) {
        throw new Error("Meal review request_id is too long");
    }

    const draftId = await withUserDatabase(input.userId, async (tx) => {
        if (requestId && !input.draftId) {
            await tx`select pg_advisory_xact_lock(hashtext(${`meal-review:${input.userId}:${requestId}`}))`;
            const prior = await tx<Array<{ id: string }>>`
                select id from munch.meal_drafts
                where user_id = ${input.userId}
                  and request_id = ${requestId}
                limit 1
                for update
            `;
            if (prior[0]?.id) return prior[0].id;
        }

        let id: string;
        let version: number;
        if (input.draftId) {
            const rows = await tx<Array<Record<string, unknown>>>`
                select id, status, version, expires_at
                from munch.meal_drafts
                where id = ${input.draftId}
                for update
            `;
            const row = rows[0];
            if (!row) throw new Error("Meal draft not found");
            assertEditableRow(row, input.expectedVersion);
            id = String(row.id);
            version = Number(row.version) + 1;
            await tx`
                delete from munch.meal_draft_questions
                where draft_id = ${id}
            `;
            await tx`
                delete from munch.meal_draft_items
                where draft_id = ${id}
            `;
        } else {
            const rows = await tx<Array<{ id: string; version: number }>>`
                insert into munch.meal_drafts (
                    user_id, status, source_mode, meal_type, description,
                    logged_at, notes, request_id, expires_at
                ) values (
                    ${input.userId},
                    ${questions.length > 0 ? "awaiting_answers" : "awaiting_confirmation"},
                    ${input.sourceMode}, ${input.mealType}, ${description},
                    ${loggedAt ?? null}, ${notes}, ${requestId},
                    now() + interval '24 hours'
                )
                returning id, version
            `;
            id = rows[0]!.id;
            version = Number(rows[0]!.version);
        }

        const itemIds = await insertItems(tx, id, input.userId, items);
        await insertQuestions(tx, id, input.userId, questions, itemIds);
        await tx`
            update munch.meal_drafts
            set source_mode = ${input.sourceMode},
                meal_type = ${input.mealType},
                description = ${description},
                logged_at = ${loggedAt ?? null},
                notes = ${notes},
                status = ${questions.length > 0 ? "awaiting_answers" : "awaiting_confirmation"},
                version = ${version},
                updated_at = now()
            where id = ${id}
        `;
        return id;
    });

    return requireDraftAfterWrite(input.userId, draftId);
}

export async function resolveMealReview(
    input: ResolveMealReviewInput,
): Promise<MealDraft> {
    const normalizedItems = input.items?.map(normalizeItem);
    const normalizedQuestions = input.questions
        ? normalizeQuestions(input.questions, normalizedItems?.length ?? 100)
        : undefined;
    const loggedAt = normalizeLoggedAt(input.loggedAt);

    await withUserDatabase(input.userId, async (tx) => {
        const rows = await tx<Array<Record<string, unknown>>>`
            select id, status, version, expires_at
            from munch.meal_drafts
            where id = ${input.draftId}
            for update
        `;
        const row = rows[0];
        if (!row) throw new Error("Meal draft not found");
        assertEditableRow(row, input.expectedVersion);

        for (const rawAnswer of input.answers ?? []) {
            const answer = rawAnswer.answer.trim();
            if (!answer || answer.length > 2_000) {
                throw new Error("Review answer is invalid");
            }
            if (!rawAnswer.questionId && !rawAnswer.questionKey) {
                throw new Error(
                    "Review answer requires question_id or question_key",
                );
            }
            const answered = rawAnswer.questionId
                ? await tx<Array<{ id: string }>>`
                      update munch.meal_draft_questions
                      set status = 'answered', answer = ${answer}, answered_at = now()
                      where id = ${rawAnswer.questionId}
                        and draft_id = ${input.draftId}
                        and status = 'open'
                      returning id
                  `
                : await tx<Array<{ id: string }>>`
                      update munch.meal_draft_questions
                      set status = 'answered', answer = ${answer}, answered_at = now()
                      where draft_id = ${input.draftId}
                        and question_key = ${rawAnswer.questionKey!.trim()}
                        and status = 'open'
                      returning id
                  `;
            if (answered.length === 0) {
                throw new Error("Open review question not found");
            }
        }

        let itemIds = new Map<number, string>();
        if (normalizedItems) {
            const existing = await tx<Array<{ id: string; position: number }>>`
                select id, position
                from munch.meal_draft_items
                where draft_id = ${input.draftId}
                order by position
            `;
            const byPosition = new Map<number, string>(
                existing.map((item): [number, string] => [
                    Number(item.position),
                    item.id,
                ]),
            );
            for (const [position, item] of normalizedItems.entries()) {
                const existingId = byPosition.get(position);
                if (existingId) {
                    await tx`
                        update munch.meal_draft_items
                        set item_payload = ${item}::jsonb,
                            updated_at = now()
                        where id = ${existingId}
                    `;
                    itemIds.set(position, existingId);
                } else {
                    const inserted = await tx<Array<{ id: string }>>`
                        insert into munch.meal_draft_items (
                            draft_id, user_id, position, item_payload
                        ) values (
                            ${input.draftId}, ${input.userId}, ${position},
                            ${item}::jsonb
                        )
                        returning id
                    `;
                    itemIds.set(position, inserted[0]!.id);
                }
            }
            await tx`
                delete from munch.meal_draft_items
                where draft_id = ${input.draftId}
                  and position >= ${normalizedItems.length}
            `;
        } else {
            const existing = await tx<Array<{ id: string; position: number }>>`
                select id, position
                from munch.meal_draft_items
                where draft_id = ${input.draftId}
            `;
            itemIds = new Map<number, string>(
                existing.map((item): [number, string] => [
                    Number(item.position),
                    item.id,
                ]),
            );
        }

        if (normalizedQuestions) {
            const keys = new Set(
                normalizedQuestions.map((question) => question.questionKey),
            );
            const existingOpen = await tx<
                Array<{ id: string; question_key: string }>
            >`
                select id, question_key
                from munch.meal_draft_questions
                where draft_id = ${input.draftId}
                  and status = 'open'
            `;
            for (const question of existingOpen) {
                if (!keys.has(question.question_key)) {
                    await tx`
                        delete from munch.meal_draft_questions
                        where id = ${question.id}
                    `;
                }
            }
            for (const question of normalizedQuestions) {
                const itemId =
                    question.itemPosition === undefined
                        ? null
                        : (itemIds.get(question.itemPosition) ?? null);
                if (question.itemPosition !== undefined && itemId === null) {
                    throw new Error(
                        `Review question ${question.questionKey} references an unknown item`,
                    );
                }
                await tx`
                    insert into munch.meal_draft_questions (
                        draft_id, user_id, item_id, question_key, prompt,
                        impact_score
                    ) values (
                        ${input.draftId}, ${input.userId}, ${itemId},
                        ${question.questionKey}, ${question.prompt},
                        ${question.impactScore ?? 50}
                    )
                    on conflict (draft_id, question_key) do update
                    set item_id = excluded.item_id,
                        prompt = excluded.prompt,
                        impact_score = excluded.impact_score,
                        status = 'open',
                        answer = null,
                        answered_at = null
                `;
            }
        }

        if (input.acceptRemainingAssumptions) {
            await tx`
                update munch.meal_draft_questions
                set status = 'accepted_assumption',
                    answer = 'User accepted unresolved assumption: ' || prompt,
                    answered_at = now()
                where draft_id = ${input.draftId}
                  and status = 'open'
            `;
        }

        const counts = await tx<
            Array<{ open_count: number; item_count: number }>
        >`
            select
                (select count(*)::integer
                 from munch.meal_draft_questions
                 where draft_id = ${input.draftId} and status = 'open') as open_count,
                (select count(*)::integer
                 from munch.meal_draft_items
                 where draft_id = ${input.draftId}) as item_count
        `;
        const openCount = Number(counts[0]?.open_count ?? 0);
        const itemCount = Number(counts[0]?.item_count ?? 0);
        if (itemCount === 0) throw new Error("Meal review has no items");
        const status =
            openCount > 0 ? "awaiting_answers" : "awaiting_confirmation";

        const description = input.description?.trim();
        if (input.description !== undefined && !description) {
            throw new Error("Meal review description cannot be empty");
        }

        await tx`
            update munch.meal_drafts
            set meal_type = case
                    when ${input.mealType !== undefined}
                    then ${input.mealType ?? null}
                    else meal_type
                end,
                description = case
                    when ${input.description !== undefined}
                    then ${description ?? null}
                    else description
                end,
                logged_at = case
                    when ${input.loggedAt !== undefined}
                    then ${loggedAt ?? null}
                    else logged_at
                end,
                notes = case
                    when ${input.notes !== undefined}
                    then ${input.notes?.trim() || null}
                    else notes
                end,
                status = ${status},
                version = version + 1,
                updated_at = now()
            where id = ${input.draftId}
        `;
    });

    return requireDraftAfterWrite(input.userId, input.draftId);
}
