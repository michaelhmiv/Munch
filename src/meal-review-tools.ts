import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withAnalytics } from "./analytics.js";
import {
    prepareMealReview,
    resolveMealReview,
    type AtomicReviewQuestionInput,
} from "./meal-drafts/atomic.js";
import type { MealDraft } from "./meal-drafts/types.js";
import { aggregateStructuredMealItems } from "./structured-meals/repository.js";
import type { StructuredMealItemInput } from "./structured-meals/types.js";
import { WIDGET_RESOURCE_METADATA } from "./openai-submission.js";
import { getWidgetHtml } from "./widgets.js";

const MEAL_REVIEW_WIDGET_URI = "ui://widget/meal-review.html";
const APP_UI_MIME_TYPE = "text/html;profile=mcp-app";

const nutrientInput = z.object({
    calories: z.coerce.number().min(0).optional(),
    protein_g: z.coerce.number().min(0).optional(),
    carbs_g: z.coerce.number().min(0).optional(),
    fat_g: z.coerce.number().min(0).optional(),
    fiber_g: z.coerce.number().min(0).optional(),
    sugar_g: z.coerce.number().min(0).optional(),
    alcohol_g: z.coerce.number().min(0).optional(),
    sodium_mg: z.coerce.number().min(0).optional(),
    saturated_fat_g: z.coerce.number().min(0).optional(),
    cholesterol_mg: z.coerce.number().min(0).optional(),
    potassium_mg: z.coerce.number().min(0).optional(),
});

const sourceType = z.enum([
    "usda",
    "open_food_facts",
    "published_restaurant",
    "saved_food",
    "past_meal",
    "user_supplied",
    "model_estimate",
    "legacy_aggregate",
]);

const reviewItemInput = z.object({
    name: z.string().min(1).max(500),
    quantity: z.coerce.number().positive().optional(),
    portion_label: z.string().max(500).optional(),
    gram_weight: z.coerce.number().positive().optional(),
    nutrients: nutrientInput,
    source_type: sourceType,
    provider: z.string().max(100).optional(),
    provider_food_id: z.string().max(255).optional(),
    provider_revision: z.string().max(255).optional(),
    source_url: z.string().url().max(2_000).optional(),
    source_updated_at: z.string().optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
    assumptions: z.array(z.string().min(1).max(500)).max(20).optional(),
    source_snapshot: z.record(z.string(), z.unknown()).optional(),
});

const reviewQuestionInput = z.object({
    question_key: z.string().min(1).max(200),
    prompt: z.string().min(1).max(1_000),
    impact_score: z.coerce.number().int().min(0).max(100).optional(),
    item_position: z.coerce.number().int().min(0).max(99).optional(),
});

function toStructuredItem(
    item: z.infer<typeof reviewItemInput>,
): StructuredMealItemInput {
    return {
        name: item.name,
        quantity: item.quantity,
        portionLabel: item.portion_label,
        gramWeight: item.gram_weight,
        nutrients: item.nutrients,
        sourceType: item.source_type,
        provider: item.provider,
        providerFoodId: item.provider_food_id,
        providerRevision: item.provider_revision,
        sourceUrl: item.source_url,
        sourceUpdatedAt: item.source_updated_at,
        confidence: item.confidence,
        assumptions: item.assumptions,
        sourceSnapshot: item.source_snapshot,
    };
}

function toQuestion(
    question: z.infer<typeof reviewQuestionInput>,
): AtomicReviewQuestionInput {
    return {
        questionKey: question.question_key,
        prompt: question.prompt,
        impactScore: question.impact_score,
        itemPosition: question.item_position,
    };
}

