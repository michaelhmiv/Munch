#!/usr/bin/env bun

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

const body = {
  model: process.env.JEV_MODEL?.trim() || "~typesafe/jev-latest",
  temperature: 0,
  reasoning: { enabled: false },
  max_tokens: 160,
  messages: [
    {
      role: "system",
      content: "Choose the single food database candidate that best matches the user's context. Choose NO_MATCH if none is defensible. Return only the requested structured result."
    },
    {
      role: "user",
      content: JSON.stringify({
        query: "2% milk",
        context: "I drank one cup of plain 2% dairy milk.",
        candidates: [
          { key: "c0", name: "Milk, nonfat, fluid" },
          { key: "c1", name: "Milk, reduced fat, 2% milkfat, fluid" },
          { key: "c2", name: "Milk, whole, 3.25% milkfat, fluid" }
        ]
      })
    }
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "munch_food_decision",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["choice", "confidence"],
        properties: {
          choice: { type: "string", enum: ["c0", "c1", "c2", "NO_MATCH"] },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    }
  }
};

const started = performance.now();
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://munch.business",
    "X-OpenRouter-Title": "Munch Jev Probe"
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(30_000)
});
const durationMs = performance.now() - started;
const text = await response.text();
console.log("[jev_probe_http]", JSON.stringify({ status: response.status, ok: response.ok, durationMs: Math.round(durationMs) }));
if (!response.ok) {
  console.log("[jev_probe_error]", text.slice(0, 2000));
  process.exit(1);
}
const payload = JSON.parse(text);
const content = payload?.choices?.[0]?.message?.content;
console.log("[jev_probe_result]", JSON.stringify({
  requestedModel: body.model,
  resolvedModel: payload?.model ?? null,
  content,
  finishReason: payload?.choices?.[0]?.finish_reason ?? null,
  usage: payload?.usage ?? null
}));
if (!content) throw new Error("Jev response contained no message content");
const parsed = JSON.parse(content);
if (parsed.choice !== "c1") throw new Error(`Expected c1, got ${parsed.choice}`);
if (typeof parsed.confidence !== "number") throw new Error("Missing confidence");
