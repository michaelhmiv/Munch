/**
 * S1 — the meal-photo front-door gate (approved brief, seat S1).
 *
 * One batched Decisions request per photo upload, asked BEFORE the
 * Ember identifier runs: a Noul "does this photo show food or drink
 * someone would log", a Choice routing the photo (plated meal / drink /
 * packaged product / receipt / other), and a Noul "is this photo clear
 * enough to identify". Question wording and the wire shape are the gate
 * probe's measured ones (scripts/photo-jev-probe.ts, "plain" style —
 * the style the labelled runs settled on): questions are written as
 * descriptions, not commands (TypeSafe docs), and the state is the
 * image plus one short line (small-state rule).
 *
 * FAIL-OPEN LAW: this function never throws and never blocks a photo on
 * doubt. Any error, timeout, unparseable answer, unsupported image, or
 * low-confidence reading returns "proceed" and the pipeline behaves
 * exactly as it did before the gate existed. The only action the gate
 * takes is a CONFIDENT not-food verdict: p(food) below the serving
 * model's calibrated threshold (config.ts) — measured 0/30 false
 * rejects on the real-photo fixture set at that threshold.
 *
 * The route sub-verdict is LOG-ONLY for now: no client-compatible
 * steering shape exists in the meal-photo route today for "this is a
 * receipt" (receipts enter through the pantry flow), so a confident
 * receipt route is recorded in the logs, never acted on.
 */
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import { gateFoodThresholdForModel, type DecisionsConfig } from "./config.js";

export type MealPhotoGateVerdict =
    | {
          action: "proceed";
          reason: string;
      }
    | {
          action: "no_food";
          reason: string;
          model: string;
          pFood: number;
          threshold: number;
          route: string | null;
      };

export interface MealPhotoGateDependencies {
    fetcher?: DecisionsFetcher;
}

const GATE_STATE_TEXT = "A user uploaded this photo to a meal-logging app.";

/** Probe-measured question set (plain style; see header). */
export function mealPhotoGateQuestions(): Record<string, unknown> {
    return {
        food: {
            type: "noul",
            instructions:
                "Does this photo show food or drink that someone would log as a meal in a nutrition-tracking app? Consider only what is visibly present in the photo itself.",
        },
        route: {
            type: "choice",
            instructions:
                "Which one of these best describes what this photo shows?",
            criteria: {
                plated_meal:
                    "A prepared meal or dish, served and ready to eat (on a plate, in a bowl, or as presented food items, including a single food item photographed as the subject).",
                drink: "A served beverage as the main subject (a glass, cup, or mug of a drink).",
                packaged_product:
                    "A retail-packaged food or drink product as the main subject (a sealed can, bottle, box, or wrapper, shown as a product).",
                receipt:
                    "A receipt or bill, on paper or on a screen, listing purchased items or a payment transaction.",
                other: "Something else — none of the other descriptions fit this photo.",
            },
        },
        clear: {
            type: "noul",
            instructions:
                "Is this photo clear and well-lit enough that a person could identify what food or drink it shows?",
        },
    };
}

const ROUTE_OPTIONS = [
    "plated_meal",
    "drink",
    "packaged_product",
    "receipt",
    "other",
] as const;

/**
 * Probability-of-yes for a Noul answer. The live shape is
 * `{"type":"noul","noul":<probability>}` (observed in the probe runs);
 * the cascade covers the other documented fields defensively. Returns
 * null when nothing parseable is present. Ported from the probe.
 */
export function noulProbability(answer: unknown): number | null {
    if (!answer || typeof answer !== "object") return null;
    const record = answer as Record<string, unknown>;
    if (typeof record.noul === "number") return record.noul;
    if (typeof record.probability === "number") return record.probability;
    const probs = record.probabilities;
    if (probs && typeof probs === "object") {
        for (const key of ["true", "yes", "True", "Yes"]) {
            const value = (probs as Record<string, unknown>)[key];
            if (typeof value === "number") return value;
        }
    }
    const value =
        typeof record.value === "boolean"
            ? record.value
            : typeof record.answer === "boolean"
              ? record.answer
              : null;
    if (value !== null && typeof record.confidence === "number") {
        return value ? record.confidence : 1 - record.confidence;
    }
    return null;
}

