import { describe, expect, test } from "bun:test";
import { chooseDirectSubscription } from "./subscription-sources.js";

const now = new Date("2026-08-27T12:00:00.000Z");

describe("direct billing source selection", () => {
    test("keeps Stripe premium when no store purchase exists", () => {
        const result = chooseDirectSubscription(
            [{ provider: "stripe", status: "active" }],
            now,
        );
        expect(result.provider).toBe("stripe");
        expect(result.status).toBe("active");
    });

    test("allows verified Google Play premium without replacing Stripe records", () => {
        const result = chooseDirectSubscription(
            [
                { provider: "stripe", status: "canceled" },
                {
                    provider: "google_play",
                    status: "active",
                    currentPeriodEnd: new Date("2026-09-27T12:00:00.000Z"),
                },
            ],
            now,
        );
        expect(result.provider).toBe("google_play");
        expect(result.status).toBe("active");
    });

    test("prefers access-granting state over a newer ended record", () => {
        const result = chooseDirectSubscription(
            [
                {
                    provider: "google_play",
                    status: "active",
                    currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
                },
                {
                    provider: "stripe",
                    status: "canceled",
                    currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
                },
            ],
            now,
        );
        expect(result.provider).toBe("google_play");
    });

    test("honors only an unexpired past-due grace period", () => {
        const result = chooseDirectSubscription(
            [
                {
                    provider: "google_play",
                    status: "past_due",
                    graceExpiresAt: new Date("2026-08-28T00:00:00.000Z"),
                },
                {
                    provider: "stripe",
                    status: "past_due",
                    graceExpiresAt: new Date("2026-08-26T00:00:00.000Z"),
                },
            ],
            now,
        );
        expect(result.provider).toBe("google_play");
    });

    test("uses the later period end when two active sources coexist", () => {
        const result = chooseDirectSubscription(
            [
                {
                    provider: "stripe",
                    status: "active",
                    currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
                },
                {
                    provider: "google_play",
                    status: "active",
                    currentPeriodEnd: new Date("2026-09-27T00:00:00.000Z"),
                },
            ],
            now,
        );
        expect(result.provider).toBe("google_play");
    });
});
