#!/usr/bin/env bun

import { SQL } from "bun";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = new SQL({ url: databaseUrl, max: 1 });
const userId = crypto.randomUUID();
const mealId = crypto.randomUUID();
const sessionId = crypto.randomUUID();

try {
    await sql`
        insert into munch.users (id, email, name, email_verified, status)
        values (${userId}, ${`rebaseline-${userId}@example.test`}, 'Rebaseline smoke', true, 'active')
    `;
    await sql`
        insert into munch.account_preferences (user_id, timezone, preferred_weight_unit)
        values (${userId}, 'America/New_York', 'lb')
    `;
    await sql`
        insert into munch.meals (
            id, user_id, meal_type, description, calories, protein_g, carbs_g, fat_g, idempotency_key
        ) values (
            ${mealId}, ${userId}, 'lunch', 'Preserve me across auth rebaseline', 738, 30.7, 67.9, 43.7,
            ${`rebaseline-${mealId}`}
        )
    `;
    await sql`
        insert into munch.nutrition_goals (user_id, daily_calories, daily_protein_g)
        values (${userId}, 2200, 160)
    `;
    await sql`
        insert into munch.auth_sessions (id, user_id, token, expires_at)
        values (${sessionId}, ${userId}, ${`session-${sessionId}`}, now() + interval '1 hour')
    `;

    await sql.unsafe(`
        drop table munch.schema_state;
        create type munch.login_token_purpose as enum ('signin');
        create table munch.login_tokens (id uuid primary key default gen_random_uuid());
        create table munch.web_sessions (id uuid primary key default gen_random_uuid());
        create table munch.oauth_clients (id uuid primary key default gen_random_uuid());
        create table munch.oauth_authorization_sessions (id uuid primary key default gen_random_uuid());
        create table munch.oauth_authorization_codes (id uuid primary key default gen_random_uuid());
        create table munch.oauth_access_tokens (id uuid primary key default gen_random_uuid());
        create table munch.oauth_refresh_tokens (id uuid primary key default gen_random_uuid());
        create table munch.schema_migrations (
            version text primary key,
            file_name text not null,
            checksum_sha256 text not null,
            applied_at timestamptz not null default now()
        );
    `);

    const migrate = Bun.spawn(["bun", "scripts/migrate.ts"], {
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await migrate.exited;
    if (exitCode !== 0)
        throw new Error(`Rebaseline migration exited ${exitCode}`);

    const preserved = await sql<
        Array<{
            user_count: number;
            meal_count: number;
            preference_count: number;
            goal_count: number;
            session_count: number;
        }>
    >`
        select
            (select count(*)::integer from munch.users where id = ${userId}) as user_count,
            (select count(*)::integer from munch.meals where id = ${mealId} and user_id = ${userId}) as meal_count,
            (select count(*)::integer from munch.account_preferences where user_id = ${userId}) as preference_count,
            (select count(*)::integer from munch.nutrition_goals where user_id = ${userId}) as goal_count,
            (select count(*)::integer from munch.auth_sessions where user_id = ${userId}) as session_count
    `;
    const row = preserved[0];
    if (
        !row ||
        Number(row.user_count) !== 1 ||
        Number(row.meal_count) !== 1 ||
        Number(row.preference_count) !== 1 ||
        Number(row.goal_count) !== 1
    ) {
        throw new Error(
            `Business data was not preserved: ${JSON.stringify(row)}`,
        );
    }
    if (Number(row.session_count) !== 0) {
        throw new Error(
            "Authentication sessions must be reset by the rebaseline",
        );
    }

    const retired = await sql<Array<{ name: string; present: boolean }>>`
        select name, to_regclass('munch.' || name) is not null as present
        from unnest(array[
            'login_tokens',
            'web_sessions',
            'oauth_clients',
            'oauth_authorization_sessions',
            'oauth_authorization_codes',
            'oauth_access_tokens',
            'oauth_refresh_tokens'
        ]) as names(name)
    `;
    const survivors = retired.filter((item) => item.present);
    if (survivors.length) {
        throw new Error(
            `Legacy tables survived rebaseline: ${survivors.map((item) => item.name).join(", ")}`,
        );
    }

    const state = await sql<Array<{ generation: string }>>`
        select generation from munch.schema_state where singleton = true
    `;
    if (state[0]?.generation !== "2026-08-18") {
        throw new Error("Canonical schema generation was not installed");
    }

    console.log("Rebaseline preservation smoke checks passed.");
} finally {
    await sql`delete from munch.users where id = ${userId}`;
    await sql.close();
}
