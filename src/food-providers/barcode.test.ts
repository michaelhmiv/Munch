import { describe, expect, test } from "bun:test";
import { isValidGtin, normalizeGtin } from "./barcode.js";

describe("canonical GTIN validation", () => {
    test("accepts known valid UPC-A and EAN-13 values", () => {
        expect(normalizeGtin("049000028904")).toBe("049000028904");
        expect(normalizeGtin("028400090896")).toBe("028400090896");
        expect(normalizeGtin("4099100316896")).toBe("4099100316896");
    });

    test("normalizes separators without changing the check digit", () => {
        expect(normalizeGtin("0 49000-028904")).toBe("049000028904");
    });

    test("rejects the all-zero sentinel and invalid check digits", () => {
        expect(normalizeGtin("000000000000")).toBeNull();
        expect(normalizeGtin("049000028905")).toBeNull();
        expect(isValidGtin("028400090897")).toBe(false);
    });

    test("accepts only standard GTIN lengths", () => {
        expect(normalizeGtin("12345678901")).toBeNull();
        expect(normalizeGtin("123456789012345")).toBeNull();
    });
});
