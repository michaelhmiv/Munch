import {
    addMealDraftQuestion,
    deleteMealDraftItem,
    replaceMealDraftItem,
    upsertMealDraftItem,
    type MealDraft,
} from "../meal-drafts/index.js";
import { blockingQuestionKey } from "../meal-drafts/blocking.js";
import { portionUnitKind } from "../food-providers/portions.js";
import { normalizeFoodText } from "../food-providers/ranking.js";
import { encodeFoodCandidateId } from "../food-providers/service.js";
import {
    groundMealPhotoItems,
    type GroundedMealPhotoItem,
    type MealPhotoGroundingDeps,
} from "./grounding.js";
import type { ParsedDraftAddItem } from "./draft-add-text.js";
import type {
    DraftAddAction,
    DraftAddModelParseResult,
    DraftAddParseContext,
    DraftAddParseContextItem,
    DraftAddPreparation,
} from "./draft-add-parse.js";
import type { MealPhotoVisionItem } from "./vision.js";

/**
 * Conversational note handling for photo meal drafts ("Anything else
 * to add?").
 *
 * MODEL-FIRST ARCHITECTURE (2026-11-22 revision):
 * The LLM decides what the user means; the code guarantees what
 * happens next.
 *
 * 1. Interpretation: every non-empty note is interpreted by Ember
 *    (`parseWithModel`, wired to draft-add-parse.ts) with the full
 *    current draft in context (each item's id, name, vision_name,
 *    cooking_method, quantity, and portion_label). No deterministic
 *    phrasing parser sits in front of the model.
 * 2. Validation & guarantees (this module):
 *    - `replace` / `remove` / `preparation` targets are validated by
 *      exact item id (must resolve to exactly one current draft item;
 *      unresolvable id or model-declared ambiguity → draft question,
 *      zero mutation).
 *    - `replace` applies quantity carry-over (stated quantity wins;
 *      unstated inherits the target's established quantity and unit),
 *      grounds through `groundMealPhotoItems`, and swaps atomically
 *      IN PLACE via `replaceMealDraftItem` (cascading old questions).
 *    - `remove` deletes the validated item via `deleteMealDraftItem`
 *      (cascading its questions).
 *    - `add` grounds through `groundMealPhotoItems` and checks
 *      grounded identity against existing draft items (same provider
 *      food identity or exact normalized display name → duplicate
 *      question, never appended blind).
 *    - Low-confidence gate: a weak ungrounded parse with no usable
 *      estimate, or a provider pick sharing no name token with the
 *      interpreted food, becomes a draft question.
 *    - Fail-open: model error, timeout, or invalid output → honest
 *      no-add with the draft byte-for-byte untouched.
 *    - Confirm-before-save is untouched.
 */

export interface DraftAddStore {
    addMealDraftQuestion: typeof addMealDraftQuestion;
    deleteMealDraftItem: typeof deleteMealDraftItem;
    upsertMealDraftItem: typeof upsertMealDraftItem;
    replaceMealDraftItem: typeof replaceMealDraftItem;
}

export interface DraftAddDeps extends MealPhotoGroundingDeps {
    /** Ember note interpreter (draft-add-parse.ts). Injected so tests
     * can script interpretations without live calls. Omit to fail open
     * (no-add, draft untouched). */
    parseWithModel?: (
        text: string,
        context: DraftAddParseContext,
    ) => Promise<DraftAddModelParseResult>;
    /** Optional persistence seam (defaults to the Postgres repository
     * functions); injected by tests to exercise addTextToPhotoDraft
     * end to end without a database. */
    store?: DraftAddStore;
}

/** A preparation correction as APPLIED to a draft item (P2). */
export interface AppliedPreparation {
    itemName: string;
    cookingMethod: string;
    previousMethod: string | null;
}

export type DraftAddOutcome =
    | {
          status: "added";
          draft: MealDraft;
          added: GroundedMealPhotoItem[];
          parseSource: "model";
          replacedItemName: string | null;
          preparation: AppliedPreparation | null;
          message: string;
      }
    | {
          status: "updated";
          draft: MealDraft;
          preparation: AppliedPreparation | null;
          removedItemName?: string | null;
          parseSource: "model";
          message: string;
      }
    | {
          status: "question";
          draft: MealDraft;
          parseSource: "model";
          message: string;
      }
    | {
          status: "no_add";
          draft: MealDraft;
          message: string;
      };

