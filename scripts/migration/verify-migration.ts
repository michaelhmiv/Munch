#!/usr/bin/env bun

import path from "node:path";
import {
    closePlatformDatabase,
    getPlatformDatabase,
} from "../../src/platform/database.js";
import {
    LEGACY_TABLES,
    readJsonLines,
    readManifest,
    requiredArgument,
} from "./common.js";

interface LegacyUser {
    id: string;
    email: string;
}

interface LegacyRow extends Record<string, unknown> {
    id?: string;
    user_id: string;
}

interface VerificationCheck {
    name: string;
    expected: unknown;
    actual: unknown;
    ok: boolean;
}

function number(value: unknown): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function sum(rows: LegacyRow[], key: string): number {
    return round(rows.reduce((total, row) => total + number(row[key]), 0));
}

function timestampRange(rows: LegacyRow[], key: string) {
    const timestamps = rows
        .map((row) => row[key])
        .filter((value): value is string => typeof value === "string")
        .map((value) => new Date(value).toISOString())
        .sort();
    return {
        min: timestamps[0] ?? null,
        max: timestamps.at(-1) ?? null,
    };
}

function addCheck(
    checks: VerificationCheck[],
    name: string,
    expected: unknown,
    actual: unknown,
): void {
    checks.push({
        name,
        expected,
        actual,
        ok: JSON.stringify(expected) === JSON.stringify(actual),
    });
}

const inputDirectory = path.resolve(requiredArgument("input"));
const manifest = await readManifest(inputDirectory);
const users = await readJsonLines<LegacyUser>(
    inputDirectory,
    manifest.files.users,
);
const profiles = await readJsonLines<LegacyRow>(
    inputDirectory,
    manifest.files.profiles,
);
const goals = await readJsonLines<LegacyRow>(
    inputDirectory,
    manifest.files.nutrition_goals,
);
const meals = await readJsonLines<LegacyRow>(
    inputDirectory,
    manifest.files.meals,
);
const water = await readJsonLines<LegacyRow>(
    inputDirectory,
    manifest.files.water_log,
);
const weight = await readJsonLines<LegacyRow>(
    inputDirectory,
    manifest.files.weight_log,
);

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for migration verification");
}
const database = getPlatformDatabase();
const checks: VerificationCheck[] = [];

