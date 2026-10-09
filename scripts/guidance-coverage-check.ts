#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface LcovFileCoverage {
    file: string;
    hitLines: number;
    totalLines: number;
}

export function parseGuidanceCoverage(lcov: string): LcovFileCoverage[] {
    const result: LcovFileCoverage[] = [];
    let current: Partial<LcovFileCoverage> = {};

    for (const line of lcov.split(/\r?\n/)) {
        if (line === "end_of_record") {
            if (
                current.file &&
                current.hitLines !== undefined &&
                current.totalLines !== undefined &&
                /(?:^|\/)src\/guidance\//.test(current.file)
            ) {
                result.push(current as LcovFileCoverage);
            }
            current = {};
            continue;
        }

        if (line.startsWith("SF:")) current.file = line.slice(3);
        if (line.startsWith("LH:")) current.hitLines = Number(line.slice(3));
        if (line.startsWith("LF:")) current.totalLines = Number(line.slice(3));
    }

    return result;
}

export function guidanceCoverageFailures(
    files: LcovFileCoverage[],
    minimumPercent = 80,
): LcovFileCoverage[] {
    return files.filter(
        ({ hitLines, totalLines }) =>
            totalLines <= 0 || (hitLines / totalLines) * 100 < minimumPercent,
    );
}

function normalizedPath(file: string): string {
    const path = isAbsolute(file) ? relative(process.cwd(), file) : file;
    return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function missingGuidanceCoverageFiles(
    files: LcovFileCoverage[],
    expectedSourceFiles: string[],
): LcovFileCoverage[] {
    const coveredPaths = new Set(files.map(({ file }) => normalizedPath(file)));
    return expectedSourceFiles
        .map(normalizedPath)
        .filter((file) => !coveredPaths.has(file))
        .map((file) => ({ file, hitLines: 0, totalLines: 0 }));
}

async function listGuidanceSourceFiles(
    directory = resolve("src/guidance"),
): Promise<string[]> {
    const result: string[] = [];

    async function visit(path: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(path, { withFileTypes: true });
        } catch (error) {
            if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "ENOENT"
            ) {
                return;
            }
            throw error;
        }

        for (const entry of entries) {
            const child = resolve(path, entry.name);
            if (entry.isDirectory()) {
                await visit(child);
            } else if (
                entry.isFile() &&
                /\.(?:ts|tsx)$/.test(entry.name) &&
                !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
            ) {
                result.push(child);
            }
        }
    }

    await visit(directory);
    return result;
}

async function main(): Promise<void> {
    const lcovPath = process.argv[2] ?? "coverage/lcov.info";
    const coverage = parseGuidanceCoverage(await readFile(lcovPath, "utf8"));
    const sourceFiles = await listGuidanceSourceFiles();
    const measured = [
        ...coverage,
        ...missingGuidanceCoverageFiles(coverage, sourceFiles),
    ];
    if (measured.length === 0) {
        console.log(
            "No src/guidance domain modules are present; the 80% per-file coverage gate will apply when they are added.",
        );
        return;
    }

    const failures = guidanceCoverageFailures(measured);
    for (const file of measured) {
        const percent = (file.hitLines / file.totalLines) * 100;
        console.log(
            percent.toFixed(2) +
                "% " +
                file.file +
                " (" +
                file.hitLines +
                "/" +
                file.totalLines +
                " lines)",
        );
    }
    if (failures.length > 0) {
        throw new Error(
            "Guidance domain files must each meet 80% line coverage: " +
                failures.map(({ file }) => file).join(", "),
        );
    }
}

if (import.meta.main) {
    await main();
}
