#!/usr/bin/env bun

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

const body = {
    model: process.env.JEV_MODEL?.trim() || "~typesafe/jev-latest",
    state: {
        query: "2% milk",
        context: "I drank one cup of plain 2% dairy milk.",
    },
    questions: {
        best_candidate: {
            type: "choice",
            instructions:
                "Choose the single food database candidate that best matches the user's full context for nutrition logging. Choose NO_MATCH when every candidate materially conflicts.",
            criteria: {
                c0: "Milk, nonfat, fluid",
                c1: "Milk, reduced fat, 2% milkfat, fluid",
                c2: "Milk, whole, 3.25% milkfat, fluid",
                NO_MATCH: "None of the candidates is a defensible match.",
            },
        },
    },
};

const started = performance.now();
const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://munch.business",
        "X-OpenRouter-Title": "Munch Jev Probe",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
});
const durationMs = performance.now() - started;
const text = await response.text();
console.log(
    "[jev_probe_http]",
    JSON.stringify({
        status: response.status,
        ok: response.ok,
        durationMs: Math.round(durationMs),
    }),
);
if (!response.ok) {
    console.log("[jev_probe_error]", text.slice(0, 2000));
    process.exit(1);
}
const payload = JSON.parse(text);
const answer = payload?.answers?.best_candidate;
console.log(
    "[jev_probe_result]",
    JSON.stringify({
        requestedModel: body.model,
        resolvedModel: payload?.model ?? null,
        answer,
        usage: payload?.usage ?? null,
    }),
);
if (answer?.type !== "choice")
    throw new Error("Jev response contained no choice answer");
if (answer.choice !== "c1")
    throw new Error(`Expected c1, got ${answer.choice}`);
if (typeof answer.confidence !== "number")
    throw new Error("Missing confidence");
