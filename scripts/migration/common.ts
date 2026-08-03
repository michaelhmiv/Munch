import { createHash } from "node:crypto";
import path from "node:path";

export const MIGRATION_FORMAT_VERSION = 1;

export const LEGACY_TABLES = [
    "users",
    "profiles",
    "nutrition_goals",
    "meals",
    "water_log",
    "weight_log",
] as const;

export type LegacyTableName = (typeof LEGACY_TABLES)[number];

export interface MigrationFileManifest {
    file: string;
    rows: number;
    sha256: string;
}

export interface MigrationManifest {
    formatVersion: number;
    sourceSystem: "nutrition-mcp-supabase" | "synthetic-test";
    exportedAt: string;
    files: Record<LegacyTableName, MigrationFileManifest>;
    manifestChecksum: string;
}

export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
        .join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

export async function writeJsonLines(
    directory: string,
    table: LegacyTableName,
    rows: unknown[],
): Promise<MigrationFileManifest> {
    await Bun.write(path.join(directory, ".keep"), "");
    const content = rows.map((row) => canonicalJson(row)).join("\n") +
        (rows.length > 0 ? "\n" : "");
    const file = `${table}.jsonl`;
    await Bun.write(path.join(directory, file), content);
    return {
        file,
        rows: rows.length,
        sha256: sha256(content),
    };
}

export async function readJsonLines<T>(
    directory: string,
    file: MigrationFileManifest,
): Promise<T[]> {
    const content = await Bun.file(path.join(directory, file.file)).text();
    if (sha256(content) !== file.sha256) {
        throw new Error(`Checksum mismatch for ${file.file}`);
    }
    const rows = content
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as T);
    if (rows.length !== file.rows) {
        throw new Error(
            `Row count mismatch for ${file.file}: expected ${file.rows}, found ${rows.length}`,
        );
    }
    return rows;
}

export function manifestChecksum(
    manifest: Omit<MigrationManifest, "manifestChecksum">,
): string {
    return sha256(canonicalJson(manifest));
}

export async function writeManifest(
    directory: string,
    manifest: Omit<MigrationManifest, "manifestChecksum">,
): Promise<MigrationManifest> {
    const complete: MigrationManifest = {
        ...manifest,
        manifestChecksum: manifestChecksum(manifest),
    };
    await Bun.write(
        path.join(directory, "manifest.json"),
        `${JSON.stringify(complete, null, 2)}\n`,
    );
    return complete;
}

export async function readManifest(
    directory: string,
): Promise<MigrationManifest> {
    const manifest = (await Bun.file(
        path.join(directory, "manifest.json"),
    ).json()) as MigrationManifest;
    if (manifest.formatVersion !== MIGRATION_FORMAT_VERSION) {
        throw new Error(
            `Unsupported migration format ${manifest.formatVersion}`,
        );
    }
    const { manifestChecksum: checksum, ...unsigned } = manifest;
    if (manifestChecksum(unsigned) !== checksum) {
        throw new Error("Migration manifest checksum mismatch");
    }
    for (const table of LEGACY_TABLES) {
        if (!manifest.files[table]) {
            throw new Error(`Migration manifest is missing ${table}`);
        }
    }
    return manifest;
}

export function requiredArgument(name: string): string {
    const prefix = `--${name}=`;
    const value = process.argv.find((argument) => argument.startsWith(prefix));
    if (!value) throw new Error(`Missing required argument ${prefix}<value>`);
    return value.slice(prefix.length);
}

export function hasFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}
