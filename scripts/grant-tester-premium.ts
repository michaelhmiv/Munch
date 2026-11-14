#!/usr/bin/env bun
/**
 * Grant (or revoke) Premium comps for Google Play closed-test testers.
 *
 * Nov 9 ruling: Play closed-test testers receive Premium free for the
 * test's duration, revocable. The cohort joins through the Google Group
 * 12testerslive@googlegroups.com attached to the closed track "Munch
 * testers"; group membership is anonymous to us, so a comp can only be
 * granted once a tester is identifiable by the email they used to create
 * a Munch account. This script is the prepared execution path for that
 * moment: it resolves each supplied email to a Munch user and grants via
 * the same entitlement-override mechanism that provisions the App Store
 * reviewer account (scripts/provision-reviewer.ts).
 *
 * Usage:
 *   bun scripts/grant-tester-premium.ts tester@example.com [...]
 *   bun scripts/grant-tester-premium.ts --emails a@example.com,b@example.com
 *   bun scripts/grant-tester-premium.ts --file testers.txt
 *   bun scripts/grant-tester-premium.ts --apply tester@example.com
 *   bun scripts/grant-tester-premium.ts --revoke --apply tester@example.com
 *
 * Default mode is DRY-RUN: emails are resolved and the planned actions
 * are printed, but nothing is written. Pass --apply to write.
 * --expires-at sets the grant expiry (default 2026-12-31, past the
 * closed-test clock completion and production-access window); it is
 * ignored with --revoke. Requires DATABASE_URL.
 */

export const DEFAULT_TESTER_PREMIUM_EXPIRES_AT = "2026-12-31";
export const TESTER_PREMIUM_REASON =
    "Play closed-test cohort (Munch testers, 12testerslive@googlegroups.com): Premium comp for test duration";

export type TesterPremiumOptions = {
    emails: string[];
    apply: boolean;
    revoke: boolean;
    expiresAt: Date;
};

export type TesterPremiumAction =
    | {
          email: string;
          status: "no_account";
          action: "skip";
          detail: string;
      }
    | {
          email: string;
          status: "resolved";
          userId: string;
          action: "grant" | "revoke" | "would_grant" | "would_revoke";
          detail: string;
      };

export function normalizeTesterEmail(raw: string): string | null {
    const email = raw.trim().toLowerCase();
    if (!email || email.length > 320) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email;
}

export function parseExpiresAt(raw: string): Date {
    const value = raw.trim();
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const parsed = new Date(dateOnly ? `${value}T23:59:59.999Z` : value);
    if (!Number.isFinite(parsed.getTime())) {
        throw new Error(
            `--expires-at must be an ISO date or datetime, got: ${raw}`,
        );
    }
    return parsed;
}

export function parseTesterPremiumArgs(
    argv: string[],
    fileEmails: string[] = [],
): TesterPremiumOptions {
    const emails: string[] = [];
    let apply = false;
    let revoke = false;
    let expiresAt = parseExpiresAt(DEFAULT_TESTER_PREMIUM_EXPIRES_AT);

    const addEmail = (raw: string) => {
        const email = normalizeTesterEmail(raw);
        if (!email) throw new Error(`Invalid email address: ${raw}`);
        if (!emails.includes(email)) emails.push(email);
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--apply") {
            apply = true;
        } else if (arg === "--revoke") {
            revoke = true;
        } else if (arg === "--emails") {
            const value = argv[i + 1];
            if (!value) throw new Error("--emails requires a value");
            i += 1;
            for (const part of value.split(",")) addEmail(part);
        } else if (arg.startsWith("--emails=")) {
            for (const part of arg.slice("--emails=".length).split(",")) {
                addEmail(part);
            }
        } else if (arg === "--expires-at") {
            const value = argv[i + 1];
            if (!value) throw new Error("--expires-at requires a value");
            i += 1;
            expiresAt = parseExpiresAt(value);
        } else if (arg.startsWith("--expires-at=")) {
            expiresAt = parseExpiresAt(arg.slice("--expires-at=".length));
        } else if (arg === "--file") {
            i += 1;
            if (!argv[i]) throw new Error("--file requires a value");
        } else if (arg.startsWith("--file=")) {
            // File contents are loaded by the CLI entry point and passed in
            // as fileEmails; the flag itself carries no addresses.
        } else if (arg === "--help" || arg === "-h") {
            throw new Error(HELP);
        } else if (arg.startsWith("--")) {
            throw new Error(`Unknown flag: ${arg}`);
        } else {
            addEmail(arg);
        }
    }
    for (const raw of fileEmails) addEmail(raw);

    if (emails.length === 0) {
        throw new Error(
            "At least one tester email is required (positional, --emails, or --file)",
        );
    }
    return { emails, apply, revoke, expiresAt };
}

