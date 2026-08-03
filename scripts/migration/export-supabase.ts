#!/usr/bin/env bun

import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
    LEGACY_TABLES,
    MIGRATION_FORMAT_VERSION,
    hasFlag,
    requiredArgument,
    writeJsonLines,
    writeManifest,
    type LegacyTableName,
} from "./common.js";

const outputDirectory = path.resolve(requiredArgument("output"));
const overwrite = hasFlag("overwrite");
const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SECRET_KEY?.trim();
if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
}

if (await Bun.file(path.join(outputDirectory, "manifest.json")).exists()) {
    if (!overwrite) {
        throw new Error(
            "Output already contains a manifest; pass --overwrite to replace it",
        );
    }
    await rm(outputDirectory, { recursive: true, force: true });
}
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);

const supabase = createClient(url, key, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
    },
});

async function exportUsers(): Promise<unknown[]> {
    const rows: unknown[] = [];
    const perPage = 1_000;
    for (let page = 1; ; page += 1) {
        const { data, error } = await supabase.auth.admin.listUsers({
            page,
            perPage,
        });
        if (error) throw new Error(`Unable to export auth users: ${error.message}`);
        for (const user of data.users) {
            if (!user.email) {
                throw new Error(`Supabase user ${user.id} has no email`);
            }
            rows.push({
                id: user.id,
                email: user.email.trim().toLowerCase(),
                email_confirmed_at: user.email_confirmed_at ?? null,
                created_at: user.created_at,
                updated_at: user.updated_at ?? null,
            });
        }
        if (data.users.length < perPage) break;
    }
    return rows;
}

async function exportTable(table: Exclude<LegacyTableName, "users">) {
    const rows: unknown[] = [];
    const pageSize = 1_000;
    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase
            .from(table)
            .select("*")
            .range(offset, offset + pageSize - 1);
        if (error) throw new Error(`Unable to export ${table}: ${error.message}`);
        rows.push(...(data ?? []));
        if ((data?.length ?? 0) < pageSize) break;
    }
    return rows;
}

const files = {} as Record<LegacyTableName, Awaited<ReturnType<typeof writeJsonLines>>>;
for (const table of LEGACY_TABLES) {
    const rows =
        table === "users"
            ? await exportUsers()
            : await exportTable(table as Exclude<LegacyTableName, "users">);
    files[table] = await writeJsonLines(outputDirectory, table, rows);
    await chmod(path.join(outputDirectory, files[table].file), 0o600);
}

const manifest = await writeManifest(outputDirectory, {
    formatVersion: MIGRATION_FORMAT_VERSION,
    sourceSystem: "nutrition-mcp-supabase",
    exportedAt: new Date().toISOString(),
    files,
});
await chmod(path.join(outputDirectory, "manifest.json"), 0o600);
await rm(path.join(outputDirectory, ".keep"), { force: true });

console.log(
    JSON.stringify({
        export: "complete",
        outputDirectory,
        manifestChecksum: manifest.manifestChecksum,
        rows: Object.fromEntries(
            LEGACY_TABLES.map((table) => [table, manifest.files[table].rows]),
        ),
    }),
);
