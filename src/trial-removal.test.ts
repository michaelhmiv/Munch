import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_CONFIG } from "./product-config.js";
import { decideEntitlement } from "./billing/entitlements.js";

// The free trial was removed (Michael, 2026-11-13 — "no 7 day free
// trial anymore"). These guards pin the removal at the same strength
// the old trial facts were pinned:
// - the product config no longer declares a trial;
// - checkout session creation carries no trial parameters (the
//   behavioural pin lives in billing/stripe-client.test.ts; this is
//   the source-level twin);
// - no public page offers or mentions a trial.
// Grandfathering: subscriptions already trialing when the offer ended
// keep Premium until their trial runs out, so the entitlement layer
// must keep honoring the "trialing" status — pinned here too.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function htmlFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await htmlFiles(full)));
        else if (entry.name.endsWith(".html")) files.push(full);
    }
    return files;
}

function normalizedText(source: string): string {
    return source
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

describe("free trial removal (2026-11-13)", () => {
    test("product config declares no trial", () => {
        expect(PRODUCT_CONFIG.trialEnabled).toBe(false);
    });

    test("Stripe checkout client carries no trial parameters", async () => {
        const source = await readFile(
            path.join(ROOT, "src/billing/stripe-client.ts"),
            "utf8",
        );
        for (const forbidden of [
            "trial_period_days",
            "trial_settings",
            "MUNCH_TRIAL_DAYS",
            "trialDays",
        ]) {
            expect(source).not.toContain(forbidden);
        }
    });

    test("no public page offers or mentions a trial", async () => {
        const files = await htmlFiles(path.join(ROOT, "public"));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            const text = normalizedText(await readFile(file, "utf8"));
            expect(
                /\btrial\b/i.test(text),
                `${path.relative(ROOT, file)} contains trial language`,
            ).toBe(false);
            expect(
                /\d+\s*days?\s+free/i.test(text),
                `${path.relative(ROOT, file)} promises free days`,
            ).toBe(false);
        }
    });

    test("existing trialing subscriptions remain grandfathered", () => {
        const decision = decideEntitlement(
            { status: "trialing" },
            new Date("2026-11-13T00:00:00Z"),
        );
        expect(decision.canUseProtectedTools).toBe(true);
    });
});