/**
 * The interpret → validate → ground → gate core, with NO database
 * access: tests exercise this chain directly, and `addTextToPhotoDraft`
 * persists what it decides.
 */
export type DraftAddResolution =
    | { kind: "none" }
    | { kind: "no_parse" }
    | {
          kind: "model_question";
          parseSource: "model";
          prompt: string | null;
      }
    | {
          kind: "question";
          parseSource: "model";
          parsed: ParsedDraftAddItem[];
          grounded: GroundedMealPhotoItem[];
          unresolvedNames: string[];
      }
    | {
          kind: "preparation_question";
          parseSource: "model";
          preparation: DraftAddPreparation;
      }
    | {
          kind: "replacement_question";
          parseSource: "model";
          parsed: ParsedDraftAddItem[];
          targetItemId: string | null;
          candidateNames: string[];
      }
    | {
          kind: "removal_question";
          parseSource: "model";
          targetItemId: string | null;
          candidateNames: string[];
      }
    | {
          kind: "duplicate_question";
          parseSource: "model";
          parsed: ParsedDraftAddItem[];
          grounded: GroundedMealPhotoItem[];
          existingItemName: string;
          addedItemName: string;
      }
    | {
          kind: "ready";
          action: Extract<
              DraftAddAction,
              "add" | "replace" | "remove" | "none"
          >;
          parseSource: "model";
          parsed: ParsedDraftAddItem[];
          grounded: GroundedMealPhotoItem[];
          /** Exact id of the draft item being replaced or removed; null on adds. */
          targetItemId: string | null;
          /** Display name of the draft item being replaced or removed; null on adds. */
          targetItemName: string | null;
          preparation: DraftAddPreparation | null;
          /** Exact id of the draft item targeted by `preparation`. */
          preparationTargetId: string | null;
          /** Display name of the draft item targeted by `preparation`. */
          preparationTargetName: string | null;
      };

function textHash(value: string): string {
    let hash = 5381;
    for (let index = 0; index < value.length; index++) {
        hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
}

function toVisionItem(item: ParsedDraftAddItem): MealPhotoVisionItem {
    return {
        name: item.name,
        cooking_method: null,
        quantity: item.quantity,
        unit: item.unit,
        portion_confidence: item.portionConfidence,
        assumptions: [...item.assumptions],
    };
}

/** Does the grounded candidate's display name share any token with
 * what the interpreter extracted? A pick sharing nothing is not a match. */
function pickSharesNameToken(
    parsedName: string,
    entry: GroundedMealPhotoItem,
): boolean {
    const wanted = new Set(
        normalizeFoodText(parsedName).split(" ").filter(Boolean),
    );
    const offered = new Set(
        normalizeFoodText(entry.draftItem.name).split(" ").filter(Boolean),
    );
    for (const token of wanted) {
        if (offered.has(token)) return true;
    }
    return false;
}

/** Validate that a model-supplied target id resolves to EXACTLY ONE
 * item in the current draft. Never guesses by name or token overlap. */
function findUniqueItemById<T extends { id: string }>(
    items: T[],
    targetId: string | null,
): T | null {
    if (!targetId) return null;
    const matches = items.filter((item) => item.id === targetId);
    return matches.length === 1 ? matches[0]! : null;
}

/** Extract the established `{ quantity, unit }` from an existing draft
 * item so a replacement inherits what the user/photo already set
 * instead of reverting to a bare "1 serving". */
export function extractTargetPortion(
    target: DraftAddParseContextItem,
): { quantity: number; unit: string } | null {
    const rawLabel = target.portionLabel?.trim();
    if (rawLabel) {
        // Strip trailing picker suffix like " · 85 g" or parenthetical weight.
        const cleaned = rawLabel
            .replace(/\s*·\s*.*$/, "")
            .replace(/\s*\([^)]*\)\s*$/, "")
            .trim();
        const match = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(cleaned);
        if (match) {
            const labelAmount = Number(match[1]);
            const labelUnit = match[2]!.trim();
            if (Number.isFinite(labelAmount) && labelAmount > 0 && labelUnit) {
                if (
                    portionUnitKind(labelUnit) === "weight" &&
                    target.gramWeight !== undefined &&
                    target.gramWeight !== null &&
                    target.gramWeight > 0
                ) {
                    if (
                        target.quantity !== undefined &&
                        target.quantity > 0 &&
                        Math.abs(target.quantity - labelAmount) < 1e-6
                    ) {
                        return { quantity: labelAmount, unit: labelUnit };
                    }
                    return { quantity: target.gramWeight, unit: "g" };
                }
                if (target.quantity !== undefined && target.quantity > 0) {
                    if (labelAmount > 1 && target.quantity === 1) {
                        return { quantity: labelAmount, unit: labelUnit };
                    }
                    return { quantity: target.quantity, unit: labelUnit };
                }
                return { quantity: labelAmount, unit: labelUnit };
            }
        }
        if (target.quantity !== undefined && target.quantity > 0 && cleaned) {
            return { quantity: target.quantity, unit: cleaned };
        }
    }
    if (
        target.gramWeight !== undefined &&
        target.gramWeight !== null &&
        target.gramWeight > 0
    ) {
        return { quantity: target.gramWeight, unit: "g" };
    }
    if (target.quantity !== undefined && target.quantity > 0) {
        return { quantity: target.quantity, unit: "serving" };
    }
    return null;
}

