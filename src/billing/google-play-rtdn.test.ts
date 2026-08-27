import { describe, expect, test } from "bun:test";
import { parseGooglePlayRtdn } from "./google-play-rtdn.js";

function envelope(payload: unknown, messageId = "message-1") {
    return JSON.stringify({
        message: {
            messageId,
            data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
        },
    });
}

describe("Google Play RTDN parsing", () => {
    test("parses subscription lifecycle notifications", () => {
        const parsed = parseGooglePlayRtdn(
            envelope({
                version: "1.0",
                packageName: "business.munch.app",
                eventTimeMillis: "1787835600000",
                subscriptionNotification: {
                    version: "1.0",
                    notificationType: 13,
                    purchaseToken: "purchase-token-123",
                },
            }),
        );
        expect(parsed.messageId).toBe("message-1");
        expect(parsed.eventType).toBe("subscription:13");
        expect(parsed.purchaseToken).toBe("purchase-token-123");
        expect(parsed.actionableSubscription).toBe(true);
    });

    test("treats subscription voids as actionable subscription events", () => {
        const parsed = parseGooglePlayRtdn(
            envelope({
                version: "1.0",
                packageName: "business.munch.app",
                voidedPurchaseNotification: {
                    purchaseToken: "purchase-token-voided",
                    orderId: "GPA.1234-5678-9012-34567",
                    productType: 1,
                    refundType: 1,
                },
            }),
        );
        expect(parsed.eventType).toBe("voided_subscription:1");
        expect(parsed.purchaseToken).toBe("purchase-token-voided");
        expect(parsed.actionableSubscription).toBe(true);
    });

    test("acknowledges test notifications without purchase processing", () => {
        const parsed = parseGooglePlayRtdn(
            envelope({
                version: "1.0",
                packageName: "business.munch.app",
                testNotification: { version: "1.0" },
            }),
        );
        expect(parsed.eventType).toBe("test");
        expect(parsed.purchaseToken).toBeNull();
        expect(parsed.actionableSubscription).toBe(false);
    });

    test("ignores one-time product messages because Munch has no one-time Play products", () => {
        const parsed = parseGooglePlayRtdn(
            envelope({
                version: "1.0",
                packageName: "business.munch.app",
                oneTimeProductNotification: {
                    version: "1.0",
                    notificationType: 1,
                    purchaseToken: "one-time-token",
                    sku: "unused",
                },
            }),
        );
        expect(parsed.eventType).toBe("ignored_non_subscription");
        expect(parsed.actionableSubscription).toBe(false);
    });

    test("rejects subscription notifications without a purchase token", () => {
        expect(() =>
            parseGooglePlayRtdn(
                envelope({
                    packageName: "business.munch.app",
                    subscriptionNotification: {
                        version: "1.0",
                        notificationType: 2,
                    },
                }),
            ),
        ).toThrow("google_play_rtdn_purchase_token_missing");
    });
});
