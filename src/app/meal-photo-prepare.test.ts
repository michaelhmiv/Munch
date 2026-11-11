import { describe, expect, test } from "bun:test";
import { clientPrepareMsLogField } from "./routes.js";

/**
 * client_prepare_ms is client-reported telemetry for the
 * `[meal_photo] phase=receive` line (photo-prepare speed, Nov 11):
 * it exists so the client-prep/server split is visible in the log.
 * It is never trusted for logic, so only a clean digits-only
 * non-negative integer renders as a field; anything else is dropped.
 */
describe("clientPrepareMsLogField", () => {
    test("a valid duration renders as a log field", () => {
        expect(clientPrepareMsLogField("1234")).toBe(" client_prepare_ms=1234");
        expect(clientPrepareMsLogField("0")).toBe(" client_prepare_ms=0");
    });

    test("missing and non-string values render nothing", () => {
        expect(clientPrepareMsLogField(undefined)).toBe("");
        expect(clientPrepareMsLogField(null)).toBe("");
        expect(clientPrepareMsLogField(1234)).toBe("");
        expect(clientPrepareMsLogField("")).toBe("");
    });

    test("malformed, negative, and fractional values render nothing", () => {
        expect(clientPrepareMsLogField("-5")).toBe("");
        expect(clientPrepareMsLogField("12.5")).toBe("");
        expect(clientPrepareMsLogField(" 42")).toBe("");
        expect(clientPrepareMsLogField("42ms")).toBe("");
        expect(clientPrepareMsLogField("fast")).toBe("");
    });

    test("integers beyond the safe range render nothing", () => {
        expect(clientPrepareMsLogField("99999999999999999999999999")).toBe("");
    });
});