function applyQuantityCarryover(
    parsed: ParsedDraftAddItem,
    target: DraftAddParseContextItem,
): ParsedDraftAddItem {
    const carried = extractTargetPortion(target);
    if (!carried) return parsed;
    // Note stated NO quantity at all (model returned quantity: null):
    // inherit the replaced item's established quantity and unit.
    if (!parsed.strongSignal && parsed.quantityAssumed) {
        const filteredAssumptions = parsed.assumptions.filter(
            (assumption) =>
                !/default portion/i.test(assumption) &&
                !/no amount stated/i.test(assumption),
        );
        filteredAssumptions.push(
            `Carried over portion (${carried.quantity} ${carried.unit}) from replaced item "${target.name}".`,
        );
        return {
            ...parsed,
            quantity: carried.quantity,
            unit: carried.unit,
            portionConfidence: 0.9,
            assumptions: filteredAssumptions,
            quantityAssumed: false,
            strongSignal: true,
            unitAssumed: false,
        };
    }
    // Note stated a bare count without a unit ("just one bratwurst"):
    // the stated count wins, and the replaced item's count unit carries
    // over instead of downgrading to "serving".
    if (
        !parsed.quantityAssumed &&
        parsed.unitAssumed &&
        portionUnitKind(carried.unit) === "count"
    ) {
        return {
            ...parsed,
            unit: carried.unit,
            unitAssumed: false,
        };
    }
    return parsed;
}

function itemCandidateId(item: DraftAddParseContextItem): string | null {
    if (item.candidateId) return item.candidateId;
    if (
        (item.provider === "usda" || item.provider === "open_food_facts") &&
        item.providerFoodId
    ) {
        return encodeFoodCandidateId({
            provider: item.provider,
            providerFoodId: item.providerFoodId,
        });
    }
    return null;
}

/**
 * Grounded-identity duplicate check (validation outcome, NOT a
 * language/token-overlap rule): detects when an "add" resolved to the
 * exact same food already present in the draft — by matching provider
 * candidate identity, or (for ungrounded/estimated items without a
 * candidate id) exact normalized display name.
 */
function findDuplicateByGroundedIdentity(
    draftItems: DraftAddParseContextItem[],
    entry: GroundedMealPhotoItem,
): DraftAddParseContextItem | undefined {
    const entryCandidateId = entry.candidateId;
    const entryNameNorm = normalizeFoodText(entry.draftItem.name);
    for (const existing of draftItems) {
        const existingCandidateId = itemCandidateId(existing);
        if (
            entryCandidateId &&
            existingCandidateId &&
            entryCandidateId === existingCandidateId
        ) {
            return existing;
        }
        if (
            entryNameNorm &&
            normalizeFoodText(existing.name) === entryNameNorm
        ) {
            return existing;
        }
    }
    return undefined;
}

