import { describe, expect, test } from "bun:test";
import { appRouteErrorLogFields } from "./routes.js";

/**
 * Regression (2026-11-12): the app router's onError logged only
 * `{ name: error.name }`, which for a plain Error is the literal
 * string "Error" — a production 400 on the meal-draft answer route
 * was undiagnosable from the logs. The log fields must carry the
 * server's generated message.
 */
describe("appRouteErrorLogFields", () => {
    test("carries the error name and message", () => {
        expect(
            appRouteErrorLogFields(
                new Error(
                    'Answering item question "photo_portion_0" requires reconciling the affected canonical item first.',
                ),
            ),
        ).toEqual({
            name: "Error",
            message:
                'Answering item question "photo_portion_0" requires reconciling the affected canonical item first.',
        });
    });

    test("caps a pathological message at 300 characters", () => {
        const fields = appRouteErrorLogFields(new Error("x".repeat(1_000)));
        expect(fields.message).toHaveLength(300);
    });

    test("non-Error throwables still produce a message", () => {
        expect(appRouteErrorLogFields("boom")).toEqual({
            name: "NonError",
            message: "boom",
        });
    });
});
