import { describe, expect, test } from "bun:test";
import {
    isKnownPremiumStripePriceId,
    parseStripeGrandfatheredPriceIds,
    selectPrimaryStripePriceId,
} from "../platform/config.js";
import {
    householdMonthlyTotalCents,
    paidHouseholdSeatCoverage,
} from "./household-seats.js";

describe("paid household seat policy", () => {
    test("prices the owner at $3.99 plus $1.99 for each additional member", () => {
        expect(householdMonthlyTotalCents(0)).toBe(399);
        expect(householdMonthlyTotalCents(1)).toBe(598);
        expect(householdMonthlyTotalCents(2)).toBe(797);
        expect(householdMonthlyTotalCents(5)).toBe(1394);
    });

    test("rejects household sizes outside the six-account cap", () => {
        expect(() => householdMonthlyTotalCents(-1)).toThrow();
        expect(() => householdMonthlyTotalCents(6)).toThrow();
    });

    test("fails closed when Stripe has fewer seats than active members", () => {
        expect(paidHouseholdSeatCoverage(0, 1)).toBe(false);
        expect(paidHouseholdSeatCoverage(1, 2)).toBe(false);
        expect(paidHouseholdSeatCoverage(2, 2)).toBe(true);
    });

    test("allows harmless overbilling without granting unjoined users access", () => {
        expect(paidHouseholdSeatCoverage(2, 1)).toBe(true);
        expect(paidHouseholdSeatCoverage(5, 0)).toBe(true);
    });
});

describe("grandfathered Premium price recognition (Finding 4)", () => {
    const config = {
        stripePriceId: "price_current_399",
        stripeGrandfatheredPriceIds: ["price_grandfathered_299"],
        stripeHouseholdMemberPriceId: "price_seat_199",
    };

    test("accepts the current price and configured grandfathered prices", () => {
        expect(isKnownPremiumStripePriceId("price_current_399", config)).toBe(
            true,
        );
        expect(
            isKnownPremiumStripePriceId("price_grandfathered_299", config),
        ).toBe(true);
    });

    test("rejects the seat price, unknown prices, and empty values", () => {
        expect(isKnownPremiumStripePriceId("price_seat_199", config)).toBe(
            false,
        );
        expect(isKnownPremiumStripePriceId("price_unknown", config)).toBe(
            false,
        );
        expect(isKnownPremiumStripePriceId(null, config)).toBe(false);
        expect(isKnownPremiumStripePriceId(undefined, config)).toBe(false);
        expect(isKnownPremiumStripePriceId("", config)).toBe(false);
    });

    test("rejects the seat price even if mistakenly listed as grandfathered", () => {
        const mistaken = {
            ...config,
            stripeGrandfatheredPriceIds: ["price_seat_199"],
        };
        expect(isKnownPremiumStripePriceId("price_seat_199", mistaken)).toBe(
            false,
        );
    });

    test("accepts multiple comma-separated grandfathered prices", () => {
        expect(
            parseStripeGrandfatheredPriceIds(
                " price_legacy_a ,price_legacy_b, price_legacy_a ,,",
            ),
        ).toEqual(["price_legacy_a", "price_legacy_b"]);
        expect(parseStripeGrandfatheredPriceIds(undefined)).toEqual([]);
        expect(parseStripeGrandfatheredPriceIds("")).toEqual([]);
        const multi = {
            ...config,
            stripeGrandfatheredPriceIds: parseStripeGrandfatheredPriceIds(
                "price_legacy_a,price_legacy_b",
            ),
        };
        expect(isKnownPremiumStripePriceId("price_legacy_a", multi)).toBe(true);
        expect(isKnownPremiumStripePriceId("price_legacy_b", multi)).toBe(true);
    });

    test("selectPrimaryStripePriceId prefers a known plan price over the seat price", () => {
        const items = [
            { stripePriceId: "price_seat_199" },
            { stripePriceId: "price_grandfathered_299" },
        ];
        expect(selectPrimaryStripePriceId(items, config)).toBe(
            "price_grandfathered_299",
        );
        expect(
            selectPrimaryStripePriceId(
                [{ stripePriceId: "price_current_399" }, ...items],
                config,
            ),
        ).toBe("price_current_399");
        // Without any known price, the first non-seat item wins; a lone seat
        // item is the last resort so the stored price is never blanked.
        expect(
            selectPrimaryStripePriceId(
                [
                    { stripePriceId: "price_seat_199" },
                    { stripePriceId: "price_other" },
                ],
                config,
            ),
        ).toBe("price_other");
        expect(
            selectPrimaryStripePriceId(
                [{ stripePriceId: "price_seat_199" }],
                config,
            ),
        ).toBe("price_seat_199");
        expect(selectPrimaryStripePriceId([], config)).toBeNull();
    });
});
