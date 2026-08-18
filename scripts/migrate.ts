#!/usr/bin/env bun

import { SQL } from "bun";
import { createHash } from "node:crypto";
import path from "node:path";

const BASELINE_GENERATION = "2026-08-18";
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
    throw new Error(
        "DATABASE_URL is required. On Railway, reference the PostgreSQL service's DATABASE_URL variable.",
    );
}

const database = new SQL({
    url: databaseUrl,
    max: 1,
    idleTimeout: 20,
    connectionTimeout: 10,
});

function checksum(source: string): string {
    return createHash("sha256").update(source).digest("hex");
}

async function sqlFiles(directory: string): Promise<string[]> {
    try {
        return (
            await Array.fromAsync(
                new Bun.Glob("*.sql").scan({
                    cwd: directory,
                    absolute: false,
                }),
            )
        ).sort();
    } catch {
        return [];
    }
}

async function tableExists(qualifiedName: string): Promise<boolean> {
    const rows = await database<Array<{ present: boolean }>>`
        select to_regclass(${qualifiedName}) is not null as present
    `;
    return rows[0]?.present === true;
}

async function installStateTables(tx: SQL): Promise<void> {
    await tx.unsafe(`
        create table if not exists munch.schema_state (
            singleton boolean primary key default true check (singleton),
            generation text not null,
            installed_at timestamptz not null default now()
        );
        create table if not exists munch.schema_updates (
            version text primary key,
            file_name text not null unique,
            checksum_sha256 text not null,
            applied_at timestamptz not null default now()
        );
    `);
    await tx`
        insert into munch.schema_state (singleton, generation)
        values (true, ${BASELINE_GENERATION})
        on conflict (singleton) do update
        set generation = excluded.generation,
            installed_at = now()
    `;
}

const hasUsers = await tableExists("munch.users");
const hasSchemaState = await tableExists("munch.schema_state");

if (!hasUsers) {
    const schemaDirectory = path.resolve("db/schema");
    const files = await sqlFiles(schemaDirectory);
    if (files.length === 0) {
        throw new Error(`No canonical schema modules found in ${schemaDirectory}`);
    }

    console.log(`install canonical Munch schema ${BASELINE_GENERATION}`);
    await database.begin(async (tx) => {
        for (const fileName of files) {
            console.log(`  schema ${fileName}`);
            await tx.unsafe(
                await Bun.file(path.join(schemaDirectory, fileName)).text(),
            );
        }
        await installStateTables(tx);
    });
} else if (!hasSchemaState) {
    const bridgePath = path.resolve(
        "db/legacy-bridge/retire-prebaseline-auth.sql",
    );
    if (!(await Bun.file(bridgePath).exists())) {
        throw new Error(
            "Database predates the canonical baseline but the retirement bridge is unavailable",
        );
    }

    console.log(
        `rebaseline existing Munch database to ${BASELINE_GENERATION} (business rows preserved)`,
    );
    await database.begin(async (tx) => {
        await tx.unsafe(await Bun.file(bridgePath).text());
        await installStateTables(tx);
    });
} else {
    const state = await database<Array<{ generation: string }>>`
        select generation from munch.schema_state where singleton = true
    `;
    if (state[0]?.generation !== BASELINE_GENERATION) {
        throw new Error(
            `Unsupported Munch schema generation ${state[0]?.generation ?? "missing"}; expected ${BASELINE_GENERATION}`,
        );
    }
    console.log(`canonical Munch schema ${BASELINE_GENERATION} already installed`);
}

const updatesDirectory = path.resolve("db/updates");
const updateFiles = await sqlFiles(updatesDirectory);
for (const fileName of updateFiles) {
    const match = fileName.match(/^(\d{4,})_[a-z0-9_-]+\.sql$/i);
    if (!match?.[1]) {
        throw new Error(
            `Invalid update filename ${fileName}; expected NNNN_description.sql`,
        );
    }
    const version = match[1];
    const source = await Bun.file(path.join(updatesDirectory, fileName)).text();
    const sourceChecksum = checksum(source);
    const existing = await database<
        Array<{ checksum_sha256: string; file_name: string }>
    >`
        select checksum_sha256, file_name
        from munch.schema_updates
        where version = ${version}
    `;
    const applied = existing[0];
    if (applied) {
        if (
            applied.checksum_sha256 !== sourceChecksum ||
            applied.file_name !== fileName
        ) {
            throw new Error(
                `Schema update ${version} was modified after application. ` +
                    `Database has ${applied.file_name}/${applied.checksum_sha256}; ` +
                    `repository has ${fileName}/${sourceChecksum}.`,
            );
        }
        console.log(`skip update ${fileName} (already applied)`);
        continue;
    }

    console.log(`apply update ${fileName}`);
    await database.begin(async (tx) => {
        await tx.unsafe(source);
        await tx`
            insert into munch.schema_updates (
                version,
                file_name,
                checksum_sha256
            ) values (
                ${version},
                ${fileName},
                ${sourceChecksum}
            )
        `;
    });
}

await database.close();
console.log("Database schema is current.");
