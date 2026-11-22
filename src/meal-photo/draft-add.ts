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
import {
    groundMealPhotoItems,
    type GroundedMealPhotoItem,
    type MealPhotoGroundingDeps,
} from "./grounding.js";
import {
    parseDraftAddTextDeterministic,
    type ParsedDraftAddItem,
} from "./draft-add-text.js";
import type {
    DraftAddModelParseResult,
    DraftAddParseContext,
    DraftAddParseContextItem,
    DraftAddPreparation,
} from "./draft-add-parse.js";
import type { MealPhotoVisionItem } from "./vision.js";

/**
 * Conversational add-to-draft for the photo flow (Amendment E item 3).
 *
 * The user photographs chicken and broccoli, reviews the draft, and
 * answers "Anything else to add?" with free text — "I added a good bit
 * of butter" or a correction like "it was bratwurst" / "actually
 * bratwurst, not hot dog". The text is parsed DETERMINISTICALLY first
 * (draft-add-text.ts, reusing the recipe-import ingredient parser);
 * the Ember fallback (draft-add-parse.ts, injected as `parseWithModel`)
 * is spent only on deterministic failure or when an implicit
 * correction on a multi-item draft needs semantic target resolution.
 * The parsed item then goes through the SAME grounding path as photo
 * items (`groundMealPhotoItems`: canonical search → deterministic
 * ranking with the Ember tie-break only in the ambiguity band →
 * provider values; ungrounded → the labelled model-estimate step or a
 * BLOCKING question). The S3-hardening pipeline invariant therefore
 * holds for added and replaced items identically, and everything lands
 * in the existing draft machinery — confirm-before-save is untouched.
 *
 * LOW CONFIDENCE = QUESTION, NEVER A SILENT ADD:
 * - Unparseable text (both parsers resolve nothing) → honest no-add
 *   response in the review; the draft is unchanged.
 * - An ambiguous or unmatched replacement target → a draft QUESTION,
 *   never a guess and never a silent append.
 * - A pure add whose food closely matches an item already in the draft
 *   (probable correction / near-duplicate) → a draft QUESTION asking
 *   whether to replace or add another, never appended blind.
 * - A weak parse (bare food name, defaulted portion) whose item ends
 *   with NO usable nutrition — grounding found no provider candidate
 *   AND the estimate step produced nothing → a draft QUESTION: there
 *   is nothing to add. But a weak parse whose item carries labelled
 *   model-estimate values IS added, exactly like a strong parse's
 *   estimate: the quantity is the parse's stated default-portion
 *   assumption and the values are the pipeline's labelled estimate,
 *   both shown on the item for review (production incident
 *   2026-11-13: "I added butter" on an apple photo draft punted to a
 *   question even though butter priced out fine as an estimate —
 *   the approved review design adds a plainly named food with a
 *   stated assumption instead of punting).
 * - A grounded pick that shares no name token with what the user
 *   typed is not a match at all → draft question, nothing added.
 * - A strong parse that stays ungrounded follows the photo pipeline:
 *   labelled "Model estimate" values, or a blocking question when the
 *   estimate step fails.
 *
 * Added/replaced items are marked with user provenance in their
 * assumptions and source snapshot — provenance stays honest.
 */

export interface DraftAddStore {
    addMealDraftQuestion: typeof addMealDraftQuestion;
    deleteMealDraftItem: typeof deleteMealDraftItem;
    upsertMealDraftItem: typeof upsertMealDraftItem;
    replaceMealDraftItem: typeof replaceMealDraftItem;
}

