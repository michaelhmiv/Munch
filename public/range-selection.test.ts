import { describe, expect, test } from "bun:test";
import {
    applyRangeTap,
    eachDateInRange,
    emptyRangeSelection,
    rangeCellState,
} from "./range-selection.js";

describe("applyRangeTap — the hotel-style selection state machine", () => {
    test("first tap anchors; a later second tap completes the range", () => {
        const first = applyRangeTap(emptyRangeSelection(), "2026-11-09");
        expect(first.outcome).toBe("anchor");
        expect(first.selection).toEqual({
            anchor: "2026-11-09",
            range: null,
        });
        const second = applyRangeTap(first.selection, "2026-11-13");
        expect(second.outcome).toBe("range");
        expect(second.selection).toEqual({
            anchor: null,
            range: { start: "2026-11-09", end: "2026-11-13" },
        });
    });

    test("tapping the anchor day again resolves to a single day", () => {
        const first = applyRangeTap(emptyRangeSelection(), "2026-11-09");
        const second = applyRangeTap(first.selection, "2026-11-09");
        expect(second.outcome).toBe("single");
        expect(second.selection).toEqual({ anchor: null, range: null });
    });

    test("tapping an earlier day restarts the range start", () => {
        const first = applyRangeTap(emptyRangeSelection(), "2026-11-13");
        const earlier = applyRangeTap(first.selection, "2026-11-09");
        expect(earlier.outcome).toBe("restart");
        expect(earlier.selection).toEqual({
            anchor: "2026-11-09",
            range: null,
        });
        // And the restarted anchor can still complete a range.
        const done = applyRangeTap(earlier.selection, "2026-11-13");
        expect(done.outcome).toBe("range");
        expect(done.selection.range).toEqual({
            start: "2026-11-09",
            end: "2026-11-13",
        });
    });

    test("a tap with a completed range starts a fresh anchor", () => {
        const ranged = {
            anchor: null,
            range: { start: "2026-11-09", end: "2026-11-13" },
        };
        const next = applyRangeTap(ranged, "2026-11-20");
        expect(next.outcome).toBe("anchor");
        expect(next.selection).toEqual({
            anchor: "2026-11-20",
            range: null,
        });
    });
});

describe("rangeCellState", () => {
    const ranged = {
        anchor: null,
        range: { start: "2026-11-09", end: "2026-11-13" },
    };
    test("marks start, end, and the span between", () => {
        expect(rangeCellState(ranged, "2026-11-09")).toBe("start");
        expect(rangeCellState(ranged, "2026-11-13")).toBe("end");
        expect(rangeCellState(ranged, "2026-11-11")).toBe("in");
        expect(rangeCellState(ranged, "2026-11-14")).toBeNull();
        expect(rangeCellState(ranged, "2026-11-08")).toBeNull();
    });
    test("marks a lone anchor", () => {
        expect(
            rangeCellState({ anchor: "2026-11-09", range: null }, "2026-11-09"),
        ).toBe("anchor");
    });
});

describe("eachDateInRange", () => {
    test("lists every day inclusively across a month boundary", () => {
        expect(eachDateInRange("2026-11-29", "2026-12-02")).toEqual([
            "2026-11-29",
            "2026-11-30",
            "2026-12-01",
            "2026-12-02",
        ]);
        expect(eachDateInRange("2026-11-09", "2026-11-09")).toEqual([
            "2026-11-09",
        ]);
    });
});