export async function resolveDraftAdd(
    text: string,
    deps: DraftAddDeps,
    draftItems: DraftAddParseContextItem[] = [],
): Promise<DraftAddResolution> {
    const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!trimmed) return { kind: "none" };
    if (!deps.parseWithModel) return { kind: "no_parse" };

    let model: DraftAddModelParseResult;
    try {
        model = await deps.parseWithModel(trimmed, { items: draftItems });
    } catch {
        // Fail-open: a failed interpretation never loses items and
        // never silently appends.
        return { kind: "no_parse" };
    }

    if (model.action === "question") {
        return {
            kind: "model_question",
            parseSource: "model",
            prompt: model.questionPrompt,
        };
    }

    // Validate preparation target by exact id (never guess on a
    // multi-item draft or an unknown id).
    let preparationTargetId: string | null = null;
    let preparationTargetName: string | null = null;
    if (model.preparation) {
        const prepTarget = model.preparation.targetItemId
            ? findUniqueItemById(draftItems, model.preparation.targetItemId)
            : draftItems.length === 1
              ? draftItems[0]!
              : null;
        if (!prepTarget) {
            return {
                kind: "preparation_question",
                parseSource: "model",
                preparation: model.preparation,
            };
        }
        preparationTargetId = prepTarget.id;
        preparationTargetName = prepTarget.name;
    }

    if (model.action === "none") {
        if (!model.preparation) return { kind: "none" };
        return {
            kind: "ready",
            action: "none",
            parseSource: "model",
            parsed: [],
            grounded: [],
            targetItemId: null,
            targetItemName: null,
            preparation: model.preparation,
            preparationTargetId,
            preparationTargetName,
        };
    }

    if (model.action === "remove") {
        const target = findUniqueItemById(draftItems, model.targetItemId);
        if (!target) {
            return {
                kind: "removal_question",
                parseSource: "model",
                targetItemId: model.targetItemId,
                candidateNames: draftItems.map((item) => item.name),
            };
        }
        return {
            kind: "ready",
            action: "remove",
            parseSource: "model",
            parsed: [],
            grounded: [],
            targetItemId: target.id,
            targetItemName: target.name,
            preparation: model.preparation,
            preparationTargetId,
            preparationTargetName,
        };
    }

    let items = model.items;
    let targetItemId: string | null = null;
    let targetItemName: string | null = null;

    if (model.action === "replace") {
        const target = findUniqueItemById(draftItems, model.targetItemId);
        if (!target || items.length === 0) {
            return {
                kind: "replacement_question",
                parseSource: "model",
                parsed: items,
                targetItemId: model.targetItemId,
                candidateNames: draftItems.map((item) => item.name),
            };
        }
        targetItemId = target.id;
        targetItemName = target.name;
        if (items.length === 1) {
            items = [applyQuantityCarryover(items[0]!, target)];
        }
    } else if (items.length === 0) {
        if (model.preparation) {
            return {
                kind: "ready",
                action: "none",
                parseSource: "model",
                parsed: [],
                grounded: [],
                targetItemId: null,
                targetItemName: null,
                preparation: model.preparation,
                preparationTargetId,
                preparationTargetName,
            };
        }
        return { kind: "no_parse" };
    }

    const grounded = await groundMealPhotoItems(items.map(toVisionItem), deps);

    // Low-confidence gate: a weak parse whose item carries NO usable
    // nutrition (no provider candidate, and the estimate step produced
    // nothing), or any pick sharing no name token with the food the
    // interpreter extracted, becomes a draft question — nothing
    // half-added.
    const unresolvedNames: string[] = [];
    grounded.forEach((entry, index) => {
        const parsed = items[index]!;
        if (entry.grounded) {
            if (!pickSharesNameToken(parsed.name, entry)) {
                unresolvedNames.push(parsed.name);
            }
        } else if (!parsed.strongSignal && !entry.estimated) {
            unresolvedNames.push(parsed.name);
        }
    });
    if (unresolvedNames.length > 0) {
        return {
            kind: "question",
            parseSource: "model",
            parsed: items,
            grounded,
            unresolvedNames,
        };
    }

    // Grounded-identity duplicate guard on pure adds: if an "add"
    // grounds to the exact same food already in the draft, ask before
    // appending a duplicate.
    if (model.action === "add" && !model.preparation && draftItems.length > 0) {
        for (const entry of grounded) {
            const duplicate = findDuplicateByGroundedIdentity(
                draftItems,
                entry,
            );
            if (duplicate) {
                return {
                    kind: "duplicate_question",
                    parseSource: "model",
                    parsed: items,
                    grounded,
                    existingItemName: duplicate.name,
                    addedItemName: entry.draftItem.name,
                };
            }
        }
    }

    // Mark every added/replaced item with honest user provenance in its
    // assumptions and source snapshot.
    const marked = grounded.map((entry, index) => ({
        ...entry,
        draftItem: {
            ...entry.draftItem,
            assumptions: [
                targetItemName
                    ? `Replaced "${targetItemName}" by you: "${trimmed}"`
                    : `Added by you: "${trimmed}"`,
                ...(entry.draftItem.assumptions ?? []),
            ].slice(0, 20),
            sourceSnapshot: {
                ...(entry.draftItem.sourceSnapshot ?? {}),
                draft_add_text: trimmed,
                draft_add_parse_source: "model",
                draft_add_quantity_assumed: items[index]!.quantityAssumed,
                ...(targetItemName
                    ? { draft_add_replaced_item: targetItemName }
                    : {}),
            },
        },
    }));

    return {
        kind: "ready",
        action: model.action,
        parseSource: "model",
        parsed: items,
        grounded: marked,
        targetItemId,
        targetItemName,
        preparation: model.preparation,
        preparationTargetId,
        preparationTargetName,
    };
}