export interface DraftAddDeps extends MealPhotoGroundingDeps {
    /** Ember fallback parse (draft-add-parse.ts). Injected so tests
     * can count calls and replay recorded responses. Omit to disable
     * the fallback (deterministic-only). The parse receives the
     * draft's current items as context so corrections and preparation
     * statements can name the item they target. */
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
          parseSource: "deterministic" | "model";
          replacedItemName: string | null;
          preparation: AppliedPreparation | null;
          message: string;
      }
    | {
          status: "updated";
          draft: MealDraft;
          preparation: AppliedPreparation;
          parseSource: "deterministic" | "model";
          message: string;
      }
    | {
          status: "question";
          draft: MealDraft;
          parseSource: "deterministic" | "model";
          message: string;
      }
    | {
          status: "no_add";
          draft: MealDraft;
          message: string;
      };

/**
 * The parse → ground → low-confidence-gate core, with NO database
 * access: recorded-fixture tests exercise exactly this chain, and
 * `addTextToPhotoDraft` persists what it decides.
 */
export type DraftAddResolution =
    | { kind: "none" }
    | { kind: "no_parse" }
    | {
          kind: "question";
          parseSource: "deterministic" | "model";
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
          parseSource: "deterministic" | "model";
          parsed: ParsedDraftAddItem[];
          targetName: string | null;
          candidateNames: string[];
      }
    | {
          kind: "duplicate_question";
          parseSource: "deterministic" | "model";
          parsed: ParsedDraftAddItem[];
          grounded: GroundedMealPhotoItem[];
          existingItemName: string;
          addedItemName: string;
      }
    | {
          kind: "ready";
          parseSource: "deterministic" | "model";
          parsed: ParsedDraftAddItem[];
          grounded: GroundedMealPhotoItem[];
          removeName: string | null;
          preparation: DraftAddPreparation | null;
          /** The draft-context item name the preparation targets
           * (already matched during resolution); null when there is
           * no preparation or it could not be targeted — the latter
           * resolves as "preparation_question" instead. */
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
 * what the user typed? A pick sharing nothing is not a match. */
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

const GENERIC_MODIFIER_TOKENS = new Set([
    "hot",
    "cold",
    "warm",
    "sweet",
    "sour",
    "spicy",
    "mild",
    "fresh",
    "raw",
    "cooked",
    "grilled",
    "fried",
    "baked",
    "steamed",
    "roasted",
    "boiled",
    "smoked",
    "salted",
    "unsalted",
    "plain",
    "large",
    "small",
    "medium",
    "mini",
    "whole",
    "sliced",
    "chopped",
    "diced",
    "ground",
    "lean",
    "extra",
    "light",
    "dark",
    "white",
    "brown",
    "red",
    "green",
    "yellow",
    "black",
    "blue",
    "organic",
    "homemade",
    "style",
    "with",
    "and",
    "in",
    "on",
    "of",
    "the",
    "a",
    "an",
]);

function stemFoodToken(token: string): string {
    if (token.length > 4 && token.endsWith("ies")) {
        return `${token.slice(0, -3)}y`;
    }
    if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
        return token.slice(0, -1);
    }
    return token;
}

function stemmedTokens(text: string): string[] {
    return normalizeFoodText(text)
        .split(" ")
        .filter(Boolean)
        .map(stemFoodToken);
}

function phraseContains(
    haystackTokens: string[],
    needleTokens: string[],
): boolean {
    if (
        needleTokens.length === 0 ||
        needleTokens.length > haystackTokens.length
    ) {
        return false;
    }
    for (let i = 0; i <= haystackTokens.length - needleTokens.length; i++) {
        let all = true;
        for (let j = 0; j < needleTokens.length; j++) {
            if (haystackTokens[i + j] !== needleTokens[j]) {
                all = false;
                break;
            }
        }
        if (all) return true;
    }
    return false;
}

/** Score how specifically `candidateName` matches `wantedName`:
 * 1 = exact (modulo case/punctuation/plural),
 * 2 = contiguous phrase containment,
 * 3 = all tokens of one appear in the other,
 * 4 = shared non-generic food token,
 * null = no match. */