function serializeReview(draft: MealDraft) {
    const items = draft.items.map((record) => ({
        id: record.id,
        position: record.position,
        name: record.item.name,
        quantity: record.item.quantity ?? null,
        portion_label: record.item.portionLabel ?? null,
        gram_weight: record.item.gramWeight ?? null,
        nutrients: record.item.nutrients,
        source_type: record.item.sourceType,
        provider: record.item.provider ?? null,
        provider_food_id: record.item.providerFoodId ?? null,
        provider_revision: record.item.providerRevision ?? null,
        source_url: record.item.sourceUrl ?? null,
        source_updated_at: record.item.sourceUpdatedAt ?? null,
        confidence: record.item.confidence ?? null,
        assumptions: record.item.assumptions ?? [],
        source_snapshot: record.item.sourceSnapshot ?? {},
    }));
    const assumptions = [...new Set(items.flatMap((item) => item.assumptions))];
    const openQuestions = draft.questions.filter(
        (question) => question.status === "open",
    );
    return {
        id: draft.id,
        status: draft.status,
        source_mode: draft.sourceMode,
        meal_type: draft.mealType,
        description: draft.description,
        logged_at: draft.loggedAt,
        notes: draft.notes,
        version: draft.version,
        expires_at: draft.expiresAt,
        confirmed_meal_id: draft.confirmedMealId,
        items,
        totals: aggregateStructuredMealItems(
            draft.items.map((record) => record.item),
        ),
        assumptions,
        questions: draft.questions.map((question) => ({
            id: question.id,
            item_id: question.itemId,
            question_key: question.questionKey,
            prompt: question.prompt,
            impact_score: question.impactScore,
            status: question.status,
            answer: question.answer,
        })),
        next_question: openQuestions[0]
            ? {
                  id: openQuestions[0].id,
                  question_key: openQuestions[0].questionKey,
                  prompt: openQuestions[0].prompt,
                  impact_score: openQuestions[0].impactScore,
              }
            : null,
        ready_for_confirmation:
            draft.status === "awaiting_confirmation" &&
            openQuestions.length === 0 &&
            draft.items.length > 0,
    };
}

function reviewSummary(draft: MealDraft): string {
    const review = serializeReview(draft);
    const totals = review.totals;
    const lines = [
        `${review.description ?? "Meal review"} · ${review.meal_type ?? "meal"}`,
        `${review.items.length} item${review.items.length === 1 ? "" : "s"} · ${Math.round(totals.calories ?? 0)} kcal`,
    ];
    if (review.next_question) {
        lines.push(`One material question: ${review.next_question.prompt}`);
    } else {
        lines.push(
            "Review the items and assumptions, then obtain explicit approval before confirmation.",
        );
    }
    return lines.join("\n");
}

const reviewOutputSchema = {
    review: z.record(z.string(), z.unknown()),
};