/**
 * Plan a preparation correction on one draft item (photo-flow P2) —
 * pure, so recorded-fixture tests assert the exact persisted shape.
 * The corrected method is recorded in the item's assumptions (leading,
 * user-attributed) and in its source snapshot. The item's grounded
 * nutrition is NOT silently rewritten: any material nutrition effect
 * (absorbed frying oil, etc.) arrives as its own visible added item.
 */
export function planPreparationUpdate(
    item: MealDraft["items"][number]["item"],
    preparation: DraftAddPreparation,
): {
    item: MealDraft["items"][number]["item"];
    previousMethod: string | null;
} {
    const snapshot = item.sourceSnapshot ?? {};
    const previousMethod =
        typeof snapshot.cooking_method === "string" &&
        snapshot.cooking_method.trim()
            ? snapshot.cooking_method.trim()
            : null;
    const correction = previousMethod
        ? `Cooking method corrected by you: "${preparation.cookingMethod}" (photo estimate said "${previousMethod}").`
        : `Cooking method noted by you: "${preparation.cookingMethod}".`;
    return {
        item: {
            ...item,
            assumptions: [correction, ...(item.assumptions ?? [])].slice(0, 20),
            sourceSnapshot: {
                ...snapshot,
                cooking_method: preparation.cookingMethod,
                ...(previousMethod
                    ? { cooking_method_corrected_from: previousMethod }
                    : {}),
                cooking_method_corrected_via: "draft_add_text",
            },
        },
        previousMethod,
    };
}

const DEFAULT_STORE: DraftAddStore = {
    addMealDraftQuestion,
    deleteMealDraftItem,
    upsertMealDraftItem,
    replaceMealDraftItem,
};