function nameMatchTier(
    candidateName: string,
    wantedName: string,
): number | null {
    const cand = stemmedTokens(candidateName);
    const wanted = stemmedTokens(wantedName);
    if (cand.length === 0 || wanted.length === 0) return null;
    const candJoined = cand.join(" ");
    const wantedJoined = wanted.join(" ");
    if (candJoined === wantedJoined) return 1;
    if (phraseContains(cand, wanted) || phraseContains(wanted, cand)) {
        return 2;
    }
    const candSet = new Set(cand);
    const wantedSet = new Set(wanted);
    if (
        wanted.every((token) => candSet.has(token)) ||
        cand.every((token) => wantedSet.has(token))
    ) {
        return 3;
    }
    const hasSpecificOverlap = wanted.some(
        (token) => !GENERIC_MODIFIER_TOKENS.has(token) && candSet.has(token),
    );
    return hasSpecificOverlap ? 4 : null;
}

type TargetMatchResult<T> =
    | { kind: "matched"; item: T }
    | { kind: "ambiguous"; candidates: T[] }
    | { kind: "none" };

function matchDraftItemTarget<
    T extends { name: string; visionName?: string | null },
>(items: T[], wantedName: string): TargetMatchResult<T> {
    let bestTier = Infinity;
    let matches: T[] = [];
    for (const item of items) {
        const names = [item.name];
        if (item.visionName && item.visionName !== item.name) {
            names.push(item.visionName);
        }
        let itemBest: number | null = null;
        for (const candidateName of names) {
            const tier = nameMatchTier(candidateName, wantedName);
            if (tier !== null && (itemBest === null || tier < itemBest)) {
                itemBest = tier;
            }
        }
        if (itemBest === null) continue;
        if (itemBest < bestTier) {
            bestTier = itemBest;
            matches = [item];
        } else if (itemBest === bestTier) {
            matches.push(item);
        }
    }
    if (matches.length === 0) return { kind: "none" };
    if (matches.length === 1) return { kind: "matched", item: matches[0]! };
    return { kind: "ambiguous", candidates: matches };
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
    // User stated NO quantity at all (bare replacement name): inherit
    // the replaced item's established quantity and unit.
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
    // User stated an explicit count without a unit ("just one bratwurst"):
    // their stated count wins, and the replaced item's count unit carries
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

const EXPLICIT_ADDITIONAL_PATTERN =
    /\b(?:another|more|extra|second|third|additional|other)\b/i;

function primaryHeadTokens(name: string): string[] {
    const head = name.split(",")[0] ?? name;
    return stemmedTokens(head);
}

function isNearDuplicateName(a: string, b: string): boolean {
    const aTokens = stemmedTokens(a);
    const bTokens = stemmedTokens(b);
    if (aTokens.length === 0 || bTokens.length === 0) return false;
    if (aTokens.join(" ") === bTokens.join(" ")) return true;
    const aHead = primaryHeadTokens(a).join(" ");
    const bHead = primaryHeadTokens(b).join(" ");
    if (aHead && bHead && aHead === bHead) return true;
    if (
        (aTokens.length >= 2 && phraseContains(bTokens, aTokens)) ||
        (bTokens.length >= 2 && phraseContains(aTokens, bTokens))
    ) {
        return true;
    }
    const aMeaningful = new Set(
        aTokens.filter((token) => !GENERIC_MODIFIER_TOKENS.has(token)),
    );
    const bMeaningful = new Set(
        bTokens.filter((token) => !GENERIC_MODIFIER_TOKENS.has(token)),
    );
    if (aMeaningful.size === 0 || bMeaningful.size === 0) return false;
    let shared = 0;
    for (const token of aMeaningful) {
        if (bMeaningful.has(token)) shared += 1;
    }
    const union = aMeaningful.size + bMeaningful.size - shared;
    return union > 0 && shared / union >= 0.6;
}

function findDuplicateDraftItem(
    draftItems: DraftAddParseContextItem[],
    parsedName: string,
    groundedName: string,
): DraftAddParseContextItem | undefined {
    for (const existing of draftItems) {
        const existingNames = [existing.name];
        if (existing.visionName && existing.visionName !== existing.name) {
            existingNames.push(existing.visionName);
        }
        for (const existingName of existingNames) {
            if (
                isNearDuplicateName(existingName, parsedName) ||
                isNearDuplicateName(existingName, groundedName)
            ) {
                return existing;
            }
        }
    }
    return undefined;
}

export async function resolveDraftAdd(
    text: string,
    deps: DraftAddDeps,
    draftItems: DraftAddParseContextItem[] = [],
): Promise<DraftAddResolution> {
    const deterministic = parseDraftAddTextDeterministic(
        text,
        draftItems.map((item) => item.name),
    );
    if (deterministic?.kind === "none") return { kind: "none" };

    let parseSource: "deterministic" | "model";
    let items: ParsedDraftAddItem[];
    let removeName: string | null;
    let isReplacement = false;
    let preparation: DraftAddPreparation | null = null;
    let preparationTargetName: string | null = null;

    const needsModelTargetDisambiguation =
        deterministic?.kind === "replace" &&
        deterministic.removeName === null &&
        draftItems.length > 1;

    if (
        deterministic?.kind === "add" ||
        (deterministic?.kind === "replace" && !needsModelTargetDisambiguation)
    ) {
        parseSource = "deterministic";
        items = deterministic.items;
        isReplacement = deterministic.kind === "replace";
        removeName =
            deterministic.kind === "replace"
                ? (deterministic.removeName ??
                  (draftItems.length === 1 ? draftItems[0]!.name : null))
                : null;
    } else if (needsModelTargetDisambiguation) {
        // Implicit correction ("it was bratwurst", "those are bratwurst",
        // "actually bratwurst") on a multi-item draft: ask the model to
        // resolve the semantic target from <draft-items>. If the model is
        // absent or fails, fail open to a draft question — never guess and
        // never silently append.
        if (deps.parseWithModel) {
            try {
                const model = await deps.parseWithModel(text, {
                    items: draftItems,
                });
                preparation = model.preparation;
                if (model.items.length === 0 && !preparation) {
                    return { kind: "no_parse" };
                }
                parseSource = "model";
                items = model.items;
                removeName = model.replaces;
                isReplacement = Boolean(
                    model.isReplacement || model.replaces || !preparation,
                );
            } catch {
                parseSource = "deterministic";
                items = deterministic.items;
                removeName = null;
                isReplacement = true;
            }
        } else {
            parseSource = "deterministic";
            items = deterministic.items;
            removeName = null;
            isReplacement = true;
        }
    } else {
        // Deterministic failure is the ONLY other path that spends the
        // Ember fallback.
        if (!deps.parseWithModel) return { kind: "no_parse" };
        let model: DraftAddModelParseResult;
        try {
            model = await deps.parseWithModel(text, { items: draftItems });
        } catch {
            // A failed fallback is an honest no-add, never a silent add.
            return { kind: "no_parse" };
        }
        preparation = model.preparation;
        if (model.items.length === 0 && !preparation) {
            return { kind: "no_parse" };
        }
        parseSource = "model";
        items = model.items;
        removeName = model.replaces;
        isReplacement = Boolean(model.isReplacement || model.replaces);
    }

    if (preparation) {
        // The preparation must land on a KNOWN item: a named target that
        // matches nothing (or is ambiguous), or an unnamed target on a
        // multi-item draft, becomes a question — never a guess.
        if (preparation.targetItem) {
            const match = matchDraftItemTarget(
                draftItems,
                preparation.targetItem,
            );
            if (match.kind !== "matched") {
                return {
                    kind: "preparation_question",
                    parseSource: "model",
                    preparation,
                };
            }
            preparationTargetName = match.item.name;
        } else if (draftItems.length === 1) {
            preparationTargetName = draftItems[0]!.name;
        } else {
            return {
                kind: "preparation_question",
                parseSource: "model",
                preparation,
            };
        }
    }

    // Replacement target resolution + quantity carryover (Defects 1 & 3):
    // resolve the target BEFORE grounding so ambiguous/missing targets
    // produce a draft question instead of appending, and a matched
    // target's quantity carries over cleanly into grounding.
    let replacementTarget: DraftAddParseContextItem | null = null;
    if (isReplacement) {
        if (removeName === null) {
            if (draftItems.length === 1) {
                replacementTarget = draftItems[0]!;
                removeName = replacementTarget.name;
            } else {
                return {
                    kind: "replacement_question",
                    parseSource,
                    parsed: items,
                    targetName: null,
                    candidateNames: draftItems.map((item) => item.name),
                };
            }
        } else if (draftItems.length > 0) {
            const match = matchDraftItemTarget(draftItems, removeName);
            if (match.kind === "matched") {
                replacementTarget = match.item;
                removeName = match.item.name;
            } else {
                return {
                    kind: "replacement_question",
                    parseSource,
                    parsed: items,
                    targetName: removeName,
                    candidateNames:
                        match.kind === "ambiguous"
                            ? match.candidates.map((item) => item.name)
                            : draftItems.map((item) => item.name),
                };
            }
        }
    }

    if (replacementTarget && items.length === 1) {
        items = [applyQuantityCarryover(items[0]!, replacementTarget)];
    }

    const grounded = await groundMealPhotoItems(items.map(toVisionItem), deps);

    // Low-confidence gate: a weak parse whose item carries NO usable
    // nutrition (no provider candidate, and the estimate step
    // produced nothing), or any pick sharing no name token with the
    // typed food, becomes a draft question — nothing half-added. A
    // weak parse WITH labelled estimate values is added: its quantity
    // is the stated default-portion assumption, its values the
    // pipeline's labelled estimate — the same posture a strong parse
    // gets, and the one the approved review design promises for a
    // plainly named food.
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
            parseSource,
            parsed: items,
            grounded,
            unresolvedNames,
        };
    }

    // Duplicate guard (Defect 1): a pure add whose food closely matches
    // an item already in the draft is treated as a probable correction
    // and confirmed via a draft question, never appended blind — unless
    // the user explicitly asked for "more"/"another"/"extra".
    if (
        !isReplacement &&
        !preparation &&
        draftItems.length > 0 &&
        !EXPLICIT_ADDITIONAL_PATTERN.test(text)
    ) {
        for (const [index, entry] of grounded.entries()) {
            const parsed = items[index]!;
            const duplicate = findDuplicateDraftItem(
                draftItems,
                parsed.name,
                entry.draftItem.name,
            );
            if (duplicate) {
                return {
                    kind: "duplicate_question",
                    parseSource,
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
                removeName
                    ? `Replaced "${removeName}" by you: "${text}"`
                    : `Added by you: "${text}"`,
                ...(entry.draftItem.assumptions ?? []),
            ].slice(0, 20),
            sourceSnapshot: {
                ...(entry.draftItem.sourceSnapshot ?? {}),
                draft_add_text: text,
                draft_add_parse_source: parseSource,
                draft_add_quantity_assumed: items[index]!.quantityAssumed,
                ...(removeName ? { draft_add_replaced_item: removeName } : {}),
            },
        },
    }));
    return {
        kind: "ready",
        parseSource,
        parsed: items,
        grounded: marked,
        removeName,
        preparation,
        preparationTargetName,
    };
}

