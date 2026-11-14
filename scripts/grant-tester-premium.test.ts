import { describe, expect, test } from "bun:test";

import {
    DEFAULT_TESTER_PREMIUM_EXPIRES_AT,
    TESTER_PREMIUM_REASON,
    normalizeTesterEmail,
    parseEmailFile,
    parseExpiresAt,
    parseTesterPremiumArgs,
    planTesterPremiumActions,
} from "./grant-tester-premium";

describe("grant-tester-premium argument parsing", () => {
    test("defaults to dry-run grant with the 2026-12-31 expiry", () => {
        const options = parseTesterPremiumArgs(["Tester@Example.com"]);
        expect(options.emails).toEqual(["tester@example.com"]);
        expect(options.apply).toBe(false);
        expect(options.revoke).toBe(false);
        expect(options.expiresAt.toISOString()).toBe(
            parseExpiresAt(DEFAULT_TESTER_PREMIUM_EXPIRES_AT).toISOString(),
        );
        expect(options.expiresAt.toISOString()).toBe(
            "2026-12-31T23:59:59.999Z",
        );
    });

    test("accepts --emails, --apply, --revoke, and --expires-at", () => {
        const options = parseTesterPremiumArgs([
            "--emails",
            "a@example.com, b@example.com",
            "--apply",
            "--expires-at",
            "2027-01-15",
        ]);
        expect(options.emails).toEqual(["a@example.com", "b@example.com"]);
        expect(options.apply).toBe(true);
        expect(options.expiresAt.toISOString()).toBe(
            "2027-01-15T23:59:59.999Z",
        );

        const revoke = parseTesterPremiumArgs([
            "--revoke",
            "--apply",
            "a@example.com",
        ]);
        expect(revoke.revoke).toBe(true);
        expect(revoke.apply).toBe(true);
    });

    test("dedupes emails across positional, --emails, and file inputs", () => {
        const options = parseTesterPremiumArgs(
            ["dup@example.com", "--emails=dup@example.com,other@example.com"],
            ["DUP@example.com"],
        );
        expect(options.emails).toEqual([
            "dup@example.com",
            "other@example.com",
        ]);
    });

    test("rejects invalid emails, unknown flags, and missing inputs", () => {
        expect(() => parseTesterPremiumArgs(["not-an-email"])).toThrow(
            "Invalid email address",
        );
        expect(() => parseTesterPremiumArgs([])).toThrow(
            "At least one tester email is required",
        );
        expect(() =>
            parseTesterPremiumArgs(["--nope", "a@example.com"]),
        ).toThrow("Unknown flag");
        expect(() => parseTesterPremiumArgs(["--emails"])).toThrow(
            "--emails requires a value",
        );
        expect(() =>
            parseTesterPremiumArgs(["--expires-at", "junk", "a@example.com"]),
        ).toThrow("--expires-at must be an ISO date or datetime");
    });

    test("normalizeTesterEmail trims, lowercases, and validates", () => {
        expect(normalizeTesterEmail("  Person@Example.COM ")).toBe(
            "person@example.com",
        );
        expect(normalizeTesterEmail("")).toBeNull();
        expect(normalizeTesterEmail("no-at-sign")).toBeNull();
        expect(normalizeTesterEmail("a@b")).toBeNull();
    });

    test("parseEmailFile skips blanks and comments", () => {
        expect(
            parseEmailFile(
                "# cohort\none@example.com\n\n two@example.com # joined\n",
            ),
        ).toEqual(["one@example.com", "two@example.com"]);
    });

    test("the recorded reason names the closed-test cohort and fits the override limit", () => {
        expect(TESTER_PREMIUM_REASON).toContain("closed-test cohort");
        expect(TESTER_PREMIUM_REASON.length).toBeLessThanOrEqual(200);
    });
});

describe("grant-tester-premium planning", () => {
    const expiresAt = parseExpiresAt(DEFAULT_TESTER_PREMIUM_EXPIRES_AT);
    const resolved = new Map<string, string | null>([
        ["has-account@example.com", "user-123"],
        ["no-account@example.com", null],
    ]);

    test("dry-run grants resolved users and skips emails with no account", () => {
        const plan = planTesterPremiumActions({
            emails: ["has-account@example.com", "no-account@example.com"],
            resolvedUserIdByEmail: resolved,
            apply: false,
            revoke: false,
            expiresAt,
        });
        expect(plan[0]).toMatchObject({
            email: "has-account@example.com",
            status: "resolved",
            userId: "user-123",
            action: "would_grant",
        });
        expect(plan[1]).toMatchObject({
            email: "no-account@example.com",
            status: "no_account",
            action: "skip",
        });
    });

    test("apply mode grants, and revoke mode plans revocations", () => {
        const grant = planTesterPremiumActions({
            emails: ["has-account@example.com"],
            resolvedUserIdByEmail: resolved,
            apply: true,
            revoke: false,
            expiresAt,
        });
        expect(grant[0].action).toBe("grant");

        const revokeDryRun = planTesterPremiumActions({
            emails: ["has-account@example.com"],
            resolvedUserIdByEmail: resolved,
            apply: false,
            revoke: true,
            expiresAt,
        });
        expect(revokeDryRun[0].action).toBe("would_revoke");

        const revokeApply = planTesterPremiumActions({
            emails: ["has-account@example.com"],
            resolvedUserIdByEmail: resolved,
            apply: true,
            revoke: true,
            expiresAt,
        });
        expect(revokeApply[0].action).toBe("revoke");
    });
});
