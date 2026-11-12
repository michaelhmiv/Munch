// Today calendar range selection (cohesion program, slice 2):
// hotel-style date picking as a pure state machine, unit-tested in
// range-selection.test.ts and driven by app.js's calendar. Picking
// is an explicit mode inside the calendar sheet (the header Range toggle)
// so a plain day tap keeps its established meaning — land on that
// day (the contract the navigation suites pin).
//
// State: { anchor, range } — anchor is a first tap waiting for its
// second; range is a completed { start, end } (start === end never
// occurs: a same-day second tap resolves to a single day instead).

export function emptyRangeSelection() {
    return { anchor: null, range: null };
}

/**
 * Apply one calendar tap. Returns { selection, outcome } where
 * outcome is:
 * - "anchor"  — first tap placed the range start; calendar stays open
 * - "restart" — tap landed before the anchor; the anchor moved to it
 * - "range"   — second tap completed a multi-day range
 * - "single"  — second tap on the anchor day: a single day, no range
 */
export function applyRangeTap(selection, date) {
    const current = selection || emptyRangeSelection();
    if (!current.anchor) {
        return {
            selection: { anchor: date, range: null },
            outcome: "anchor",
        };
    }
    if (date === current.anchor) {
        return { selection: emptyRangeSelection(), outcome: "single" };
    }
    if (date < current.anchor) {
        return {
            selection: { anchor: date, range: null },
            outcome: "restart",
        };
    }
    return {
        selection: {
            anchor: null,
            range: { start: current.anchor, end: date },
        },
        outcome: "range",
    };
}

/** How a date cell reads against the selection: start/end/in/anchor. */
export function rangeCellState(selection, date) {
    if (!selection) return null;
    if (selection.range) {
        if (date === selection.range.start) return "start";
        if (date === selection.range.end) return "end";
        if (date > selection.range.start && date < selection.range.end)
            return "in";
        return null;
    }
    if (selection.anchor && date === selection.anchor) return "anchor";
    return null;
}

/**
 * Signed per-day delta text for the range tiles (approved rendering,
 * Nov 11): "+4" over the daily target, "−77" under it (U+2212 minus,
 * as the rendering draws it), "0" exactly on it. Null without a
 * target — a nutrient with no goal shows its plain average instead.
 */
export function signedDeltaText(delta, digits = 0) {
    if (delta == null || Number.isNaN(Number(delta))) return null;
    const format = new Intl.NumberFormat("en-US", {
        maximumFractionDigits: digits,
    });
    const value = Number(delta);
    if (value > 0) return `+${format.format(value)}`;
    if (value < 0) return `−${format.format(Math.abs(value))}`;
    return "0";
}

/**
 * The tile/micro average line, exactly as the approved rendering
 * labels it: with a target, "avg 144 g · +4/day" (average, then the
 * signed delta against the daily target); without one, the plain
 * average, "avg 63 g/day". `unit` carries its leading space
 * (" g", " kcal", " mg").
 *
 * Averages divide by LOGGED days, not calendar days (the range
 * contract), so when some days in the span are unlogged the two
 * denominators differ and the line must disclose its basis in the
 * tile itself: callers pass `basis` ("per logged day", or "per
 * planned day" for planned-only tiles) whenever the averaging
 * denominator is smaller than the calendar span, and the line
 * appends it — "avg 533 kcal · −1,467/day · per logged day".
 * Fully logged spans keep the undisclosed form: there logged days
 * ARE the calendar days, so the basis is identical either way
 * (QC-gate F2 choice, PR #277).
 */
export function rangeAverageLine(
    dailyAverage,
    averageDelta,
    unit,
    digits = 0,
    basis = null,
) {
    const format = new Intl.NumberFormat("en-US", {
        maximumFractionDigits: digits,
    });
    const average = format.format(Number(dailyAverage) || 0);
    const delta = signedDeltaText(averageDelta, digits);
    if (delta == null) {
        // No target: undisclosed, the plain "avg 63 g/day"; with a
        // basis to disclose, the basis carries the per-day meaning
        // ("avg 63 g · per logged day", not "…/day · per logged day").
        return basis
            ? `avg ${average}${unit} · ${basis}`
            : `avg ${average}${unit}/day`;
    }
    const line = `avg ${average}${unit} · ${delta}/day`;
    return basis ? `${line} · ${basis}` : line;
}

/**
 * The average-basis disclosure for a range aggregate: averages are
 * per logged day, so a span with unlogged days discloses that in
 * every tile; a fully logged span needs no disclosure (logged days
 * = calendar days). Planned-only tiles average per planned day and
 * disclose on the same rule.
 */
export function rangeAverageBasis(aggregate, plannedOnly = false) {
    if (plannedOnly) {
        return aggregate.plannedDays < aggregate.days
            ? "per planned day"
            : null;
    }
    return aggregate.daysWithMeals < aggregate.days ? "per logged day" : null;
}

/** Inclusive list of YYYY-MM-DD dates from start through end. */
export function eachDateInRange(start, end) {
    const dates = [];
    let current = start;
    while (current <= end) {
        dates.push(current);
        const value = new Date(`${current}T12:00:00Z`);
        value.setUTCDate(value.getUTCDate() + 1);
        current = value.toISOString().slice(0, 10);
    }
    return dates;
}
