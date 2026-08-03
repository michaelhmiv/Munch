import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
    LEGACY_TABLES,
    MIGRATION_FORMAT_VERSION,
    readJsonLines,
    readManifest,
    writeJsonLines,
    writeManifest,
} from "./common.js";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
    const directory = path.join(
        process.cwd(),
        ".tmp",
        `migration-common-${crypto.randomUUID()}`,
    );
    await mkdir(directory, { recursive: true });
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) =>
            rm(directory, { recursive: true, force: true }),
        ),
    );
});

describe("migration manifests", () => {
    test("round-trips canonical JSONL and a checksummed manifest", async () => {
        const directory = await tempDirectory();
        const files = {} as Record<
            (typeof LEGACY_TABLES)[number],
            Awaited<ReturnType<typeof writeJsonLines>>
        >;
        for (const table of LEGACY_TABLES) {
            files[table] = await writeJsonLines(directory, table, [
                { z: 1, a: table },
            ]);
        }
        const manifest = await writeManifest(directory, {
            formatVersion: MIGRATION_FORMAT_VERSION,
            sourceSystem: "synthetic-test",
            exportedAt: "2026-08-03T18:00:00.000Z",
            files,
        });
        expect((await readManifest(directory)).manifestChecksum).toBe(
            manifest.manifestChecksum,
        );
        expect(
            await readJsonLines<Record<string, unknown>>(
                directory,
                manifest.files.meals,
            ),
        ).toEqual([{ a: "meals", z: 1 }]);
    });

    test("rejects a modified data file", async () => {
        const directory = await tempDirectory();
        const files = {} as Record<
            (typeof LEGACY_TABLES)[number],
            Awaited<ReturnType<typeof writeJsonLines>>
        >;
        for (const table of LEGACY_TABLES) {
            files[table] = await writeJsonLines(directory, table, []);
        }
        const manifest = await writeManifest(directory, {
            formatVersion: MIGRATION_FORMAT_VERSION,
            sourceSystem: "synthetic-test",
            exportedAt: "2026-08-03T18:00:00.000Z",
            files,
        });
        await Bun.write(
            path.join(directory, manifest.files.meals.file),
            '{"tampered":true}\n',
        );
        await expect(
            readJsonLines(directory, manifest.files.meals),
        ).rejects.toThrow(/Checksum mismatch/);
    });

    test("rejects a modified manifest", async () => {
        const directory = await tempDirectory();
        const files = {} as Record<
            (typeof LEGACY_TABLES)[number],
            Awaited<ReturnType<typeof writeJsonLines>>
        >;
        for (const table of LEGACY_TABLES) {
            files[table] = await writeJsonLines(directory, table, []);
        }
        const manifest = await writeManifest(directory, {
            formatVersion: MIGRATION_FORMAT_VERSION,
            sourceSystem: "synthetic-test",
            exportedAt: "2026-08-03T18:00:00.000Z",
            files,
        });
        await Bun.write(
            path.join(directory, "manifest.json"),
            JSON.stringify({ ...manifest, exportedAt: "2026-08-04T00:00:00Z" }),
        );
        await expect(readManifest(directory)).rejects.toThrow(
            /manifest checksum mismatch/i,
        );
    });
});
