#!/usr/bin/env bun

import path from "node:path";
import { getPlatformDatabase, closePlatformDatabase } from "../../src/platform/database.js";
import {
    LEGACY_TABLES,
    hasFlag,
    readJsonLines,
    readManifest,
    requiredArgument,
} from "./common.js";

interface LegacyUser {
    id: string;
    email: string;
    email_confirmed_at?: string | null;
    created_at?: string;
    updated_at?: string | null;
}

type LegacyRow = Record<string, unknown> & { user_id: string };

const inputDirectory = path.resolve(requiredArgument("input"));
const dryRun = hasFlag("dry-run");
const manifest = await readManifest(inputDirectory);
const data = {
    users: await readJsonLines<LegacyUser>(
        inputDirectory,
        manifest.files.users,
    ),
    profiles: await readJsonLines<LegacyRow>(
        inputDirectory,
        manifest.files.profiles,
    ),
    nutrition_goals: await readJsonLines<LegacyRow>(
        inputDirectory,
        manifest.files.nutrition_goals,
    ),
    meals: await readJsonLines<LegacyRow>(
        inputDirectory,
        manifest.files.meals,
    ),
    water_log: await readJsonLines<LegacyRow>(
        inputDirectory,
        manifest.files.water_log,
    ),
    weight_log: await readJsonLines<LegacyRow>(
        inputDirectory,
        manifest.files.weight_log,
    ),
};

const sourceUsers = new Map(data.users.map((user) => [user.id, user]));
if (sourceUsers.size !== data.users.length) {
    throw new Error("Legacy export contains duplicate user IDs");
}
const sourceEmails = new Set<string>();
for (const user of data.users) {
    const email = user.email.trim().toLowerCase();
    if (!email || sourceEmails.has(email)) {
        throw new Error("Legacy export contains missing or duplicate user emails");
    }
    sourceEmails.add(email);
}
for (const table of LEGACY_TABLES.filter((name) => name !== "users")) {
    for (const row of data[table]) {
        if (!sourceUsers.has(row.user_id)) {
            throw new Error(`${table} contains an unknown source user ID`);
        }
    }
}

const counts = Object.fromEntries(
    LEGACY_TABLES.map((table) => [table, data[table].length]),
);
if (dryRun) {
    console.log(
        JSON.stringify({
            import: "dry-run-complete",
            manifestChecksum: manifest.manifestChecksum,
            counts,
        }),
    );
    process.exit(0);
}

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the Railway import");
}
const database = getPlatformDatabase();
const runRows = await database<Array<{ id: string }>>`
    insert into munch.legacy_migration_runs (
        source_system,
        manifest_checksum,
        dry_run,
        source_exported_at,
        row_counts
    ) values (
        ${manifest.sourceSystem},
        ${manifest.manifestChecksum},
        false,
        ${new Date(manifest.exportedAt)},
        ${JSON.stringify(counts)}::jsonb
    )
    returning id
`;
const runId = runRows[0]!.id;