export function registerMealReviewTools(
    server: McpServer,
    userId: string,
): void {
    const toolServer = server as unknown as {
        registerTool: (
            name: string,
            config: unknown,
            handler: (...args: any[]) => unknown,
        ) => unknown;
        registerResource: (
            name: string,
            uri: string,
            config: unknown,
            handler: (...args: any[]) => unknown,
        ) => unknown;
    };

    toolServer.registerResource(
        "meal-review-widget",
        MEAL_REVIEW_WIDGET_URI,
        {
            title: "Meal Review",
            description:
                "Interactive review, edit, confirmation, and cancellation surface for a pending meal.",
            mimeType: APP_UI_MIME_TYPE,
        },
        async (uri: URL | string) => ({
            contents: [
                {
                    uri: typeof uri === "string" ? uri : uri.href,
                    mimeType: APP_UI_MIME_TYPE,
                    text: await getWidgetHtml("meal-review"),
                    _meta: WIDGET_RESOURCE_METADATA,
                },
            ],
        }),
    );

    toolServer.registerTool(
        "prepare_meal_review",
        {
            title: "Prepare Meal Review",
            description:
                "Create the complete reviewable meal draft in one atomic call. This is the default for photos and any meal that still needs user approval. For a clear plated photo, infer homemade versus restaurant from context instead of asking by default; absence of menus, branding, receipts, or takeout packaging generally supports a homemade inference. Use visible scale references such as forks, plates, bowls, cups, hands, or packaging when estimating portions. Put low-impact uncertainty into explicit assumptions. Add at most the materially important unresolved question(s), ordered by impact; do not create questions merely to confirm every ordinary estimate. Search providers, saved foods, or history only when doing so is likely to materially improve identity, hidden ingredients, or serving accuracy. This tool does not save the meal permanently. Present the returned review and call confirm_meal_draft only after explicit approval.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                source_mode: z.enum([
                    "text",
                    "photo",
                    "barcode",
                    "restaurant",
                    "saved_food",
                    "history",
                ]),
                meal_type: z.enum(["breakfast", "lunch", "dinner", "snack"]),
                description: z.string().min(1).max(2_000),
                logged_at: z.string().optional(),
                notes: z.string().max(4_000).optional(),
                request_id: z
                    .string()
                    .min(1)
                    .max(200)
                    .optional()
                    .describe(
                        "Optional stable key for idempotent retries of the same review preparation.",
                    ),
                draft_id: z.string().uuid().optional(),
                expected_version: z.coerce.number().int().positive().optional(),
                items: z.array(reviewItemInput).min(1).max(100),
                questions: z.array(reviewQuestionInput).max(20).optional(),
            },
            outputSchema: reviewOutputSchema,
            _meta: { ui: { resourceUri: MEAL_REVIEW_WIDGET_URI } },
        },
        async (args) =>
            withAnalytics(
                "prepare_meal_review",
                async () => {
                    const started = performance.now();
                    const draft = await prepareMealReview({
                        userId,
                        sourceMode: args.source_mode,
                        mealType: args.meal_type,
                        description: args.description,
                        loggedAt: args.logged_at,
                        notes: args.notes,
                        requestId: args.request_id,
                        draftId: args.draft_id,
                        expectedVersion: args.expected_version,
                        items: args.items.map(toStructuredItem),
                        questions: args.questions?.map(toQuestion),
                    });
                    const duration = Math.round(performance.now() - started);
                    console.info(
                        `[meal_review] operation=prepare duration_ms=${duration} items=${draft.items.length} questions=${draft.questions.filter((q) => q.status === "open").length} workflow=atomic`,
                    );
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: reviewSummary(draft),
                            },
                        ],
                        structuredContent: { review: serializeReview(draft) },
                    };
                },
                { userId },
                {
                    source_mode: args.source_mode,
                    item_count: args.items.length,
                    question_count: args.questions?.length ?? 0,
                },
            ),
    );

    toolServer.registerTool(
        "resolve_meal_review",
        {
            title: "Resolve or Edit Meal Review",
            description:
                "Atomically apply the user's answer, revised item estimates, remaining material questions, or review edits. Pass full items when changing any item. Set accept_remaining_assumptions only when the user explicitly says to stop asking or accepts the stated assumptions. The result remains pending until explicit confirmation.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                draft_id: z.string().uuid(),
                expected_version: z.coerce.number().int().positive(),
                answers: z
                    .array(
                        z.object({
                            question_id: z.string().uuid().optional(),
                            question_key: z.string().min(1).max(200).optional(),
                            answer: z.string().min(1).max(2_000),
                        }),
                    )
                    .max(20)
                    .optional(),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .optional(),
                description: z.string().min(1).max(2_000).optional(),
                logged_at: z.string().nullable().optional(),
                notes: z.string().max(4_000).nullable().optional(),
                items: z.array(reviewItemInput).min(1).max(100).optional(),
                questions: z.array(reviewQuestionInput).max(20).optional(),
                accept_remaining_assumptions: z.boolean().optional(),
            },
            outputSchema: reviewOutputSchema,
            _meta: { ui: { resourceUri: MEAL_REVIEW_WIDGET_URI } },
        },
        async (args) =>
            withAnalytics(
                "resolve_meal_review",
                async () => {
                    const started = performance.now();
                    const draft = await resolveMealReview({
                        userId,
                        draftId: args.draft_id,
                        expectedVersion: args.expected_version,
                        answers: args.answers?.map(
                            (answer: {
                                question_id?: string;
                                question_key?: string;
                                answer: string;
                            }) => ({
                                questionId: answer.question_id,
                                questionKey: answer.question_key,
                                answer: answer.answer,
                            }),
                        ),
                        mealType: args.meal_type,
                        description: args.description,
                        loggedAt: args.logged_at,
                        notes: args.notes,
                        items: args.items?.map(toStructuredItem),
                        questions: args.questions?.map(toQuestion),
                        acceptRemainingAssumptions:
                            args.accept_remaining_assumptions,
                    });
                    const duration = Math.round(performance.now() - started);
                    console.info(
                        `[meal_review] operation=resolve duration_ms=${duration} items=${draft.items.length} questions=${draft.questions.filter((q) => q.status === "open").length} workflow=atomic`,
                    );
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: reviewSummary(draft),
                            },
                        ],
                        structuredContent: { review: serializeReview(draft) },
                    };
                },
                { userId },
                {
                    item_count: args.items?.length,
                    answer_count: args.answers?.length ?? 0,
                    question_count: args.questions?.length,
                },
            ),
    );
}
