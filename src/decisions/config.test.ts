import { describe, expect, test } from "bun:test";
import {
    decisionsConfig,
    gateFoodThresholdForModel,
    shortfallCheckEnabled,
    shortfallCheckTimeoutMs,
    shortfallContradictionThresholdForModel,
    DEFAULT_DECIDER_FALLBACK_MODELS,
    DEFAULT_DECIDER_MODEL,
    DEFAULT_GATE_FOOD_MIN,
    DEFAULT_SHORTFALL_CONTRADICTION_MIN,
} from "./config.js";

const KEY = { OPENROUTER_API_KEY: "test-key" };

describe("decisionsConfig flags (S1/S2 ship OFF)", () => {
    test("no OpenRouter key -> null (seats cannot run)", () => {
        expect(decisionsConfig({})).toBeNull();
        expect(decisionsConfig({ OPENROUTER_API_KEY: "  " })).toBeNull();
    });

    test("defaults: master unset -> both seats OFF", () => {
        const config = decisionsConfig({ ...KEY });
        expect(config).not.toBeNull();
        expect(config!.gateEnabled).toBe(false);
        expect(config!.deciderEnabled).toBe(false);
    });

    test("master on enables both seats", () => {
        const config = decisionsConfig({
            ...KEY,
            MUNCH_JEV_ENABLED: "true",
        });
        expect(config!.gateEnabled).toBe(true);
        expect(config!.deciderEnabled).toBe(true);
    });

    test("a seat enables independently of the master", () => {
        const config = decisionsConfig({
            ...KEY,
            MUNCH_JEV_GATE_ENABLED: "true",
        });
        expect(config!.gateEnabled).toBe(true);
        expect(config!.deciderEnabled).toBe(false);
    });

    test("an explicit seat off wins over the master (per-seat kill)", () => {
        const config = decisionsConfig({
            ...KEY,
            MUNCH_JEV_ENABLED: "true",
            MUNCH_JEV_DECIDER_ENABLED: "false",
        });
        expect(config!.gateEnabled).toBe(true);
        expect(config!.deciderEnabled).toBe(false);
    });

    test("master off value does not enable anything", () => {
        const config = decisionsConfig({
            ...KEY,
            MUNCH_JEV_ENABLED: "off",
        });
        expect(config!.gateEnabled).toBe(false);
        expect(config!.deciderEnabled).toBe(false);
    });
});

describe("decisionsConfig model chain", () => {
    test("default chain is the bake-off designation, in order", () => {
        const config = decisionsConfig({ ...KEY });
        expect(config!.models).toEqual([
            DEFAULT_DECIDER_MODEL,
            ...DEFAULT_DECIDER_FALLBACK_MODELS.split(","),
        ]);
        expect(config!.models[0]).toBe("typesafe/jev-1.14");
        expect(config!.models[1]).toBe("perplexity/pplx-decider-v1.2");
        // liquid/d1-ultra was removed from the default chain on
        // Nov 11 (retention/training terms; Michael's ruling).
        expect(config!.models).toHaveLength(2);
        expect(config!.models).not.toContain("liquid/d1-ultra");
    });

    test("env overrides primary + fallbacks; blanks and dupes dropped", () => {
        const config = decisionsConfig({
            ...KEY,
            MUNCH_DECIDER_MODEL: "typesafe/jev-1.13",
            MUNCH_DECIDER_FALLBACK_MODELS:
                " typesafe/jev-1.13 ,, perplexity/pplx-decider-v1.2 ",
        });
        expect(config!.models).toEqual([
            "typesafe/jev-1.13",
            "perplexity/pplx-decider-v1.2",
        ]);
    });

    test("an explicitly empty fallback list means primary only", () => {
        const config = decisionsConfig({
            ...KEY,
            MUNCH_DECIDER_FALLBACK_MODELS: "",
        });
        expect(config!.models).toEqual(["typesafe/jev-1.14"]);
    });
});

describe("decisionsConfig timeouts (brief defaults 1500 / 2000)", () => {
    test("defaults + bounds", () => {
        const config = decisionsConfig({ ...KEY });
        expect(config!.gateTimeoutMs).toBe(1_500);
        expect(config!.deciderTimeoutMs).toBe(2_000);
        const custom = decisionsConfig({
            ...KEY,
            MUNCH_JEV_GATE_TIMEOUT_MS: "900",
            MUNCH_JEV_DECIDER_TIMEOUT_MS: "not-a-number",
        });
        expect(custom!.gateTimeoutMs).toBe(900);
        expect(custom!.deciderTimeoutMs).toBe(2_000);
        const floored = decisionsConfig({
            ...KEY,
            MUNCH_JEV_GATE_TIMEOUT_MS: "5",
        });
        expect(floored!.gateTimeoutMs).toBe(100);
    });
});

describe("C2 shortfall-check seat flag (MUNCH_JEV_SHORTFALL_CHECK_ENABLED)", () => {
    test("defaults off; master on enables; explicit seat off wins", () => {
        expect(shortfallCheckEnabled(decisionsConfig({ ...KEY })!)).toBe(false);
        expect(
            shortfallCheckEnabled(
                decisionsConfig({ ...KEY, MUNCH_JEV_ENABLED: "true" })!,
            ),
        ).toBe(true);
        expect(
            shortfallCheckEnabled(
                decisionsConfig({
                    ...KEY,
                    MUNCH_JEV_ENABLED: "true",
                    MUNCH_JEV_SHORTFALL_CHECK_ENABLED: "false",
                })!,
            ),
        ).toBe(false);
        expect(
            shortfallCheckEnabled(
                decisionsConfig({
                    ...KEY,
                    MUNCH_JEV_SHORTFALL_CHECK_ENABLED: "true",
                })!,
            ),
        ).toBe(true);
    });

    test("timeout defaults to 2000ms and is bounded", () => {
        expect(shortfallCheckTimeoutMs(decisionsConfig({ ...KEY })!)).toBe(2_000);
        expect(
            shortfallCheckTimeoutMs(
                decisionsConfig({
                    ...KEY,
                    MUNCH_JEV_SHORTFALL_CHECK_TIMEOUT_MS: "900",
                })!,
            ),
        ).toBe(900);
    });

    test("per-model contradiction thresholds are calibrated entries, with the standard default", () => {
        expect(shortfallContradictionThresholdForModel("typesafe/jev-1.14")).toBe(0.5);
        expect(
            shortfallContradictionThresholdForModel("perplexity/pplx-decider-v1.2"),
        ).toBe(0.5);
        expect(shortfallContradictionThresholdForModel("example/unknown-1")).toBe(
            DEFAULT_SHORTFALL_CONTRADICTION_MIN,
        );
    });
});

describe("per-model gate thresholds (calibrated, never borrowed)", () => {
    test("every designated model carries the measured 0.10", () => {
        // Jev probe: positives min 0.71; pplx bake-off: negatives all
        // <= 0.011; d1-ultra bake-off: hottest negative 0.071 — 0.10
        // sits above all three negative distributions.
        expect(gateFoodThresholdForModel("typesafe/jev-1.14")).toBe(0.1);
        expect(gateFoodThresholdForModel("perplexity/pplx-decider-v1.2")).toBe(
            0.1,
        );
        expect(gateFoodThresholdForModel("liquid/d1-ultra")).toBe(0.1);
    });

    test("an unlisted slug falls back to the standard threshold", () => {
        expect(gateFoodThresholdForModel("example/unknown-1")).toBe(
            DEFAULT_GATE_FOOD_MIN,
        );
    });
});
