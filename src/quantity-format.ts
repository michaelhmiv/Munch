/**
 * Conventional US recipe quantity formatting — DISPLAY ONLY.
 *
 * Owner ruling (Michael, 2026-11-13): quantities for recipe-style
 * volume measures are shown the way US recipes write them — proper
 * fractions and mixed numbers in plain ASCII ("1/3 cup", "2 1/2",
 * "1 3/4") — across the whole app. This is the server-side twin of
 * the one client formatter (public/quantity-format.js); the two
 * implement the identical algorithm and src/quantity-format.test.ts
 * pins them to the same vectors so they cannot drift. Stored data
 * and all math stay decimal — this only changes what is shown.
 *
 * Scope: volume measures only — cup, tbsp, tsp, fl oz, pint, quart,
 * stick (plus their long/plural spellings). Weights (g, oz, lb, kg),
 * counts and nutrition numbers keep the caller's decimal formatting:
 * formatRecipeQuantity returns null for them.
 *
 * Snapping: the fractional part snaps to the nearest conventional
 * recipe fraction — halves, thirds, quarters, eighths — with a
 * maximum snap distance of 1/16 (half the smallest step). Ties go to
 * the smaller denominator, except that 0 loses every tie and
 * rounding up to the next whole wins its ties. Output is ASCII only.
 */

const RECIPE_VOLUME_UNIT_ALIASES = new Map<string, string>([
    ["cup", "cup"],
    ["cups", "cup"],
    ["tbsp", "tbsp"],
    ["tbs", "tbsp"],
    ["tablespoon", "tbsp"],
    ["tablespoons", "tbsp"],
    ["tsp", "tsp"],
    ["teaspoon", "tsp"],
    ["teaspoons", "tsp"],
    ["fl oz", "fl oz"],
    ["fluid ounce", "fl oz"],
    ["fluid ounces", "fl oz"],
    ["pint", "pint"],
    ["pints", "pint"],
    ["quart", "quart"],
    ["quarts", "quart"],
    ["stick", "stick"],
    ["sticks", "stick"],
]);

/** The canonical recipe volume unit for a stored unit string, or null. */
export function recipeVolumeUnit(unit?: string | null): string | null {
    if (unit == null) return null;
    const normalized = unit.trim().toLowerCase().replace(/\s+/g, " ");
    return RECIPE_VOLUME_UNIT_ALIASES.get(normalized) ?? null;
}

/** True when the unit is a recipe-style volume measure. */
export function isRecipeVolumeUnit(unit?: string | null): boolean {
    return recipeVolumeUnit(unit) != null;
}

// [value, numerator, denominator] — the conventional recipe fractions.
const FRACTION_CANDIDATES: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 1],
    [1 / 8, 1, 8],
    [1 / 4, 1, 4],
    [1 / 3, 1, 3],
    [3 / 8, 3, 8],
    [1 / 2, 1, 2],
    [5 / 8, 5, 8],
    [2 / 3, 2, 3],
    [3 / 4, 3, 4],
    [7 / 8, 7, 8],
    [1, 1, 1],
];

// Half the smallest conventional step (1/8): any fractional part is
// within this distance of a candidate, so snapping is total.
const SNAP_TOLERANCE = 1 / 16;
const EPSILON = 1e-9;

// Tie-break preference: smaller denominator wins, but 0 (a snap-to-
// nothing) loses to any real fraction, and the round-up candidate
// carries denominator 1 so it wins its ties.
function tieKey(numerator: number, denominator: number): number {
    return numerator === 0 ? Number.POSITIVE_INFINITY : denominator;
}

/**
 * Format a decimal quantity as a US recipe fraction when the unit is
 * a recipe volume measure: 0.25 → "1/4", 2.5 → "2 1/2", 1.75 →
 * "1 3/4". Returns null when the unit is not a recipe volume measure
 * or the value is null / non-finite — the caller's signal to use its
 * existing decimal formatting untouched.
 */
export function formatRecipeQuantity(
    value: number | null | undefined,
    unit?: string | null,
): string | null {
    if (!isRecipeVolumeUnit(unit)) return null;
    if (value == null) return null;
    const amount = Number(value);
    if (!Number.isFinite(amount)) return null;

    const sign = amount < 0 ? "-" : "";
    const abs = Math.abs(amount);
    let whole = Math.floor(abs);
    const frac = abs - whole;

    let best: {
        candidate: readonly [number, number, number];
        distance: number;
    } | null = null;
    for (const candidate of FRACTION_CANDIDATES) {
        const distance = Math.abs(frac - candidate[0]);
        if (distance > SNAP_TOLERANCE + EPSILON) continue;
        if (
            best == null ||
            distance < best.distance - EPSILON ||
            (Math.abs(distance - best.distance) <= EPSILON &&
                tieKey(candidate[1], candidate[2]) <
                    tieKey(best.candidate[1], best.candidate[2]))
        ) {
            best = { candidate, distance };
        }
    }
    if (best == null) return null;

    const [, numerator, denominator] = best.candidate;
    if (numerator === 1 && denominator === 1) {
        whole += 1;
        return `${sign}${whole.toLocaleString("en-US")}`;
    }
    if (numerator === 0) {
        return `${sign}${whole.toLocaleString("en-US")}`;
    }
    const fraction = `${numerator}/${denominator}`;
    if (whole === 0) return `${sign}${fraction}`;
    return `${sign}${whole.toLocaleString("en-US")} ${fraction}`;
}
