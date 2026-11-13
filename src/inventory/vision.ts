import { z } from "zod";
import {
    openRouterReasoningParam,
    providerErrorDetail,
    websiteAiModel,
} from "../website-ai-config.js";
import { decisionsConfig, type DecisionsConfig } from "../decisions/config.js";
import type { DecisionsFetcher } from "../decisions/client.js";
import {
    correlateReceiptLines,
    type ReceiptCorrelationRequest,
} from "../decisions/receipt.js";
import { encodeFoodCandidateId } from "../food-providers/service.js";
import type { FoodCandidate } from "../food-providers/types.js";

const locationSchema = z.preprocess(
    (value) => {
        if (typeof value !== "string") return value;
        const normalized = value
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, "_");
        if (
            ["refrigerator", "refrigerated", "refrigeration"].includes(
                normalized,
            )
        ) {
            return "fridge";
        }
        if (
            ["cupboard", "cabinet", "dry_storage", "shelf"].includes(normalized)
        ) {
            return "pantry";
        }
        if (["frozen", "frozen_storage"].includes(normalized)) return "freezer";
        if (
            ["unknown", "none", "not_sure", "not_applicable"].includes(
                normalized,
            )
        ) {
            return "unspecified";
        }
        return normalized;
    },
    z.enum(["pantry", "fridge", "freezer", "unspecified"]),
);

const previewLineSchema = z
    .object({
        raw_label: z.string().max(300).nullable(),
        name: z.string().min(1).max(300),
        quantity: z.number().positive().nullable(),
        unit: z.string().max(80).nullable(),
        is_food: z.boolean(),
        confidence: z.number().min(0).max(1),
        location: locationSchema,
    })
    .strict();

const previewSchema = z
    .object({
        lines: z.array(previewLineSchema).max(200),
        notes: z.preprocess(
            (value) =>
                typeof value === "string"
                    ? value.trim()
                        ? [value.trim()]
                        : []
                    : value == null
                      ? []
                      : value,
            z.array(z.string().max(300)).max(10),
        ),
    })
    .strict();

export type InventoryVisionPreview = z.infer<typeof previewSchema>;

/** A preview line after B1 receipt correlation: the extraction
 * fields, plus the provider identity of Jev's confirmed pick when
 * the seat ran and attached one. Absent fields = the seat did not
 * run or made no confident pick (today's by-name behaviour). */
export type InventoryVisionPreviewLine =
    InventoryVisionPreview["lines"][number] & {
        food_provider?: string | null;
        provider_food_id?: string | null;
    };

export type CorrelatedInventoryVisionPreview = Omit<
    InventoryVisionPreview,
    "lines"
> & { lines: InventoryVisionPreviewLine[] };

export type InventoryVisionMode = "receipt" | "pantry_photo";

/**
 * Formal JSON schema sent with every vision request (S2 reliability
 * pattern, lifted from the recipe-import resolver): the model is asked
 * for strict structured output matching the zod preview schema, and the
 * response is still parsed strictly server-side.
 */
export const inventoryVisionPreviewJsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["lines", "notes"],
    properties: {
        lines: {
            type: "array",
            maxItems: 200,
            items: {
                type: "object",
                additionalProperties: false,
                required: [
                    "raw_label",
                    "name",
                    "quantity",
                    "unit",
                    "is_food",
                    "confidence",
                    "location",
                ],
                properties: {
                    raw_label: {
                        anyOf: [
                            { type: "string", maxLength: 300 },
                            { type: "null" },
                        ],
                    },
                    name: { type: "string", minLength: 1, maxLength: 300 },
                    quantity: {
                        anyOf: [
                            { type: "number", exclusiveMinimum: 0 },
                            { type: "null" },
                        ],
                    },
                    unit: {
                        anyOf: [
                            { type: "string", maxLength: 80 },
                            { type: "null" },
                        ],
                    },
                    is_food: { type: "boolean" },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    location: {
                        type: "string",
                        enum: ["pantry", "fridge", "freezer", "unspecified"],
                    },
                },
            },
        },
        notes: {
            type: "array",
            maxItems: 10,
            items: { type: "string", maxLength: 300 },
        },
    },
} as const;

export const DEFAULT_INVENTORY_VISION_MAX_TOKENS = 4_000;

export interface InventoryVisionConfig {
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
    maxTokens?: number;
    appUrl?: string;
    /** OpenRouter Extractions API endpoint for the receipt fallback
     * (tests/drills override it). */
    extractionsUrl?: string;
    /** Designated receipt fallback model (ScaleDown labels-only).
     * Null/absent disables the fallback; inventoryVisionConfig
     * populates it from the designated default. */
    receiptFallbackModel?: string | null;
}

