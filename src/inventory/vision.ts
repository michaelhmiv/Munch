import { z } from "zod";

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
        notes: z.array(z.string().max(300)).max(10),
    })
    .strict();

export type InventoryVisionPreview = z.infer<typeof previewSchema>;
export type InventoryVisionMode = "receipt" | "pantry_photo";

export interface InventoryVisionConfig {
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
    appUrl?: string;
}

export interface InventoryVisionDependencies {
    fetcher?: (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => Promise<Response>;
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

export function inventoryVisionConfig(
    env: Record<string, string | undefined> = process.env,
): InventoryVisionConfig | null {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (!apiKey || !enabledFlag(env.MUNCH_PANTRY_VISION_ENABLED)) return null;
    return {
        apiKey,
        model:
            env.MUNCH_PANTRY_VISION_MODEL?.trim() ||
            env.MUNCH_RECIPE_IMPORT_AI_MODEL?.trim() ||
            "openai/gpt-5.6-luna",
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
        appUrl: env.MUNCH_APP_BASE_URL?.trim(),
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

export async function previewInventoryImage(
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const fetcher = dependencies.fetcher ?? fetch;
    try {
        const imageUrl = `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`;
        const response = await fetcher(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${config.apiKey}`,
                "content-type": "application/json",
                ...(config.appUrl ? { "http-referer": config.appUrl } : {}),
                "x-title": "Munch Pantry",
            },
            body: JSON.stringify({
                model: config.model,
                temperature: 0,
                max_tokens: 4000,
                response_format: { type: "json_object" },
                provider: { data_collection: "deny" },
                messages: [
                    {
                        role: "system",
                        content:
                            "You are a precise grocery and kitchen inventory extractor. Output an object with keys lines and notes. Each line has raw_label, name, quantity, unit, is_food, confidence, location. location must be exactly pantry, fridge, freezer, or unspecified. Do not include payment data or personal information.",
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt(input.mode) },
                            { type: "image_url", image_url: { url: imageUrl } },
                        ],
                    },
                ],
            }),
        });
        if (!response.ok) {
            throw new Error(
                `Pantry vision provider returned HTTP ${response.status}`,
            );
        }
        const payload = (await response.json()) as any;
        const text = responseText(payload?.choices?.[0]?.message?.content);
        if (!text)
            throw new Error("Pantry vision returned no structured content");
        let decoded: unknown;
        try {
            decoded = JSON.parse(text);
        } catch {
            throw new Error("Pantry vision returned invalid JSON");
        }
        return previewSchema.parse(decoded);
    } finally {
        clearTimeout(timeout);
    }
}
