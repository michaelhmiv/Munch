import path from "node:path";
import { getPlatformDatabase } from "../platform/database.js";
import { configurationIssues } from "./config.js";

const BASELINE_GENERATION = "2026-08-18";

export interface ReadinessComponent {
    name: string;
    ok: boolean;
    detail?: string;
}

export interface ReadinessReport {
    ready: boolean;
    backend: "railway";
    checkedAt: string;
    components: ReadinessComponent[];
}

async function repositoryUpdateVersions(): Promise<string[]> {
    const directory = path.resolve("db/updates");
    const files = await Array.fromAsync(
        new Bun.Glob("*.sql").scan({ cwd: directory, absolute: false }),
    ).catch(() => [] as string[]);
    return files
        .map((file) => file.match(/^(\d{4,})_/)?.[1])
        .filter((version): version is string => Boolean(version))
        .sort();
}

export async function buildReadinessReport(): Promise<ReadinessReport> {
    const components: ReadinessComponent[] = [];
    const issues = configurationIssues();
    components.push({
        name: "configuration",
        ok: issues.length === 0,
        ...(issues.length > 0
            ? { detail: `${issues.length} configuration issue(s)` }
            : {}),
    });

    try {
        const database = getPlatformDatabase();
        await database`select 1 as ok`;
        components.push({ name: "database", ok: true });

        const stateRows = await database<Array<{ generation: string }>>`
            select generation
            from munch.schema_state
            where singleton = true
        `;
        const generation = stateRows[0]?.generation;
        const expectedVersions = await repositoryUpdateVersions();
        const updateRows = await database<Array<{ version: string }>>`
            select version from munch.schema_updates order by version
        `;
        const applied = new Set(updateRows.map((row) => row.version));
        const missing = expectedVersions.filter(
            (version) => !applied.has(version),
        );
        const schemaCurrent =
            generation === BASELINE_GENERATION && missing.length === 0;
        components.push({
            name: "migrations",
            ok: schemaCurrent,
            detail: schemaCurrent
                ? `canonical schema ${BASELINE_GENERATION}; ${expectedVersions.length} update(s) applied`
                : generation !== BASELINE_GENERATION
                  ? `schema generation ${generation ?? "missing"}; expected ${BASELINE_GENERATION}`
                  : `${missing.length} schema update(s) missing`,
        });

        const requiredRoles = [
            "munch_app",
            "munch_auth",
            "munch_billing",
            "munch_support",
            "munch_service",
        ];
        const roleRows = await database<Array<{ rolname: string }>>`
            select rolname from pg_roles
            where rolname in ${database(requiredRoles)}
        `;
        const availableRoles = new Set(roleRows.map((row) => row.rolname));
        const missingRoles = requiredRoles.filter(
            (role) => !availableRoles.has(role),
        );
        components.push({
            name: "database_roles",
            ok: missingRoles.length === 0,
            ...(missingRoles.length > 0
                ? { detail: `${missingRoles.length} role(s) missing` }
                : {}),
        });

        const protectedTables = [
            "meals",
            "meal_items",
            "nutrition_goals",
            "water_logs",
            "weight_logs",
            "saved_foods",
            "meal_drafts",
            "meal_draft_items",
            "meal_draft_questions",
        ];
        const rlsRows = await database<
            Array<{
                relname: string;
                relrowsecurity: boolean;
                relforcerowsecurity: boolean;
            }>
        >`
            select c.relname, c.relrowsecurity, c.relforcerowsecurity
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'munch'
              and c.relname in ${database(protectedTables)}
        `;
        const secure = new Set(
            rlsRows
                .filter((row) => row.relrowsecurity && row.relforcerowsecurity)
                .map((row) => row.relname),
        );
        const insecureTables = protectedTables.filter(
            (table) => !secure.has(table),
        );
        components.push({
            name: "row_level_security",
            ok: insecureTables.length === 0,
            ...(insecureTables.length > 0
                ? { detail: `${insecureTables.length} table(s) not forced-RLS` }
                : {}),
        });
    } catch {
        components.push({
            name: "database",
            ok: false,
            detail: "Database readiness check failed",
        });
    }

    return {
        ready: components.every((component) => component.ok),
        backend: "railway",
        checkedAt: new Date().toISOString(),
        components,
    };
}
