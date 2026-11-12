// Today calendar range selection (cohesion program, slice 2):
// hotel-style date picking as a pure state machine, unit-tested in
// range-selection.test.ts and driven by app.js's calendar. Picking
// is an explicit mode inside the calendar sheet ("Select a range")
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
