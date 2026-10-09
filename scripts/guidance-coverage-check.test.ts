import { describe, expect, test } from "bun:test";
import {
    guidanceCoverageFailures,
    missingGuidanceCoverageFiles,
    parseGuidanceCoverage,
} from "./guidance-coverage-check.js";

describe("guided-nutrition line coverage gate", () => {
    test("reads only source records inside the shared guidance domain", () => {
        const files = parseGuidanceCoverage(
            [
                "SF:/repo/src/guidance/validator.ts",
                "LF:100",
                "LH:85",
                "end_of_record",
                "SF:/repo/src/app/guidance-routes.ts",
                "LF:100",
                "LH:100",
                "end_of_record",
                "SF:/repo/src/guidance/planner.ts",
                "LF:100",
                "LH:79",
                "end_of_record",
                "SF:/repo/src/other.ts",
                "LF:100",
                "LH:0",
                "end_of_record",
            ].join("\n"),
        );

        expect(files).toEqual([
            {
                file: "/repo/src/guidance/validator.ts",
                hitLines: 85,
                totalLines: 100,
            },
            {
                file: "/repo/src/guidance/planner.ts",
                hitLines: 79,
                totalLines: 100,
            },
        ]);
        expect(guidanceCoverageFailures(files).map(({ file }) => file)).toEqual(
            ["/repo/src/guidance/planner.ts"],
        );
    });

    test("includes files with no covered lines and accepts the exact floor", () => {
        const files = [
            { file: "src/guidance/zero.ts", hitLines: 0, totalLines: 20 },
            { file: "src/guidance/floor.ts", hitLines: 16, totalLines: 20 },
        ];

        expect(guidanceCoverageFailures(files).map(({ file }) => file)).toEqual(
            ["src/guidance/zero.ts"],
        );
    });

    test("fails a source module omitted from LCOV because no test imported it", () => {
        const covered = [
            {
                file: "src/guidance/covered.ts",
                hitLines: 16,
                totalLines: 20,
            },
        ];
        const missing = missingGuidanceCoverageFiles(covered, [
            "src/guidance/covered.ts",
            "src/guidance/untested.ts",
        ]);

        expect(missing).toEqual([
            {
                file: "src/guidance/untested.ts",
                hitLines: 0,
                totalLines: 0,
            },
        ]);
        expect(guidanceCoverageFailures([...covered, ...missing])).toEqual(
            missing,
        );
    });
});