function findDraftItemMatch(
    draft: MealDraft,
    wantedName: string,
): TargetMatchResult<MealDraft["items"][number]> {
    const wrapped = draft.items.map((record) => ({
        record,
        name: record.item.name,
        visionName:
            typeof record.item.sourceSnapshot?.vision_name === "string"
                ? record.item.sourceSnapshot.vision_name
                : null,
    }));
    const match = matchDraftItemTarget(wrapped, wantedName);
    if (match.kind === "matched") {
        return { kind: "matched", item: match.item.record };
    }
    if (match.kind === "ambiguous") {
        return {
            kind: "ambiguous",
            candidates: match.candidates.map((entry) => entry.record),
        };
    }
    return { kind: "none" };
}

/**
 * Plan a preparation correction on one draft item (photo-flow P2) —
 * pure, so the recorded-fixture tests assert the exact persisted
 * shape. The corrected method is recorded in the item's assumptions
 * (leading, user-attributed) and in its source snapshot, where
 * grounding put the photo's original method read. The item's grounded
 * nutrition is NOT silently rewritten: the method's material
 * nutrition effect (absorbed frying oil, etc.) arrives as its own
 * visible added item through the ordinary grounding path.
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

/**
 * Parse `text`, ground the result, and add or replace in the photo draft.
 * `draft` must be the caller's freshly loaded draft (its version
 * threads every repository write). The returned draft is the latest
 * persisted state for "added"/"updated"/"question" outcomes; for
 * "no_add" the input draft is returned unchanged.
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
        draft.items.map((record) => ({
            name: record.item.name,
            cookingMethod:
                typeof record.item.sourceSnapshot?.cooking_method === "string"
                    ? record.item.sourceSnapshot.cooking_method
                    : null,
            quantity: record.item.quantity,
            portionLabel: record.item.portionLabel ?? null,
            gramWeight: record.item.gramWeight ?? null,
            visionName:
                typeof record.item.sourceSnapshot?.vision_name === "string"
                    ? record.item.sourceSnapshot.vision_name
                    : null,
        })),
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
            message: `We couldn't identify a food to add from "${text}". Try naming the food and amount, like "1 tbsp butter" — or use the structured add below. Nothing was added.`,
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

    const grounded = resolution.grounded;

    // Preparation correction (P2): the corrected cooking method lands
    // on the existing item as a visible, user-attributed update.
    let appliedPreparation: AppliedPreparation | null = null;
    if (resolution.preparation && resolution.preparationTargetName) {
        const targetMatch = findDraftItemMatch(
            draft,
            resolution.preparationTargetName,
        );
        if (targetMatch.kind === "matched") {
            const target = targetMatch.item;
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

    // Replacement lands IN PLACE at the target item's position in a
    // single atomic transaction (old item and its questions cascade;
    // replacement item(s) take its slot). If the target cannot be
    // uniquely matched, fail open to a draft question — never append.
    let replacedItemName: string | null = null;
    let basePosition = draft.items.length;
    const added: GroundedMealPhotoItem[] = [];

    if (resolution.removeName && grounded.length > 0) {
        const targetMatch = findDraftItemMatch(draft, resolution.removeName);
        if (targetMatch.kind !== "matched") {
            const candidates = (
                targetMatch.kind === "ambiguous"
                    ? targetMatch.candidates
                    : draft.items
            )
                .map((record) => record.item.name)
                .slice(0, 5)
                .join(", ");
            draft = await store.addMealDraftQuestion({
                userId: input.userId,
                draftId: draft.id,
                expectedVersion: draft.version,
                questionKey: `photo_draft_add_replace_${textHash(text)}`,
                prompt: `You noted a correction ("${text.slice(0, 200)}"), but we couldn't uniquely match "${resolution.removeName}" in this draft${candidates ? ` (${candidates})` : ""}. Which item did you mean to replace?`,
                impactScore: 75,
            });
            return {
                status: "question",
                draft,
                parseSource: resolution.parseSource,
                message: `We couldn't tell which item to replace from "${text.slice(0, 200)}", so we left a question on the draft instead — nothing was changed.`,
            };
        }
        const target = targetMatch.item;
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
