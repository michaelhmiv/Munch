#!/usr/bin/env bun

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
    closePlatformDatabase,
    getPlatformDatabase,
} from "../../src/platform/database.js";
import {
    LEGACY_TABLES,
    MIGRATION_FORMAT_VERSION,
    writeJsonLines,
    writeManifest,
} from "./common.js";

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for migration smoke tests");
}

const directory = path.join(
    process.cwd(),
    ".tmp",
    `legacy-migration-${crypto.randomUUID()}`,
);
await mkdir(directory, { recursive: true });

const sourceUserId = crypto.randomUUID();
const mealId = crypto.randomUUID();
const waterId = crypto.randomUUID();
const weightId = crypto.randomUUID();
const email = `legacy-${crypto.randomUUID()}@example.test`;
const exportedAt = "2026-08-03T18:30:00.000Z";
const rows = {
    users: [
        {
            id: sourceUserId,
            email,
            email_confirmed_at: "2026-01-01T00:00:00.000Z",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-08-01T00:00:00.000Z",
        },
    ],
    profiles: [
        {
            user_id: sourceUserId,
            timezone: "America/New_York",
            preferred_weight_unit: "lb",
            widgets_enabled: false,
            alcohol_tracking_enabled: true,
            preferred_drink_unit: "us",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-08-01T00:00:00.000Z",
        },
    ],
    nutrition_goals: [
        {
            user_id: sourceUserId,
            daily_calories: 2200,
            daily_protein_g: 160,
            daily_carbs_g: 240,
            daily_fat_g: 70,
            daily_fiber_g: 30,
            daily_sugar_g: 60,
            daily_alcohol_g: 14,
            daily_water_ml: 2800,
            target_weight_g: 86000,
            updated_at: "2026-08-01T00:00:00.000Z",
        },
    ],
    meals: [
        {
            id: mealId,
            user_id: sourceUserId,
            logged_at: "2026-08-02T16:30:00.000Z",
            meal_type: "lunch",
            description: "Legacy chicken bowl",
            calories: 645,
            protein_g: 48.5,
            carbs_g: 72.25,
            fat_g: 18.75,
            fiber_g: 9,
            sugar_g: 6,
            alcohol_g: 0,
            notes: "Synthetic migration fixture",
            idempotency_key: `legacy:${mealId}`,
            created_at: "2026-08-02T16:30:00.000Z",
            updated_at: "2026-08-02T16:31:00.000Z",
        },
    ],
    water_log: [
        {
            id: waterId,
            user_id: sourceUserId,
            amount_ml: 473,
            logged_at: "2026-08-02T17:00:00.000Z",
            notes: "16 oz water",
            idempotency_key: `legacy:${waterId}`,
            created_at: "2026-08-02T17:00:00.000Z",
        },
    ],
    weight_log: [
        {
            id: weightId,
            user_id: sourceUserId,
            weight_g: 90718,
            logged_at: "2026-08-02T11:00:00.000Z",
            notes: "Morning weight",
            idempotency_key: `legacy:${weightId}`,
            created_at: "2026-08-02T11:00:00.000Z",
            updated_at: "2026-08-02T11:00:00.000Z",
        },
    ],
};

const files = {} as Record<
    (typeof LEGACY_TABLES)[number],
    Awaited<ReturnType<typeof writeJsonLines>>
>;
for (const table of LEGACY_TABLES) {
    files[table] = await writeJsonLines(directory, table, rows[table]);
}
const manifest = await writeManifest(directory, {
    formatVersion: MIGRATION_FORMAT_VERSION,
    sourceSystem: "synthetic-test",
    exportedAt,
    files,
});
await rm(path.join(directory, ".keep"), { force: true });

async function runScript(
    script: string,
    arguments_: string[] = [],
): Promise<Record<string, unknown>> {
    const child = Bun.spawn(
        ["bun", script, `--input=${directory}`, ...arguments_],
        {
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(`${script} failed: ${stderr || stdout}`);
    }
    const output = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
    if (!output) throw new Error(`${script} produced no JSON output`);
    return JSON.parse(output) as Record<string, unknown>;
}

try {
    const dryRun = await runScript(
        "scripts/migration/import-railway.ts",
        ["--dry-run"],
    );
    if (
        dryRun.import !== "dry-run-complete" ||
        dryRun.manifestChecksum !== manifest.manifestChecksum
    ) {
        throw new Error("Migration dry-run did not validate the manifest");
    }

    const firstImport = await runScript(
        "scripts/migration/import-railway.ts",
    );
    if (firstImport.import !== "complete") {
        throw new Error("Initial synthetic import did not complete");
    }
    const firstVerification = await runScript(
        "scripts/migration/verify-migration.ts",
    );
    if (firstVerification.verification !== "passed") {
        throw new Error("Initial synthetic migration verification failed");
    }

    const secondImport = await runScript(
        "scripts/migration/import-railway.ts",
    );
    if (secondImport.import !== "complete") {
        throw new Error("Repeated synthetic import did not complete");
    }
    const secondVerification = await runScript(
        "scripts/migration/verify-migration.ts",
    );
    if (secondVerification.verification !== "passed") {
        throw new Error("Repeated synthetic migration verification failed");
    }

    const database = getPlatformDatabase();
    const resultRows = await database<
        Array<{
            user_id: string;
            meal_count: number;
            water_count: number;
            weight_count: number;
            verified_runs: number;
        }>
    >`
        select
            links.user_id,
            (select count(*)::integer from munch.meals where id = ${mealId}) as meal_count,
            (select count(*)::integer from munch.water_logs where id = ${waterId}) as water_count,
            (select count(*)::integer from munch.weight_logs where id = ${weightId}) as weight_count,
            (
                select count(*)::integer
                from munch.legacy_migration_runs
                where source_system = 'synthetic-test'
                  and manifest_checksum = ${manifest.manifestChecksum}
                  and status = 'verified'
            ) as verified_runs
        from munch.legacy_identity_links links
        where links.source_system = 'synthetic-test'
          and links.source_user_id = ${sourceUserId}
    `;
    const result = resultRows[0];
    if (
        !result ||
        result.meal_count !== 1 ||
        result.water_count !== 1 ||
        result.weight_count !== 1 ||
        result.verified_runs !== 2
    ) {
        throw new Error(
            "Repeated import was not idempotent or migration runs were not verified",
        );
    }
    await closePlatformDatabase();
    console.log(
        "Munch synthetic legacy migration, re-import, and verification smoke test passed.",
    );
} finally {
    await closePlatformDatabase();
    await rm(directory, { recursive: true, force: true });
}
