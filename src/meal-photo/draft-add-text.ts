import { normalizePortionUnit } from "../food-providers/portions.js";

/**
 * Shared parsed-item shape and portion-normalization utilities for
 * photo meal-draft notes ("Anything else to add?").
 *
 * MODEL-FIRST ARCHITECTURE (2026-11-22 revision):
 * Language interpretation belongs solely to Ember (draft-add-parse.ts).
 * This module contains NO intent routing, NO correction-phrasing
 * regexes, and NO text-to-action parsing. It provides only:
 * - `ParsedDraftAddItem`, the normalized item shape fed to grounding;
 * - `defaultPortionFor`, the stated default-portion table used when
 *   an addition carries no stated quantity (always surfaced as an
 *   explicit assumption, never silent);
 * - `normalizeExtractedUnit`, a unit-normalization helper for units
 *   extracted by the model.
 */

export interface ParsedDraftAddItem {
    name: string;
    quantity: number;
    unit: string;
    /** 0.95 when the user stated the quantity; 0.85 when the quantity
     * came from a stated assumption (vague phrase or default portion).
     * Both clear the grounding low-portion-confidence question band —
     * the assumption is SHOWN on the item instead of questioned. */
    portionConfidence: number;
    /** Quantity assumptions the user must see, e.g.
     * `"a good bit" interpreted as 1 tbsp`. */
    assumptions: string[];
    quantityAssumed: boolean;
    /** True when the model extracted an explicit quantity/unit or a
     * vague-quantity interpretation; false for a quantity-less food
     * name using a defaulted portion. Weak parses are held to a
     * stricter grounding bar by draft-add.ts, and on replacements
     * inherit the replaced item's established portion. */
    strongSignal: boolean;
    /** True when no explicit unit was extracted (e.g. a bare count like
     * "just one bratwurst" or a quantity-less item) so a replacement
     * can preserve the replaced item's count unit instead of
     * downgrading to "serving". */
    unitAssumed?: boolean;
}

/**
 * Default portions for quantity-less adds of common add-in foods.
 * First match wins; the generic fallback is 1 serving. Every use is
 * surfaced as an assumption on the item — never silent.
 */
const DEFAULT_PORTIONS: Array<{
    match: RegExp;
    quantity: number;
    unit: string;
}> = [
    {
        match: /\b(salt|pepper|seasoning|spice|spices|herbs?)\b/i,
        quantity: 1,
        unit: "tsp",
    },
    { match: /\b(butter|margarine|ghee)\b/i, quantity: 1, unit: "tbsp" },
    { match: /\b(oil|olive oil)\b/i, quantity: 1, unit: "tbsp" },
    {
        match: /\b(honey|syrup|jam|jelly|ketchup)\b/i,
        quantity: 1,
        unit: "tbsp",
    },
    { match: /\b(sugar)\b/i, quantity: 1, unit: "tbsp" },
    {
        match: /\b(mayo|mayonnaise|sauce|dressing|gravy|salsa|mustard)\b/i,
        quantity: 2,
        unit: "tbsp",
    },
    { match: /\b(milk|cream)\b/i, quantity: 0.25, unit: "cup" },
    { match: /\b(cheese)\b/i, quantity: 1, unit: "oz" },
];

export function defaultPortionFor(name: string): {
    quantity: number;
    unit: string;
} {
    // A compound dish ("mac and cheese") is a serving, not an add-in,
    // even when an ingredient word matches the table below.
    if (/\s+and\s+/i.test(name)) return { quantity: 1, unit: "serving" };
    for (const entry of DEFAULT_PORTIONS) {
        if (entry.match.test(name)) {
            return { quantity: entry.quantity, unit: entry.unit };
        }
    }
    return { quantity: 1, unit: "serving" };
}

/** Normalize a unit string extracted by the model ("tablespoons" → "tbsp"). */
export function normalizeExtractedUnit(unit: string | null): string | null {
    const trimmed = unit?.trim();
    if (!trimmed) return null;
    return normalizePortionUnit(trimmed).slice(0, 80);
}