export function extractFileFlag(argv: string[]): string | null {
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--file") return argv[i + 1] ?? null;
        if (argv[i].startsWith("--file=")) {
            return argv[i].slice("--file=".length);
        }
    }
    return null;
}

export function parseEmailFile(contents: string): string[] {
    return contents
        .split(/\r?\n/)
        .map((line) => line.split("#")[0].trim())
        .filter(Boolean);
}

export function planTesterPremiumActions(input: {
    emails: string[];
    resolvedUserIdByEmail: ReadonlyMap<string, string | null>;
    apply: boolean;
    revoke: boolean;
    expiresAt: Date;
}): TesterPremiumAction[] {
    return input.emails.map((email) => {
        const userId = input.resolvedUserIdByEmail.get(email) ?? null;
        if (!userId) {
            return {
                email,
                status: "no_account",
                action: "skip",
                detail:
                    "no Munch account for this email; nothing to grant " +
                    "(Play opt-in alone creates no Munch account)",
            };
        }
        if (input.revoke) {
            return {
                email,
                status: "resolved",
                userId,
                action: input.apply ? "revoke" : "would_revoke",
                detail: input.apply
                    ? "revoking Premium override"
                    : "dry-run: would revoke Premium override",
            };
        }
        return {
            email,
            status: "resolved",
            userId,
            action: input.apply ? "grant" : "would_grant",
            detail: input.apply
                ? `granting Premium override until ${input.expiresAt.toISOString()}`
                : `dry-run: would grant Premium override until ${input.expiresAt.toISOString()}`,
        };
    });
}

const HELP = `Usage: bun scripts/grant-tester-premium.ts [options] <email...>

Options:
  --emails <a,b>     Comma-separated tester emails
  --file <path>      File with one tester email per line (# comments allowed)
  --expires-at <date> Grant expiry, ISO date/datetime (default ${DEFAULT_TESTER_PREMIUM_EXPIRES_AT})
  --apply            Write changes (default is dry-run)
  --revoke           Revoke instead of grant (combine with --apply to write)
  --help             Show this help

Requires DATABASE_URL. Grants use source "support" via
grantPremiumOverride with reason: ${TESTER_PREMIUM_REASON}`;

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(HELP);
        return;
    }

    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error("DATABASE_URL is required");

    const filePath = extractFileFlag(argv);
    const fileEmails = filePath
        ? parseEmailFile(await Bun.file(filePath).text())
        : [];
    const options = parseTesterPremiumArgs(argv, fileEmails);
    if (!options.revoke && options.expiresAt.getTime() <= Date.now()) {
        throw new Error("--expires-at must be in the future for a grant");
    }

    const { Pool } = await import("pg");
    const pool = new Pool({
        connectionString: databaseUrl,
        max: 2,
        application_name: "munch-grant-tester-premium",
    });

    try {
        const resolvedUserIdByEmail = new Map<string, string | null>();
        for (const email of options.emails) {
            const result = await pool.query<{ id: string }>(
                "select id from munch.users where email = $1 limit 1",
                [email],
            );
            resolvedUserIdByEmail.set(email, result.rows[0]?.id ?? null);
        }

        const plan = planTesterPremiumActions({
            emails: options.emails,
            resolvedUserIdByEmail,
            apply: options.apply,
            revoke: options.revoke,
            expiresAt: options.expiresAt,
        });

        if (options.apply) {
            const { grantPremiumOverride, revokePremiumOverride } =
                await import("../src/billing/override.js");
            const { closePlatformDatabase } =
                await import("../src/platform/database.js");
            try {
                for (const step of plan) {
                    if (step.status !== "resolved") continue;
                    if (step.action === "grant") {
                        await grantPremiumOverride({
                            userId: step.userId,
                            expiresAt: options.expiresAt,
                            source: "support",
                            reason: TESTER_PREMIUM_REASON,
                        });
                    } else if (step.action === "revoke") {
                        await revokePremiumOverride({
                            userId: step.userId,
                            reason: TESTER_PREMIUM_REASON,
                        });
                    }
                }
            } finally {
                await closePlatformDatabase();
            }
        }

        console.log(
            JSON.stringify(
                {
                    mode: options.apply ? "apply" : "dry-run",
                    operation: options.revoke ? "revoke" : "grant",
                    expiresAt: options.revoke
                        ? null
                        : options.expiresAt.toISOString(),
                    reason: TESTER_PREMIUM_REASON,
                    results: plan,
                },
                null,
                2,
            ),
        );
    } finally {
        await pool.end();
    }
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