export interface InventoryVisionDependencies {
    fetcher?: (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => Promise<Response>;
    /** B1 receipt-correlation seams (tests/drills). Production uses
     * the Decisions client chain and the shared food-search service. */
    decisionsFetcher?: DecisionsFetcher;
    decisionsConfig?: DecisionsConfig | null;
    receiptSearch?: (
        query: string,
        limit: number,
    ) => Promise<{ candidates: FoodCandidate[] }>;
}

function boundedInteger(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
) {
    const parsed = Number(value);
    return Number.isInteger(parsed)
        ? Math.min(max, Math.max(min, parsed))
        : fallback;
}

function enabledFlag(value: string | undefined): boolean {
    return ["true", "1", "on", "yes"].includes(
        value?.trim().toLowerCase() ?? "",
    );
}

/**
 * Receipt fallback (model-integration brief, "Fallback law"): when
 * the Ember extraction fails at model level, receipt reading falls
 * back to ScaleDown's extraction model on OpenRouter's Extractions
 * API — labels only (measured Nov 11: 92.9% of lines, 100%
 * precision, $0.00006/receipt), with every returned line routed to
 * the review step for quantity/unit confirmation. It rides the same
 * OpenRouter key. `MUNCH_RECEIPT_FALLBACK_MODEL` overrides the
 * designated model (empty string disables the fallback) and
 * `MUNCH_RECEIPT_EXTRACTIONS_URL` the endpoint.
 */
export const DEFAULT_RECEIPT_EXTRACTIONS_URL =
    "https://openrouter.ai/api/alpha/extractions";
export const DEFAULT_RECEIPT_FALLBACK_MODEL = "scaledown/extract";

export function inventoryVisionConfig(
    env: Record<string, string | undefined> = process.env,
): InventoryVisionConfig | null {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (!apiKey || !enabledFlag(env.MUNCH_PANTRY_VISION_ENABLED)) return null;
    return {
        apiKey,
        model: websiteAiModel(env),
        baseUrl: (
            env.MUNCH_PANTRY_VISION_BASE_URL?.trim() ||
            "https://openrouter.ai/api/v1"
        ).replace(/\/+$/, ""),
        timeoutMs: boundedInteger(
            env.MUNCH_PANTRY_VISION_TIMEOUT_MS,
            30_000,
            5_000,
            60_000,
        ),
        maxTokens: boundedInteger(
            env.MUNCH_PANTRY_VISION_MAX_TOKENS,
            DEFAULT_INVENTORY_VISION_MAX_TOKENS,
            500,
            8_000,
        ),
        appUrl: env.MUNCH_APP_BASE_URL?.trim(),
        extractionsUrl:
            env.MUNCH_RECEIPT_EXTRACTIONS_URL?.trim() ||
            DEFAULT_RECEIPT_EXTRACTIONS_URL,
        receiptFallbackModel:
            env.MUNCH_RECEIPT_FALLBACK_MODEL === undefined
                ? DEFAULT_RECEIPT_FALLBACK_MODEL
                : env.MUNCH_RECEIPT_FALLBACK_MODEL.trim() || null,
    };
}

function prompt(mode: InventoryVisionMode): string {
    if (mode === "receipt") {
        return `Extract purchased line items from this grocery receipt. Return only JSON. Ignore subtotal, total, tax, tender/payment, loyalty savings, coupons, bottle deposits, and repeated headers. Expand obvious receipt abbreviations into a concise product name when reasonably confident, but do not invent brands. Mark household/non-food products is_food=false. Preserve weighted/count quantities when visible. The location value must be exactly one of pantry, fridge, freezer, or unspecified. Use fridge/freezer/pantry only when strongly implied by the food; otherwise unspecified. Low-confidence ambiguous lines must have confidence below 0.85 so Munch can ask for review.`;
    }
    return `Identify edible foods and ingredients visibly present in this pantry, refrigerator, or freezer photo. Return only JSON. Do not invent hidden quantities or products. Count discrete packages/items only when visible; otherwise quantity=null. Mark anything non-food is_food=false. The location value must be exactly one of pantry, fridge, freezer, or unspecified. Use the most plausible storage location from the image context. Low-confidence or partially obscured identifications must have confidence below 0.85 so Munch can ask for review.`;
}

function responseText(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return undefined;
    return value
        .map((part) =>
            part &&
            typeof part === "object" &&
            typeof (part as any).text === "string"
                ? (part as any).text
                : typeof part === "string"
                  ? part
                  : "",
        )
        .join("")
        .trim();
}

function safeLogValue(value: string): string {
    return value.replace(/[^a-zA-Z0-9._/-]+/g, "_").slice(0, 80) || "unknown";
}

function logVisionPhase(
    status: "success" | "error",
    model: string,
    startedAt: number,
    callsUsed: number,
): void {
    console.info(
        `[pantry_vision] phase=preview status=${status} model=${safeLogValue(model)} duration_ms=${Math.max(0, Math.round(Date.now() - startedAt))} calls_used=${callsUsed}`,
    );
}

/**
 * Preview an inventory image (receipt or pantry photo). Receipt
 * mode carries the designated fallback: when the primary extraction
 * fails at model level, the labels-only ScaleDown extraction
 * answers instead (see previewViaReceiptFallback). Pantry-photo
 * mode has no designated fallback in the brief and keeps the
 * primary's failure surface. When the fallback also fails, the
 * primary's error is what surfaces — a retryable failure, never
 * fabricated lines.
 */
export async function previewInventoryImage(
    input: {
        mode: InventoryVisionMode;
        mimeType: string;
        bytes: Uint8Array;
    },
    config = inventoryVisionConfig(),
    dependencies: InventoryVisionDependencies = {},
): Promise<CorrelatedInventoryVisionPreview> {
    if (!config) throw new Error("Pantry vision is not configured");
    // Request validation stays ahead of the fallback: a malformed
    // image is not a provider outage and must never engage ScaleDown.
    if (!/^image\/(jpeg|png|webp)$/i.test(input.mimeType)) {
        throw new Error("Pantry image must be JPEG, PNG, or WebP");
    }
    if (
        input.bytes.byteLength < 1 ||
        input.bytes.byteLength > 8 * 1024 * 1024
    ) {
        throw new Error("Pantry image must be between 1 byte and 8 MB");
    }
    try {
        const preview = await previewViaChatModel(input, config, dependencies);
        // B1 receipt correlation runs on the primary extraction
        // only. The labels-only ScaleDown fallback keeps its
        // degraded contract — every line in review, confidence 0 —
        // untouched by the seat.
        if (input.mode !== "receipt") return preview;
        return await correlateReceiptPreview(preview, dependencies);
    } catch (chatError) {
        const fallbackModel = config.receiptFallbackModel?.trim();
        if (input.mode !== "receipt" || !fallbackModel) throw chatError;
        const reason =
            chatError instanceof Error ? chatError.message : String(chatError);
        console.info(
            `[ai] seat=receipt_extract event=fallback model=${safeLogValue(config.model)} next_model=${safeLogValue(fallbackModel)} reason=${reason.slice(0, 200)}`,
        );
        const startedAt = Date.now();
        try {
            const preview = await previewViaReceiptFallback(
                input,
                config,
                dependencies,
                fallbackModel,
            );
            logVisionPhase("success", fallbackModel, startedAt, 1);
            return preview;
        } catch {
            logVisionPhase("error", fallbackModel, startedAt, 1);
            throw chatError;
        }
    }
}

/**
 * B1 receipt correlation (audit §2 seat B1; brief seat S3): for
 * each food line, the production food search builds the candidate
 * shortlist and the Decisions seat (src/decisions/receipt.ts)
 * picks from it. Jev's pick probability REPLACES the extraction
 * self-confidence on the line — the value the review UI and the
 * reconcile path already use as the review trigger — discounted by
 * the plausibility probability when that answer is low, so a line
 * whose quantity/unit Jev finds implausible also lands in review.
 * A confident pick attaches its provider identity to the line.
 *
 * FAIL-OPEN: seat off / unconfigured / chain down / search down
 * all return the preview exactly as extraction produced it. Every
 * line already lands in human review either way.
 */
const RECEIPT_CORRELATION_SHORTLIST_LIMIT = 8;

async function correlateReceiptPreview(
    preview: InventoryVisionPreview,
    dependencies: InventoryVisionDependencies,
): Promise<CorrelatedInventoryVisionPreview> {
    // Seat gate FIRST: with B1 off or unconfigured the preview is
    // byte-identical to extraction — no searches, no model calls.
    const resolvedDecisionsConfig =
        dependencies.decisionsConfig !== undefined
            ? dependencies.decisionsConfig
            : decisionsConfig();
    if (!resolvedDecisionsConfig?.receiptEnabled) return preview;
    const foodIndexes = preview.lines
        .map((line, index) => (line.is_food ? index : -1))
        .filter((index) => index >= 0);
    if (foodIndexes.length === 0) return preview;
    const search =
        dependencies.receiptSearch ??
        (async (query: string, limit: number) => {
            const { getFoodSearchService } =
                await import("../food-providers/service.js");
            return getFoodSearchService().search(query, limit);
        });
    const searches = await Promise.all(
        foodIndexes.map(async (index) => {
            const line = preview.lines[index]!;
            try {
                const result = await search(
                    line.name,
                    RECEIPT_CORRELATION_SHORTLIST_LIMIT,
                );
                return { index, candidates: result.candidates };
            } catch {
                // A failed search leaves this line uncorrelated —
                // the seat fails open per line, never blocks the
                // preview on a provider outage.
                return { index, candidates: [] as FoodCandidate[] };
            }
        }),
    );
    const requests: ReceiptCorrelationRequest[] = searches
        .filter(({ candidates }) => candidates.length > 0)
        .map(({ index, candidates }) => {
            const line = preview.lines[index]!;
            return {
                key: `line:${index}`,
                rawLabel: line.raw_label,
                itemName: line.name,
                quantity: line.quantity,
                unit: line.unit,
                candidates: candidates.map((candidate) => ({
                    candidateId: encodeFoodCandidateId(candidate),
                    name: candidate.name,
                    brand: candidate.brand ?? null,
                    provider: candidate.provider,
                    providerFoodId: candidate.providerFoodId,
                })),
            };
        });
    if (requests.length === 0) return preview;
    const correlations = await correlateReceiptLines(requests, {
        fetcher: dependencies.decisionsFetcher,
        config: resolvedDecisionsConfig,
    });
    if (!correlations) return preview;
    const lines: InventoryVisionPreviewLine[] = preview.lines.map(
        (line, index) => {
            const correlation = correlations.get(`line:${index}`);
            if (!correlation) return line;
            const effective =
                correlation.plausibilityProbability != null
                    ? Math.min(
                          correlation.pickProbability,
                          correlation.plausibilityProbability,
                      )
                    : correlation.pickProbability;
            return {
                ...line,
                confidence: Math.min(1, Math.max(0, effective)),
                food_provider: correlation.provider,
                provider_food_id: correlation.providerFoodId,
            };
        },
    );
    return { ...preview, lines };
}

async function previewViaChatModel(
    input: {
        mode: InventoryVisionMode;
        mimeType: string;
        bytes: Uint8Array;
    },
    config = inventoryVisionConfig(),
    dependencies: InventoryVisionDependencies = {},
): Promise<InventoryVisionPreview> {
    if (!config) throw new Error("Pantry vision is not configured");
    if (!/^image\/(jpeg|png|webp)$/i.test(input.mimeType)) {
        throw new Error("Pantry image must be JPEG, PNG, or WebP");
    }
    if (
        input.bytes.byteLength < 1 ||
        input.bytes.byteLength > 8 * 1024 * 1024
    ) {
        throw new Error("Pantry image must be between 1 byte and 8 MB");
    }
    const startedAt = Date.now();
    const fetcher = dependencies.fetcher ?? fetch;
    const imageUrl = `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`;
    const requestBody = JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: config.maxTokens ?? DEFAULT_INVENTORY_VISION_MAX_TOKENS,
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "munch_pantry_vision_preview",
                strict: true,
                schema: inventoryVisionPreviewJsonSchema,
            },
        },
        plugins: [{ id: "response-healing" }],
        ...openRouterReasoningParam(config.model),
        provider: { data_collection: "deny" },
        messages: [
            {
                role: "system",
                content:
                    "You are a precise grocery and kitchen inventory extractor. Output one JSON object with exactly two top-level keys: lines and notes. notes MUST be an array of strings; use [] when there are no notes. Each line has raw_label, name, quantity, unit, is_food, confidence, location. location must be exactly pantry, fridge, freezer, or unspecified. Do not include payment data or personal information.",
            },
            {
                role: "user",
                content: [
                    { type: "text", text: prompt(input.mode) },
                    { type: "image_url", image_url: { url: imageUrl } },
                ],
            },
        ],
    });
    // S2 reliability pattern (recipe resolver is the reference): one
    // bounded retry when the model returns unparseable output; HTTP and
    // transport failures are not retried. A call that still cannot be
    // parsed throws — the user sees a retryable failure, never
    // fabricated lines.
    let callsUsed = 0;
    let lastParseError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
            callsUsed += 1;
            const response = await fetcher(
                `${config.baseUrl}/chat/completions`,
                {
                    method: "POST",
                    signal: controller.signal,
                    headers: {
                        authorization: `Bearer ${config.apiKey}`,
                        "content-type": "application/json",
                        ...(config.appUrl
                            ? { "http-referer": config.appUrl }
                            : {}),
                        "x-title": "Munch Pantry",
                    },
                    body: requestBody,
                },
            );
            if (!response.ok) {
                throw new Error(
                    `Pantry vision provider returned HTTP ${response.status}${await providerErrorDetail(response)}`,
                );
            }
            const payload = (await response.json()) as any;
            const text = responseText(payload?.choices?.[0]?.message?.content);
            if (!text) {
                lastParseError = new Error(
                    "Pantry vision returned no structured content",
                );
                continue;
            }
            let decoded: unknown;
            try {
                decoded = JSON.parse(text);
            } catch {
                lastParseError = new Error(
                    "Pantry vision returned invalid JSON",
                );
                continue;
            }
            try {
                const preview = previewSchema.parse(decoded);
                logVisionPhase("success", config.model, startedAt, callsUsed);
                return preview;
            } catch (error) {
                lastParseError = error;
                continue;
            }
        } catch (error) {
            // HTTP/transport failures keep the pre-S2 single-attempt
            // semantics; only unparseable output is retried above.
            logVisionPhase("error", config.model, startedAt, callsUsed);
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }
    logVisionPhase("error", config.model, startedAt, callsUsed);
    throw lastParseError instanceof Error
        ? lastParseError
        : new Error("Pantry vision returned unusable output");
}

