import {
    bestInventoryMatch,
    compatibleInventoryUnits,
    normalizeInventoryName,
} from "./matching.js";
import {
    getPantry,
    type InventoryScope,
    type PantryItem,
} from "./repository.js";

/**
 * "Already have it" — presence matching between the grocery list and
 * the Pantry (owner redesign, Nov 11): the badge fires when a list
 * item is listed in the Pantry AT ALL. Granular stock tracking is a
 * fiction that causes log fatigue — nobody logs ranch dressing by
 * the ounce and household use is invisible — so this module carries
 * NO quantities, NO tiers, and NO coverage judgement. The match is a
 * fact ("this is in your pantry"), never a verdict about whether the
 * user needs to buy more; the add-time "did you run out?" prompt is
 * where the user resolves the ambiguity, not the badge.
 *
 * Matching itself reuses `bestInventoryMatch` — the same pantry
 * matcher the recipe-availability / shortfall logic uses — run in
 * the reverse direction (list item → pantry). It skips depleted
 * items, which is the presence semantic the Pantry page itself
 * shows: a depleted item no longer reads as "in your pantry".
 */
export interface GroceryPantryMatch {
    pantry_item_id: string;
    pantry_name: string;
}

export function pantryMatchForGroceryItem(
    item: { name: string },
    pantryItems: PantryItem[],
): GroceryPantryMatch | null {
    const match = bestInventoryMatch(pantryItems, { name: item.name });
    if (!match) return null;
    return {
        pantry_item_id: match.item.id,
        pantry_name: match.item.name,
    };
}

export function attachPantryMatches<T extends { name: string }>(
    items: readonly T[],
    pantryItems: PantryItem[],
): Array<T & { pantry_match: GroceryPantryMatch | null }> {
    return items.map((item) => ({
        ...item,
        pantry_match: pantryMatchForGroceryItem(item, pantryItems),
    }));
}

/**
 * The three-state presence flag (owner ruling, Nov 13): every surface
 * that lists an item for an add decision says, in the same pill,
 * whether the user already has it, does not have it, or already has
 * it coming. Like the badge it extends, the flag is presence ONLY —
 * it never carries an amount and never claims the pantry holds
 * "enough" of anything; sufficiency stays with the surfaces that do
 * quantity math (the shortfall rundown's rows), never with the flag.
 *
 * Precedence at add moments: "listed" outranks "have" — an item that
 * is both in the pantry and on the open list is flagged `listed`,
 * because that is the fact that decides the tap (an add leaves it
 * alone). The pantry identity still rides along so surfaces that
 * render the list itself can keep showing the pantry fact.
 */
export type PantryFlagState = "have" | "none" | "listed";

export interface PantryFlag {
    state: PantryFlagState;
    pantry_item_id: string | null;
    pantry_name: string | null;
}

export interface OpenGroceryItemLike {
    name: string;
    unit?: string | null;
}

/**
 * Presence on the scope's open (unpurchased, undeleted) grocery
 * list. Identity is the normalized name plus unit compatibility —
 * the same name-and-unit key the grocery merge path folds on, so
 * the flag predicts exactly what an add would have merged into.
 */
export function isOnGroceryList(
    item: { name: string; unit?: string | null },
    openItems: readonly OpenGroceryItemLike[],
): boolean {
    const wanted = normalizeInventoryName(item.name);
    if (!wanted) return false;
    return openItems.some(
        (entry) =>
            normalizeInventoryName(entry.name) === wanted &&
            compatibleInventoryUnits(entry.unit, item.unit),
    );
}

export function pantryFlagForItem(
    item: { name: string; unit?: string | null },
    pantryItems: PantryItem[],
    openItems: readonly OpenGroceryItemLike[] = [],
): PantryFlag {
    const match = pantryMatchForGroceryItem(item, pantryItems);
    if (isOnGroceryList(item, openItems)) {
        return {
            state: "listed",
            pantry_item_id: match?.pantry_item_id ?? null,
            pantry_name: match?.pantry_name ?? null,
        };
    }
    if (match) {
        return {
            state: "have",
            pantry_item_id: match.pantry_item_id,
            pantry_name: match.pantry_name,
        };
    }
    return { state: "none", pantry_item_id: null, pantry_name: null };
}

export function attachPantryFlags<
    T extends { name: string; unit?: string | null },
>(
    items: readonly T[],
    pantryItems: PantryItem[],
    openItems: readonly OpenGroceryItemLike[] = [],
): Array<T & { pantry_flag: PantryFlag }> {
    return items.map((item) => ({
        ...item,
        pantry_flag: pantryFlagForItem(item, pantryItems, openItems),
    }));
}

/**
 * Load the scope's Pantry and attach presence matches. The Pantry
 * module flag is the single gate: `getPantry` returns
 * `enabled: false` with no items when the module is off in Settings,
 * and every item then carries `pantry_match: null` — no badges.
 * The same load also attaches the two-state list-surface flag
 * (`pantry_flag`: have / none; null when the module is off, which is
 * how the client tells "no flag at all" from "explicitly not in the
 * pantry"). List rows are on the list by definition, so the listed
 * state never appears here — add-moment surfaces use
 * `attachPantryFlagsForScope` with the open list instead.
 */
export async function attachPantryMatchesForScope<
    T extends { name: string },
>(input: {
    userId: string;
    scope: InventoryScope;
    items: readonly T[];
}): Promise<
    Array<
        T & {
            pantry_match: GroceryPantryMatch | null;
            pantry_flag: PantryFlag | null;
        }
    >
> {
    if (input.items.length === 0) return [];
    const pantry = await getPantry({
        userId: input.userId,
        scope: input.scope,
        limit: 200,
    });
    if (!pantry.enabled) {
        return input.items.map((item) => ({
            ...item,
            pantry_match: null,
            pantry_flag: null,
        }));
    }
    return attachPantryMatches(input.items, pantry.items).map((item) => ({
        ...item,
        pantry_flag: pantryFlagForItem(
            item as { name: string; unit?: string | null },
            pantry.items,
        ),
    }));
}

/**
 * Attach the full three-state flag for add-moment surfaces (recipe
 * ingredients, plan shortfall, guided-plan preview): each item is
 * checked against the Pantry AND the scope's open grocery list, so
 * the flag rendered before the tap is computed from exactly the
 * snapshot the add itself consults. The Pantry module flag gates it
 * the same way: module off → `pantry_flag: null` on every item and
 * callers must render (and skip) nothing.
 */
export async function attachPantryFlagsForScope<
    T extends { name: string; unit?: string | null },
>(input: {
    userId: string;
    scope: InventoryScope;
    items: readonly T[];
    openItems: readonly OpenGroceryItemLike[];
}): Promise<Array<T & { pantry_flag: PantryFlag | null }>> {
    if (input.items.length === 0) return [];
    const pantry = await getPantry({
        userId: input.userId,
        scope: input.scope,
        limit: 200,
    });
    if (!pantry.enabled) {
        return input.items.map((item) => ({ ...item, pantry_flag: null }));
    }
    return attachPantryFlags(input.items, pantry.items, input.openItems);
}