/** Minimal JPEG SOF parser (ported from the probe). */
function jpegDimensions(
    bytes: Uint8Array,
): { width: number; height: number } | null {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return null;
    }
    let offset = 2;
    while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        if (marker === 0xda) return null; // SOS: no SOF before scan data
        const length =
            ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
        if (length < 2) return null;
        if (
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf)
        ) {
            const height =
                ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
            const width =
                ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
            return { width, height };
        }
        offset += 2 + length;
    }
    return null;
}

/** PNG IHDR dimensions (width/height are big-endian at bytes 16–24). */
function pngDimensions(
    bytes: Uint8Array,
): { width: number; height: number } | null {
    if (
        bytes.length < 24 ||
        bytes[0] !== 0x89 ||
        bytes[1] !== 0x50 ||
        bytes[2] !== 0x4e ||
        bytes[3] !== 0x47
    ) {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** TypeSafe accepts image sides in the 280–1568 px range (probe). */
function dimensionsInRange(dims: { width: number; height: number }): boolean {
    return (
        dims.width >= 280 &&
        dims.width <= 1568 &&
        dims.height >= 280 &&
        dims.height <= 1568
    );
}

/**
 * Evaluate the gate for one uploaded photo. NEVER throws: every
 * failure mode resolves to `{ action: "proceed" }` (fail-open).
 */
export async function evaluateMealPhotoGate(
    input: { mimeType: string; bytes: Uint8Array },
    config: DecisionsConfig,
    dependencies: MealPhotoGateDependencies = {},
): Promise<MealPhotoGateVerdict> {
    const proceed = (reason: string): MealPhotoGateVerdict => {
        console.info(`[decisions] seat=gate status=fail_open reason=${reason}`);
        return { action: "proceed", reason };
    };
    try {
        // TypeSafe image input is data: JPEG/PNG base64 only; anything
        // else (e.g. a WebP upload) skips the gate and proceeds.
        const mimeType = input.mimeType.trim().toLowerCase();
        if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
            return proceed("unsupported_media_type");
        }
        const dims =
            mimeType === "image/jpeg"
                ? jpegDimensions(input.bytes)
                : pngDimensions(input.bytes);
        if (!dims || !dimensionsInRange(dims)) {
            // The client capture path downscales to <=1568px before
            // upload; anything outside TypeSafe's 280–1568 window is
            // not gated rather than resized server-side.
            return proceed("image_dimensions_out_of_range");
        }
        const result = await callDecisionsWithFallback(config, {
            seat: "gate",
            timeoutMs: config.gateTimeoutMs,
            includeImageHeader: true,
            fetcher: dependencies.fetcher,
            state: [
                {
                    type: "image_url",
                    image_url: {
                        url: `data:${mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`,
                    },
                },
                GATE_STATE_TEXT,
            ],
            questions: mealPhotoGateQuestions(),
        });
        const pFood = noulProbability(result.answers.food);
        const pClear = noulProbability(result.answers.clear);
        const routeAnswer = result.answers.route as
            Record<string, unknown> | undefined;
        const route =
            routeAnswer &&
            routeAnswer.type === "choice" &&
            typeof routeAnswer.choice === "string" &&
            (ROUTE_OPTIONS as readonly string[]).includes(routeAnswer.choice)
                ? routeAnswer.choice
                : null;
        // Route is log-only (see header): a confident receipt verdict
        // is recorded, never steered on.
        console.info(
            `[decisions] seat=gate verdict p_food=${pFood ?? "null"} p_clear=${pClear ?? "null"} route=${route ?? "null"} model=${result.model}`,
        );
        if (pFood === null) {
            return proceed("unparseable_food_answer");
        }
        const threshold = gateFoodThresholdForModel(result.model);
        if (pFood < threshold) {
            return {
                action: "no_food",
                reason: "confident_not_food",
                model: result.model,
                pFood,
                threshold,
                route,
            };
        }
        return { action: "proceed", reason: "food_probable" };
    } catch {
        return proceed("decisions_unavailable");
    }
}