try {
    const links = await database<
        Array<{
            source_user_id: string;
            user_id: string;
            source_email: string;
        }>
    >`
        select source_user_id, user_id, source_email
        from munch.legacy_identity_links
        where source_system = ${manifest.sourceSystem}
          and source_user_id in ${database(users.map((user) => user.id))}
    `;
    const linkedUsers = new Map(
        links.map((link) => [link.source_user_id, link.user_id]),
    );
    addCheck(checks, "identity_link_count", users.length, links.length);
    addCheck(
        checks,
        "identity_email_match",
        users
            .map((user) => [user.id, user.email.trim().toLowerCase()])
            .sort(),
        links
            .map((link) => [link.source_user_id, link.source_email])
            .sort(),
    );

    const mappedUserIds = [...new Set(links.map((link) => link.user_id))];
    if (mappedUserIds.length !== users.length) {
        addCheck(
            checks,
            "unique_mapped_user_count",
            users.length,
            mappedUserIds.length,
        );
    }

    const countRows = await database<
        Array<{
            profiles: number;
            goals: number;
            meals: number;
            water: number;
            weight: number;
        }>
    >`
        select
            (select count(*)::integer from munch.profiles where user_id in ${database(mappedUserIds)}) as profiles,
            (select count(*)::integer from munch.nutrition_goals where user_id in ${database(mappedUserIds)}) as goals,
            (select count(*)::integer from munch.meals where user_id in ${database(mappedUserIds)}) as meals,
            (select count(*)::integer from munch.water_logs where user_id in ${database(mappedUserIds)}) as water,
            (select count(*)::integer from munch.weight_logs where user_id in ${database(mappedUserIds)}) as weight
    `;
    const counts = countRows[0]!;
    addCheck(checks, "profiles_count", profiles.length, counts.profiles);
    addCheck(checks, "nutrition_goals_count", goals.length, counts.goals);
    addCheck(checks, "meals_count", meals.length, counts.meals);
    addCheck(checks, "water_count", water.length, counts.water);
    addCheck(checks, "weight_count", weight.length, counts.weight);

    const sourceMealIds = meals
        .map((row) => row.id)
        .filter((value): value is string => typeof value === "string")
        .sort();
    const sourceWaterIds = water
        .map((row) => row.id)
        .filter((value): value is string => typeof value === "string")
        .sort();
    const sourceWeightIds = weight
        .map((row) => row.id)
        .filter((value): value is string => typeof value === "string")
        .sort();

    const targetMealIds = sourceMealIds.length
        ? (
              await database<Array<{ id: string }>>`
                  select id::text as id from munch.meals
                  where id in ${database(sourceMealIds)}
              `
          )
              .map((row) => row.id)
              .sort()
        : [];
    const targetWaterIds = sourceWaterIds.length
        ? (
              await database<Array<{ id: string }>>`
                  select id::text as id from munch.water_logs
                  where id in ${database(sourceWaterIds)}
              `
          )
              .map((row) => row.id)
              .sort()
        : [];
    const targetWeightIds = sourceWeightIds.length
        ? (
              await database<Array<{ id: string }>>`
                  select id::text as id from munch.weight_logs
                  where id in ${database(sourceWeightIds)}
              `
          )
              .map((row) => row.id)
              .sort()
        : [];
    addCheck(checks, "meal_ids", sourceMealIds, targetMealIds);
    addCheck(checks, "water_ids", sourceWaterIds, targetWaterIds);
    addCheck(checks, "weight_ids", sourceWeightIds, targetWeightIds);

    const aggregateRows = await database<
        Array<{
            calories: number;
            protein_g: number;
            carbs_g: number;
            fat_g: number;
            water_ml: number;
            weight_g: number;
        }>
    >`
        select
            coalesce((select sum(calories) from munch.meals where user_id in ${database(mappedUserIds)}), 0)::numeric as calories,
            coalesce((select sum(protein_g) from munch.meals where user_id in ${database(mappedUserIds)}), 0)::numeric as protein_g,
            coalesce((select sum(carbs_g) from munch.meals where user_id in ${database(mappedUserIds)}), 0)::numeric as carbs_g,
            coalesce((select sum(fat_g) from munch.meals where user_id in ${database(mappedUserIds)}), 0)::numeric as fat_g,
            coalesce((select sum(amount_ml) from munch.water_logs where user_id in ${database(mappedUserIds)}), 0)::numeric as water_ml,
            coalesce((select sum(weight_g) from munch.weight_logs where user_id in ${database(mappedUserIds)}), 0)::numeric as weight_g
    `;
    const aggregates = aggregateRows[0]!;
    addCheck(checks, "meal_calories_sum", sum(meals, "calories"), round(number(aggregates.calories)));
    addCheck(checks, "meal_protein_sum", sum(meals, "protein_g"), round(number(aggregates.protein_g)));
    addCheck(checks, "meal_carbs_sum", sum(meals, "carbs_g"), round(number(aggregates.carbs_g)));
    addCheck(checks, "meal_fat_sum", sum(meals, "fat_g"), round(number(aggregates.fat_g)));
    addCheck(checks, "water_ml_sum", sum(water, "amount_ml"), round(number(aggregates.water_ml)));
    addCheck(checks, "weight_g_sum", sum(weight, "weight_g"), round(number(aggregates.weight_g)));

    const rangeRows = await database<
        Array<{
            meal_min: string | null;
            meal_max: string | null;
            water_min: string | null;
            water_max: string | null;
            weight_min: string | null;
            weight_max: string | null;
        }>
    >`
        select
            (select min(logged_at)::text from munch.meals where user_id in ${database(mappedUserIds)}) as meal_min,
            (select max(logged_at)::text from munch.meals where user_id in ${database(mappedUserIds)}) as meal_max,
            (select min(logged_at)::text from munch.water_logs where user_id in ${database(mappedUserIds)}) as water_min,
            (select max(logged_at)::text from munch.water_logs where user_id in ${database(mappedUserIds)}) as water_max,
            (select min(logged_at)::text from munch.weight_logs where user_id in ${database(mappedUserIds)}) as weight_min,
            (select max(logged_at)::text from munch.weight_logs where user_id in ${database(mappedUserIds)}) as weight_max
    `;
    const ranges = rangeRows[0]!;
    const normalizeRange = (min: string | null, max: string | null) => ({
        min: min ? new Date(min).toISOString() : null,
        max: max ? new Date(max).toISOString() : null,
    });
    addCheck(
        checks,
        "meal_timestamp_range",
        timestampRange(meals, "logged_at"),
        normalizeRange(ranges.meal_min, ranges.meal_max),
    );
    addCheck(
        checks,
        "water_timestamp_range",
        timestampRange(water, "logged_at"),
        normalizeRange(ranges.water_min, ranges.water_max),
    );
    addCheck(
        checks,
        "weight_timestamp_range",
        timestampRange(weight, "logged_at"),
        normalizeRange(ranges.weight_min, ranges.weight_max),
    );

    const verification = {
        manifestChecksum: manifest.manifestChecksum,
        checks,
        passed: checks.every((check) => check.ok),
        checkedAt: new Date().toISOString(),
    };
    const runRows = await database<Array<{ id: string }>>`
        select id
        from munch.legacy_migration_runs
        where source_system = ${manifest.sourceSystem}
          and manifest_checksum = ${manifest.manifestChecksum}
        order by started_at desc
        limit 1
    `;
    const runId = runRows[0]?.id;
    if (runId) {
        await database`
            update munch.legacy_migration_runs
            set status = ${verification.passed ? "verified" : "failed"},
                completed_at = coalesce(completed_at, now()),
                verification = ${JSON.stringify(verification)}::jsonb,
                error_code = ${verification.passed ? null : "verification_failed"}
            where id = ${runId}
        `;
    }

    console.log(JSON.stringify({ verification: verification.passed ? "passed" : "failed", runId, ...verification }));
    if (!verification.passed) process.exitCode = 1;
} finally {
    await closePlatformDatabase();
}