/**
 * Labels-only receipt fallback: ScaleDown extraction through
 * OpenRouter's Extractions API (the exact request shape measured in
 * the Nov 11 receipt bake-off harness, scripts/receipt-extractions-
 * eval.ts). Only the raw printed labels are requested — no
 * quantities, units, or food judgements — so every line is mapped
 * with confidence 0, which routes it to the review step for
 * quantity/unit confirmation (the brief's degraded mode: degraded,
 * never blocked). Nothing is persisted here; the preview contract
 * is unchanged.
 */
const RECEIPT_RAW_LABELS_FIELD = {
    type: "list",
    items: "text",
    instructions:
        "Every purchased line item printed on the receipt, in receipt order, with the product label exactly as printed (including abbreviations). Do not include subtotal, total, tax, payment, change, loyalty, coupon, or discount lines.",
} as const;

function extractionsImageFormat(mimeType: string): string {
    if (/png$/i.test(mimeType)) return "png";
    if (/webp$/i.test(mimeType)) return "webp";
    return "jpeg";
}

async function previewViaReceiptFallback(
    input: { mimeType: string; bytes: Uint8Array },
    config: InventoryVisionConfig,
    dependencies: InventoryVisionDependencies,
    fallbackModel: string,
): Promise<InventoryVisionPreview> {
    const fetcher = dependencies.fetcher ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const response = await fetcher(
            config.extractionsUrl ?? DEFAULT_RECEIPT_EXTRACTIONS_URL,
            {
                method: "POST",
                signal: controller.signal,
                headers: {
                    authorization: `Bearer ${config.apiKey}`,
                    "content-type": "application/json",
                    "x-title": "Munch Pantry",
                },
                body: JSON.stringify({
                    model: fallbackModel,
                    fields: { raw_labels: RECEIPT_RAW_LABELS_FIELD },
                    assets: {
                        photo: {
                            type: "image",
                            format: extractionsImageFormat(input.mimeType),
                            data_base64: Buffer.from(input.bytes).toString(
                                "base64",
                            ),
                        },
                    },
                }),
            },
        );
        if (!response.ok) {
            throw new Error(
                `Receipt fallback provider returned HTTP ${response.status}${await providerErrorDetail(response)}`,
            );
        }
        const payload = (await response.json()) as any;
        const answer = payload?.answers?.raw_labels;
        const rawList = answer?.value ?? answer?.guess;
        const labels = (Array.isArray(rawList) ? rawList : [])
            .map((value: unknown) =>
                typeof value === "string" ? value.trim() : "",
            )
            .filter((label: string) => label.length > 0)
            .slice(0, 200);
        if (labels.length === 0) {
            throw new Error("Receipt fallback returned no line labels");
        }
        return {
            lines: labels.map((label: string) => ({
                raw_label: label,
                name: label,
                quantity: null,
                unit: null,
                is_food: true,
                confidence: 0,
                location: "unspecified" as const,
            })),
            notes: [
                "Receipt read with the labels-only fallback reader \u2014 check each line and add its quantity and unit.",
            ],
        };
    } finally {
        clearTimeout(timeout);
    }
}
