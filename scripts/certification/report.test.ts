import { describe, expect, test } from "bun:test";
import { percentile, summarizeDurations } from "./report.js";

describe("production certification reporting", () => {
    test("computes nearest-rank percentiles", () => {
        expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
        expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
        expect(percentile([], 0.95)).toBe(0);
    });

    test("does not mix skipped checks into latency summaries", () => {
        expect(
            summarizeDurations([
                { name: "one", ok: true, duration_ms: 10 },
                { name: "two", ok: true, duration_ms: 20 },
                {
                    name: "optional",
                    ok: true,
                    duration_ms: 5_000,
                    skipped: true,
                },
            ]),
        ).toEqual({
            count: 2,
            p50_ms: 10,
            p95_ms: 20,
            p99_ms: 20,
            max_ms: 20,
        });
    });
});
