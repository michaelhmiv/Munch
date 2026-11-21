import { describe, expect, test } from "bun:test";
import type { DatabaseTransaction } from "../platform/database.js";
import { insertWater } from "../nutrition-platform/water.js";
import { insertWeight } from "../nutrition-platform/weight.js";
import type { WaterInput, WeightInput } from "../nutrition-platform/types.js";
import {
    optionalIdempotencyKey,
    waterCreateInputFromBody,
    weightCreateInputFromBody,
} from "./routes.js";

/**
 * Finding 5 (W2 logging math): POST /api/app/water and
 * POST /api/app/weight dropped the client's idempotency_key, and the
 * web client never sent one — so a retried submit always inserted a
 * second row (the server-derived key mixes in a fresh loggedAt per
 * call). The route now forwards a stable per-form-instance key via
 * waterCreateInputFromBody / weightCreateInputFromBody, and
 * insertWater / insertWeight accept an injectable transaction runner
 * so the dedup contract is unit-testable without a database.
 */

interface FakeRow {
    id: string;
    user_id: string;
    amount_ml?: number;
    weight_g?: number;
    logged_at: string;
    notes: string | null;
    created_at: string;
    idempotency_key: string | null;
}

/** In-memory stand-in for the (user_id, idempotency_key) partial
 * unique index + `on conflict do nothing` insert used by both logs. */
function createFakeLogStore() {
    const rows = new Map<string, FakeRow>();
    let sequence = 0;

    function makeTx(kind: "water" | "weight") {
        const table =
            kind === "water" ? "munch.water_logs" : "munch.weight_logs";
        return async (
            strings: TemplateStringsArray,
            ...values: unknown[]
        ): Promise<FakeRow[]> => {
            const sql = strings.join(" ").replace(/\s+/g, " ");
            if (sql.includes(`insert into ${table}`)) {
                const [userId, amount, loggedAt, notes, idempotencyKey] =
                    values as [string, number, string, string | null, string];
                const key = `${userId}:${idempotencyKey}`;
                if (rows.has(key)) return [];
                sequence += 1;
                const row: FakeRow = {
                    id: `${kind}-${sequence}`,
                    user_id: userId,
                    ...(kind === "water"
                        ? { amount_ml: amount }
                        : { weight_g: amount }),
                    logged_at: loggedAt,
                    notes: notes ?? null,
                    created_at: loggedAt,
                    idempotency_key: idempotencyKey,
                };
                rows.set(key, row);
                return [row];
            }
            if (sql.includes(`from ${table}`)) {
                const [userId, idempotencyKey] = values as [string, string];
                const row = rows.get(`${userId}:${idempotencyKey}`);
                return row ? [row] : [];
            }
            throw new Error(`Unexpected SQL in fake log store: ${sql}`);
        };
    }

    return {
        rows,
        runInTx(kind: "water" | "weight") {
            const tx = makeTx(kind);
            return async <T>(
                _userId: string,
                callback: (tx: DatabaseTransaction) => Promise<T>,
            ): Promise<T> => callback(tx as unknown as DatabaseTransaction);
        },
    };
}

describe("optionalIdempotencyKey", () => {
    test("absent values stay absent", () => {
        expect(optionalIdempotencyKey(undefined, "Water idempotency key")).toBe(
            undefined,
        );
        expect(optionalIdempotencyKey(null, "Water idempotency key")).toBe(
            undefined,
        );
        expect(optionalIdempotencyKey("", "Water idempotency key")).toBe(
            undefined,
        );
    });

    test("trims and returns a valid key", () => {
        expect(
            optionalIdempotencyKey("  water-form-1  ", "Water idempotency key"),
        ).toBe("water-form-1");
    });

    test("invalid or oversized idempotency_key is rejected", () => {
        expect(() =>
            optionalIdempotencyKey(123, "Water idempotency key"),
        ).toThrow("Water idempotency key is invalid");
        expect(() =>
            optionalIdempotencyKey("   ", "Water idempotency key"),
        ).toThrow("Water idempotency key is invalid");
        expect(() =>
            optionalIdempotencyKey("x".repeat(256), "Weight idempotency key"),
        ).toThrow("Weight idempotency key is invalid");
    });
});

describe("Finding 5 — water idempotency", () => {
    test("submitting water twice with the same form idempotency_key creates one entry", async () => {
        const store = createFakeLogStore();
        const input: WaterInput = waterCreateInputFromBody({
            amount_ml: 355,
            notes: "morning",
            idempotency_key: "water-form-1",
        });
        expect(input.idempotency_key).toBe("water-form-1");

        const runInTx = store.runInTx("water");
        const first = await insertWater("user-1", input, runInTx);
        const second = await insertWater("user-1", input, runInTx);

        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(true);
        expect(second.entry.id).toBe(first.entry.id);
        expect(store.rows.size).toBe(1);
    });

    test("distinct form idempotency keys create distinct entries for identical water values", async () => {
        const store = createFakeLogStore();
        const runInTx = store.runInTx("water");
        const first = await insertWater(
            "user-1",
            waterCreateInputFromBody({
                amount_ml: 355,
                idempotency_key: "water-form-1",
            }),
            runInTx,
        );
        const second = await insertWater(
            "user-1",
            waterCreateInputFromBody({
                amount_ml: 355,
                idempotency_key: "water-form-2",
            }),
            runInTx,
        );
        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(false);
        expect(second.entry.id).not.toBe(first.entry.id);
        expect(store.rows.size).toBe(2);
    });

    test("invalid water amount is still rejected before insert", () => {
        expect(() => waterCreateInputFromBody({ amount_ml: 0 })).toThrow(
            "Invalid water amount",
        );
        expect(() =>
            waterCreateInputFromBody({
                amount_ml: 355,
                idempotency_key: 42,
            }),
        ).toThrow("Water idempotency key is invalid");
    });
});

describe("Finding 5 — weight idempotency", () => {
    test("submitting weight twice with the same form idempotency_key creates one entry", async () => {
        const store = createFakeLogStore();
        const input: WeightInput = weightCreateInputFromBody({
            weight: 180,
            unit: "lb",
            idempotency_key: "weight-form-1",
        });
        expect(input.idempotency_key).toBe("weight-form-1");
        expect(input.weight_g).toBe(81647);

        const runInTx = store.runInTx("weight");
        const first = await insertWeight("user-1", input, runInTx);
        const second = await insertWeight("user-1", input, runInTx);

        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(true);
        expect(second.entry.id).toBe(first.entry.id);
        expect(store.rows.size).toBe(1);
    });

    test("distinct form idempotency keys create distinct entries for identical weight values", async () => {
        const store = createFakeLogStore();
        const runInTx = store.runInTx("weight");
        const first = await insertWeight(
            "user-1",
            weightCreateInputFromBody({
                weight: 180,
                unit: "lb",
                idempotency_key: "weight-form-1",
            }),
            runInTx,
        );
        const second = await insertWeight(
            "user-1",
            weightCreateInputFromBody({
                weight: 180,
                unit: "lb",
                idempotency_key: "weight-form-2",
            }),
            runInTx,
        );
        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(false);
        expect(second.entry.id).not.toBe(first.entry.id);
        expect(store.rows.size).toBe(2);
    });

    test("invalid weight is still rejected before insert", () => {
        expect(() =>
            weightCreateInputFromBody({ weight: -1, unit: "lb" }),
        ).toThrow("Invalid weight");
        expect(() =>
            weightCreateInputFromBody({
                weight: 180,
                unit: "lb",
                idempotency_key: 42,
            }),
        ).toThrow("Weight idempotency key is invalid");
    });
});