function draftToParseContextItems(
    draft: MealDraft,
): DraftAddParseContextItem[] {
    return draft.items.map((record) => {
        const snapshot = record.item.sourceSnapshot ?? {};
        const candidateId =
            typeof snapshot.candidate_id === "string" &&
            snapshot.candidate_id.includes(":")
                ? snapshot.candidate_id
                : (record.item.provider === "usda" ||
                        record.item.provider === "open_food_facts") &&
                    record.item.providerFoodId
                  ? encodeFoodCandidateId({
                        provider: record.item.provider,
                        providerFoodId: record.item.providerFoodId,
                    })
                  : null;
        return {
            id: record.id,
            name: record.item.name,
            visionName:
                typeof snapshot.vision_name === "string"
                    ? snapshot.vision_name
                    : null,
            cookingMethod:
                typeof snapshot.cooking_method === "string"
                    ? snapshot.cooking_method
                    : null,
            quantity: record.item.quantity,
            portionLabel: record.item.portionLabel ?? null,
            gramWeight: record.item.gramWeight ?? null,
            provider: record.item.provider ?? null,
            providerFoodId: record.item.providerFoodId ?? null,
            candidateId,
        };
    });
}

/**
 * Interpret `text` with Ember, validate the interpretation, ground
 * any food items, and apply the change to the photo draft.
 * `draft` must be the caller's freshly loaded draft (its version
 * threads every repository write). On failure or ambiguity the draft
 * items remain untouched.
 */
