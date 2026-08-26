import { describe, expect, test } from "bun:test";
import { certificationAuthIp } from "./auth-ip.js";

describe("production certification auth IP isolation", () => {
    test("assigns stable reserved test-network addresses", () => {
        expect(certificationAuthIp("food")).toBe(certificationAuthIp("food"));
        expect(certificationAuthIp("food")).toMatch(
            /^198\.51\.100\.(?:[1-9]\d?|1\d\d|20\d)$/,
        );
    });

    test("keeps certification phases in distinct auth-rate buckets", () => {
        const phases = ["food", "barcode", "recipes", "meal-recipe"];
        const addresses = phases.map(certificationAuthIp);
        expect(new Set(addresses).size).toBe(phases.length);
    });

    test("rejects an empty identity label", () => {
        expect(() => certificationAuthIp("   ")).toThrow();
    });
});