try {
    await database.begin(async (tx) => {
        const userMap = new Map<string, string>();
        for (const source of data.users) {
            const email = source.email.trim().toLowerCase();
            const userRows = await tx<Array<{ id: string }>>`
                insert into munch.users (
                    email,
                    email_verified_at,
                    status,
                    created_at,
                    updated_at
                ) values (
                    ${email},
                    ${source.email_confirmed_at ? new Date(source.email_confirmed_at) : null},
                    'active',
                    ${source.created_at ? new Date(source.created_at) : new Date()},
                    ${source.updated_at ? new Date(source.updated_at) : new Date()}
                )
                on conflict (email) do update
                set email_verified_at = coalesce(
                        munch.users.email_verified_at,
                        excluded.email_verified_at
                    ),
                    updated_at = greatest(munch.users.updated_at, excluded.updated_at)
                returning id
            `;
            const userId = userRows[0]!.id;
            userMap.set(source.id, userId);
            await tx`
                insert into munch.legacy_identity_links (
                    source_system,
                    source_user_id,
                    user_id,
                    source_email,
                    migrated_at
                ) values (
                    ${manifest.sourceSystem},
                    ${source.id},
                    ${userId},
                    ${email},
                    now()
                )
                on conflict (source_system, source_user_id) do update
                set user_id = excluded.user_id,
                    source_email = excluded.source_email,
                    migrated_at = now()
            `;
        }

        const mappedUser = (sourceId: string): string => {
            const userId = userMap.get(sourceId);
            if (!userId) throw new Error("Legacy user mapping is incomplete");
            return userId;
        };

        for (const row of data.profiles) {
            await tx`
                insert into munch.profiles (
                    user_id,
                    timezone,
                    preferred_weight_unit,
                    widgets_enabled,
                    alcohol_tracking_enabled,
                    preferred_drink_unit,
                    created_at,
                    updated_at
                ) values (
                    ${mappedUser(row.user_id)},
                    ${row.timezone ?? "UTC"},
                    ${row.preferred_weight_unit ?? null},
                    ${row.widgets_enabled ?? true},
                    ${row.alcohol_tracking_enabled ?? false},
                    ${row.preferred_drink_unit ?? null},
                    ${row.created_at ? new Date(String(row.created_at)) : new Date()},
                    ${row.updated_at ? new Date(String(row.updated_at)) : new Date()}
                )
                on conflict (user_id) do update
                set timezone = excluded.timezone,
                    preferred_weight_unit = excluded.preferred_weight_unit,
                    widgets_enabled = excluded.widgets_enabled,
                    alcohol_tracking_enabled = excluded.alcohol_tracking_enabled,
                    preferred_drink_unit = excluded.preferred_drink_unit,
                    updated_at = excluded.updated_at
            `;
        }

        for (const row of data.nutrition_goals) {
            await tx`
                insert into munch.nutrition_goals (
                    user_id,
                    daily_calories,
                    daily_protein_g,
                    daily_carbs_g,
                    daily_fat_g,
                    daily_fiber_g,
                    daily_sugar_g,
                    daily_alcohol_g,
                    daily_water_ml,
                    target_weight_g,
                    updated_at
                ) values (
                    ${mappedUser(row.user_id)},
                    ${row.daily_calories ?? null},
                    ${row.daily_protein_g ?? null},
                    ${row.daily_carbs_g ?? null},
                    ${row.daily_fat_g ?? null},
                    ${row.daily_fiber_g ?? null},
                    ${row.daily_sugar_g ?? null},
                    ${row.daily_alcohol_g ?? null},
                    ${row.daily_water_ml ?? null},
                    ${row.target_weight_g ?? null},
                    ${row.updated_at ? new Date(String(row.updated_at)) : new Date()}
                )
                on conflict (user_id) do update
                set daily_calories = excluded.daily_calories,
                    daily_protein_g = excluded.daily_protein_g,
                    daily_carbs_g = excluded.daily_carbs_g,
                    daily_fat_g = excluded.daily_fat_g,
                    daily_fiber_g = excluded.daily_fiber_g,
                    daily_sugar_g = excluded.daily_sugar_g,
                    daily_alcohol_g = excluded.daily_alcohol_g,
                    daily_water_ml = excluded.daily_water_ml,
                    target_weight_g = excluded.target_weight_g,
                    updated_at = excluded.updated_at
            `;
        }

        for (const row of data.meals) {
            await tx`
                insert into munch.meals (
                    id,
                    user_id,
                    logged_at,
                    meal_type,
                    description,
                    calories,
                    protein_g,
                    carbs_g,
                    fat_g,
                    fiber_g,
                    sugar_g,
                    alcohol_g,
                    notes,
                    idempotency_key,
                    created_at,
                    updated_at
                ) values (
                    ${row.id},
                    ${mappedUser(row.user_id)},
                    ${new Date(String(row.logged_at))},
                    ${row.meal_type ?? null},
                    ${row.description},
                    ${row.calories ?? null},
                    ${row.protein_g ?? null},
                    ${row.carbs_g ?? null},
                    ${row.fat_g ?? null},
                    ${row.fiber_g ?? null},
                    ${row.sugar_g ?? null},
                    ${row.alcohol_g ?? null},
                    ${row.notes ?? null},
                    ${row.idempotency_key ?? null},
                    ${row.created_at ? new Date(String(row.created_at)) : new Date()},
                    ${row.updated_at ? new Date(String(row.updated_at)) : new Date()}
                )
                on conflict (id) do update
                set user_id = excluded.user_id,
                    logged_at = excluded.logged_at,
                    meal_type = excluded.meal_type,
                    description = excluded.description,
                    calories = excluded.calories,
                    protein_g = excluded.protein_g,
                    carbs_g = excluded.carbs_g,
                    fat_g = excluded.fat_g,
                    fiber_g = excluded.fiber_g,
                    sugar_g = excluded.sugar_g,
                    alcohol_g = excluded.alcohol_g,
                    notes = excluded.notes,
                    idempotency_key = excluded.idempotency_key,
                    updated_at = excluded.updated_at
            `;
        }

        for (const row of data.water_log) {
            await tx`
                insert into munch.water_logs (
                    id,
                    user_id,
                    amount_ml,
                    logged_at,
                    notes,
                    idempotency_key,
                    created_at
                ) values (
                    ${row.id},
                    ${mappedUser(row.user_id)},
                    ${row.amount_ml},
                    ${new Date(String(row.logged_at))},
                    ${row.notes ?? null},
                    ${row.idempotency_key ?? null},
                    ${row.created_at ? new Date(String(row.created_at)) : new Date()}
                )
                on conflict (id) do update
                set user_id = excluded.user_id,
                    amount_ml = excluded.amount_ml,
                    logged_at = excluded.logged_at,
                    notes = excluded.notes,
                    idempotency_key = excluded.idempotency_key
            `;
        }

        for (const row of data.weight_log) {
            await tx`
                insert into munch.weight_logs (
                    id,
                    user_id,
                    weight_g,
                    logged_at,
                    notes,
                    idempotency_key,
                    created_at,
                    updated_at
                ) values (
                    ${row.id},
                    ${mappedUser(row.user_id)},
                    ${row.weight_g},
                    ${new Date(String(row.logged_at))},
                    ${row.notes ?? null},
                    ${row.idempotency_key ?? null},
                    ${row.created_at ? new Date(String(row.created_at)) : new Date()},
                    ${row.updated_at ? new Date(String(row.updated_at)) : new Date()}
                )
                on conflict (id) do update
                set user_id = excluded.user_id,
                    weight_g = excluded.weight_g,
                    logged_at = excluded.logged_at,
                    notes = excluded.notes,
                    idempotency_key = excluded.idempotency_key,
                    updated_at = excluded.updated_at
            `;
        }
    });

    await database`
        update munch.legacy_migration_runs
        set status = 'completed', completed_at = now()
        where id = ${runId}
    `;
    console.log(
        JSON.stringify({
            import: "complete",
            runId,
            manifestChecksum: manifest.manifestChecksum,
            counts,
        }),
    );
} catch (error) {
    await database`
        update munch.legacy_migration_runs
        set status = 'failed',
            completed_at = now(),
            error_code = ${error instanceof Error ? error.name : "UnknownError"}
        where id = ${runId}
    `;
    throw error;
} finally {
    await closePlatformDatabase();
}