export async function addTextToPhotoDraft(input: {
    userId: string;
    draft: MealDraft;
    text: string;
    deps: DraftAddDeps;
}): Promise<DraftAddOutcome> {
    const store = input.deps.store ?? DEFAULT_STORE;
    const text = input.text.replace(/\s+/g, " ").trim().slice(0, 500);
    let draft = input.draft;
    if (draft.sourceMode !== "photo") {
        throw new Error("Text adds are only available on photo drafts");
    }
    const resolution = await resolveDraftAdd(
        text,
        input.deps,
        draftToParseContextItems(draft),
    );
    if (resolution.kind === "none") {
        return {
            status: "no_add",
            draft,
            message: "Nothing added — the draft is unchanged.",
        };
    }
    if (resolution.kind === "no_parse") {
        return {
            status: "no_add",
            draft,
            message: `We couldn't interpret "${text}" against this draft. Try naming the food and amount, like "1 tbsp butter" — or edit the draft directly. Nothing was changed.`,
        };
    }
    if (resolution.kind === "model_question") {
        const prompt =
            resolution.prompt?.slice(0, 500) ||
            `We couldn't tell which item in this draft "${text.slice(0, 200)}" refers to. Which item did you mean?`;
        draft = await store.addMealDraftQuestion({
            userId: input.userId,
            draftId: draft.id,
            expectedVersion: draft.version,
            questionKey: `photo_draft_add_clarify_${textHash(text)}`,
            prompt,
            impactScore: 75,
        });
        return {
            status: "question",
            draft,
            parseSource: resolution.parseSource,
            message: `We couldn't tell which item "${text.slice(0, 200)}" refers to, so we left a question on the draft instead — nothing was changed.`,
        };
    }
    if (resolution.kind === "preparation_question") {
        draft = await store.addMealDraftQuestion({
            userId: input.userId,
            draftId: draft.id,
            expectedVersion: draft.version,
            questionKey: `photo_draft_add_preparation_${textHash(text)}`,
            prompt: `You noted a preparation change ("${text.slice(0, 200)}"), but we couldn't tell which item in this draft was ${resolution.preparation.cookingMethod}. Which item does it refer to? Answer here, or edit the item directly.`,
            impactScore: 70,
        });
        return {
            status: "question",
            draft,
            parseSource: resolution.parseSource,
            message: `We couldn't tell which item "${text.slice(0, 200)}" refers to, so we left a question on the draft instead — nothing was changed.`,
        };
    }
    if (resolution.kind === "replacement_question") {
        const replacementNames = resolution.parsed
            .map((item) => item.name)
            .join(", ")
            .slice(0, 160);
        const candidates = resolution.candidateNames
            .slice(0, 5)
            .join(", ")
            .slice(0, 200);
        const detail = candidates ? ` (current items: ${candidates})` : "";
        draft = await store.addMealDraftQuestion({
            userId: input.userId,
            draftId: draft.id,
            expectedVersion: draft.version,
            questionKey: `photo_draft_add_replace_${textHash(text)}`,
            prompt: `You noted a correction ("${text.slice(0, 200)}"), but we couldn't tell which item in this draft should be replaced${replacementNames ? ` with ${replacementNames}` : ""}${detail}. Which item did you mean to replace?`,
            impactScore: 75,
        });
        return {
            status: "question",
            draft,
            parseSource: resolution.parseSource,
            message: `We couldn't tell which item to replace from "${text.slice(0, 200)}", so we left a question on the draft instead — nothing was changed.`,
        };
    }
    if (resolution.kind === "removal_question") {
        const candidates = resolution.candidateNames
            .slice(0, 5)
            .join(", ")
            .slice(0, 200);
        const detail = candidates ? ` (current items: ${candidates})` : "";
        draft = await store.addMealDraftQuestion({
            userId: input.userId,
            draftId: draft.id,
            expectedVersion: draft.version,
            questionKey: `photo_draft_add_remove_${textHash(text)}`,
            prompt: `You asked to remove an item ("${text.slice(0, 200)}"), but we couldn't tell which item in this draft to remove${detail}. Which item should be removed?`,
            impactScore: 75,
        });
        return {
            status: "question",
            draft,
            parseSource: resolution.parseSource,
            message: `We couldn't tell which item to remove from "${text.slice(0, 200)}", so we left a question on the draft instead — nothing was changed.`,
        };
    }
    if (resolution.kind === "duplicate_question") {
        draft = await store.addMealDraftQuestion({
            userId: input.userId,
            draftId: draft.id,
            expectedVersion: draft.version,
            questionKey: `photo_draft_add_duplicate_${textHash(text)}`,
            prompt: `Your draft already includes "${resolution.existingItemName}". Did you mean to replace it with ${resolution.addedItemName} ("${text.slice(0, 200)}"), or add another? Reply here, or edit the item directly.`,
            impactScore: 75,
        });
        return {
            status: "question",
            draft,
            parseSource: resolution.parseSource,
            message: `Your draft already has ${resolution.existingItemName}, so we left a question instead of adding a duplicate — nothing was changed.`,
        };
    }
    if (resolution.kind === "question") {
        const names = resolution.unresolvedNames.join(", ").slice(0, 200);
        draft = await store.addMealDraftQuestion({
            userId: input.userId,
            draftId: draft.id,
            expectedVersion: draft.version,
            questionKey: `photo_draft_add_unresolved_${textHash(text)}`,
            prompt: `You asked to add "${text.slice(0, 200)}", but we couldn't pin down ${names} in a food database well enough to add it automatically. What exactly was it, and how much? Add it with the structured add below, or answer here with the details.`,
            impactScore: 70,
        });
        return {
            status: "question",
            draft,
            parseSource: resolution.parseSource,
            message: `We couldn't add ${names} automatically, so we left a question on the draft instead — nothing was half-added.`,
        };
    }

    // Preparation correction (P2): validated by exact item id.
    let appliedPreparation: AppliedPreparation | null = null;
    if (resolution.preparation && resolution.preparationTargetId) {
        const target = findUniqueItemById(
            draft.items,
            resolution.preparationTargetId,
        );
        if (target) {
            const planned = planPreparationUpdate(
                target.item,
                resolution.preparation,
            );
            draft = await store.upsertMealDraftItem({
                userId: input.userId,
                draftId: draft.id,
                expectedVersion: draft.version,
                position: target.position,
                item: planned.item,
            });
            appliedPreparation = {
                itemName: target.item.name,
                cookingMethod: resolution.preparation.cookingMethod,
                previousMethod: planned.previousMethod,
            };
        }
    }

    // Removal: validated by exact item id; cascades its questions.
    if (resolution.action === "remove" && resolution.targetItemId) {
        const target = findUniqueItemById(draft.items, resolution.targetItemId);
        if (!target) {
            draft = await store.addMealDraftQuestion({
                userId: input.userId,
                draftId: draft.id,
                expectedVersion: draft.version,
                questionKey: `photo_draft_add_remove_${textHash(text)}`,
                prompt: `We couldn't find the item to remove for "${text.slice(0, 200)}". Which item should be removed?`,
                impactScore: 75,
            });
            return {
                status: "question",
                draft,
                parseSource: resolution.parseSource,
                message: `We couldn't tell which item to remove from "${text.slice(0, 200)}", so we left a question on the draft instead — nothing was changed.`,
            };
        }
        draft = await store.deleteMealDraftItem({
            userId: input.userId,
            draftId: draft.id,
            itemId: target.id,
            expectedVersion: draft.version,
        });
        return {
            status: "updated",
            draft,
            preparation: appliedPreparation,
            removedItemName: target.item.name,
            parseSource: resolution.parseSource,
            message: `Removed ${target.item.name} from the draft.`,
        };
    }

    const grounded = resolution.grounded;
    let replacedItemName: string | null = null;
    let basePosition = draft.items.length;
    const added: GroundedMealPhotoItem[] = [];

    if (
        resolution.action === "replace" &&
        resolution.targetItemId &&
        grounded.length > 0
    ) {
        const target = findUniqueItemById(draft.items, resolution.targetItemId);
        if (!target) {
            draft = await store.addMealDraftQuestion({
                userId: input.userId,
                draftId: draft.id,
                expectedVersion: draft.version,
                questionKey: `photo_draft_add_replace_${textHash(text)}`,
                prompt: `We couldn't find the item to replace for "${text.slice(0, 200)}". Which item did you mean to replace?`,
                impactScore: 75,
            });
            return {
                status: "question",
                draft,
                parseSource: resolution.parseSource,
                message: `We couldn't tell which item to replace from "${text.slice(0, 200)}", so we left a question on the draft instead — nothing was changed.`,
            };
        }
        replacedItemName = target.item.name;
        basePosition = target.position;
        draft = await store.replaceMealDraftItem({
            userId: input.userId,
            draftId: draft.id,
            itemId: target.id,
            expectedVersion: draft.version,
            items: grounded.map((entry) => entry.draftItem),
        });
        added.push(...grounded);
    } else {
        for (const [index, entry] of grounded.entries()) {
            added.push(entry);
            draft = await store.upsertMealDraftItem({
                userId: input.userId,
                draftId: draft.id,
                expectedVersion: draft.version,
                position: basePosition + index,
                item: entry.draftItem,
            });
        }
    }

    // Questions reference persisted item records; keys are remapped to
    // the item's position in the DRAFT so they cannot collide with the
    // photo items' question keys (grounding keyed them from 0).
    for (const [index, entry] of added.entries()) {
        if (!entry.question) continue;
        const position = basePosition + index;
        const record = draft.items.find((item) => item.position === position);
        draft = await store.addMealDraftQuestion({
            userId: input.userId,
            draftId: draft.id,
            expectedVersion: draft.version,
            questionKey: entry.question.blocking
                ? blockingQuestionKey(position)
                : `photo_portion_${position}`,
            prompt: entry.question.prompt,
            impactScore: entry.question.impactScore,
            itemId: record?.id,
        });
    }

    const names = added.map((entry) => entry.draftItem.name).join(", ");
    if (added.length === 0 && appliedPreparation) {
        return {
            status: "updated",
            draft,
            preparation: appliedPreparation,
            parseSource: resolution.parseSource,
            message: `${appliedPreparation.itemName}: cooking method set to ${appliedPreparation.cookingMethod}${appliedPreparation.previousMethod ? ` (was ${appliedPreparation.previousMethod})` : ""}.`,
        };
    }
    const messageParts: string[] = [];
    if (replacedItemName) {
        messageParts.push(`Replaced ${replacedItemName} with ${names}.`);
    } else if (added.length > 0) {
        messageParts.push(`Added ${names} to the draft.`);
    }
    if (appliedPreparation) {
        messageParts.push(
            `${appliedPreparation.itemName}: cooking method set to ${appliedPreparation.cookingMethod}${appliedPreparation.previousMethod ? ` (was ${appliedPreparation.previousMethod})` : ""}.`,
        );
    }
    return {
        status: "added",
        draft,
        added,
        parseSource: resolution.parseSource,
        replacedItemName,
        preparation: appliedPreparation,
        message: messageParts.join(" ") || "Draft updated.",
    };
}
