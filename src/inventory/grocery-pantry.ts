import { bestInventoryMatch } from "./matching.js";
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
 * Load the scope's Pantry and attach presence matches. The Pantry
 * module flag is the single gate: `getPantry` returns
 * `enabled: false` with no items when the module is off in Settings,
 * and every item then carries `pantry_match: null` — no badges.
 */
export async function attachPantryMatchesForScope<
    T extends { name: string },
>(input: {
    userId: string;
    scope: InventoryScope;
    items: readonly T[];
}): Promise<Array<T & { pantry_match: GroceryPantryMatch | null }>> {
    if (input.items.length === 0) return [];
    const pantry = await getPantry({
        userId: input.userId,
        scope: input.scope,
        limit: 200,
    });
    if (!pantry.enabled) {
        return input.items.map((item) => ({ ...item, pantry_match: null }));
    }
    return attachPantryMatches(input.items, pantry.items);
}
