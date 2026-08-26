#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { foodCatalogConfig } from "../src/food-providers/catalog-config.js";
import { FoodCatalogRepository } from "../src/food-providers/catalog-repository.js";

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
    throw new Error(
        "OPENROUTER_API_KEY is required for Luna food adjudication",
    );
}

const model =
    process.env.MUNCH_FOOD_ADJUDICATION_MODEL?.trim() || "openai/gpt-5.6-luna";
const repository = new FoodCatalogRepository(foodCatalogConfig());

interface CaseDefinition {
    id: string;
    query: string;
    context: string;
    required: string[];
    forbidden: string[];
}

const CASES: CaseDefinition[] = [
    {
        id: "bacon-strips",
        query: "bacon",
        context: "I ate 3 strips of bacon with breakfast.",
        required: ["bacon"],
        forbidden: ["bit", "canadian"],
    },
    {
        id: "bacon-bits",
        query: "bacon",
        context: "I added 2 tablespoons of bacon bits to a salad.",
        required: ["bacon", "bit"],
        forbidden: [],
    },
    {
        id: "diced-onion",
        query: "onion",
        context: "The recipe used 1 medium onion, diced.",
        required: ["onion"],
        forbidden: ["gravy", "mix", "ring"],
    },
    {
        id: "white-rice",
        query: "white rice",
        context: "I ate 1 cup of cooked white rice.",
        required: ["rice"],
        forbidden: ["flour", "bean"],
    },
    {
        id: "plain-walnuts",
        query: "walnuts",
        context: "I ate 1 ounce of plain walnuts as a snack.",
        required: ["walnut"],
        forbidden: ["glazed", "honey"],
    },
    {
        id: "salmon-fillet",
        query: "salmon",
        context: "Dinner included a 6 ounce grilled salmon fillet.",
        required: ["salmon"],
        forbidden: ["salad"],
    },
    {
        id: "blueberries",
        query: "blueberries",
        context: "I ate 1 cup of fresh blueberries.",
        required: ["blueberr"],
        forbidden: ["juice", "milk"],
    },
    {
        id: "cooked-spaghetti",
        query: "spaghetti",
        context:
            "I ate 2 cups of cooked spaghetti noodles with sauce logged separately.",
        required: ["spaghetti"],
        forbidden: ["spinach", "squash", "meatball"],
    },
    {
        id: "whole-egg",
        query: "egg",
        context: "Breakfast included 1 large whole egg.",
        required: ["egg"],
        forbidden: ["yolk", "dried"],
    },
    {
        id: "chicken-thigh",
        query: "chicken thigh",
        context: "I ate one grilled boneless skinless chicken thigh.",
        required: ["chicken", "thigh"],
        forbidden: ["breaded", "reheated"],
    },
    {
        id: "two-percent-milk",
        query: "2% milk",
        context: "I drank 1 cup of 2% dairy milk.",
        required: ["milk"],
        forbidden: ["yogurt", "rennin", "mix"],
    },
    {
        id: "skim-milk",
        query: "skim milk",
        context: "I used 1 cup of skim milk in the recipe.",
        required: ["milk"],
        forbidden: ["yogurt"],
    },
];

function normalized(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

const prepared = [] as Array<{
    id: string;
    query: string;
    context: string;
    candidates: Array<{
        index: number;
        name: string;
        brand: string | null;
        data_kind: string;
        confidence: number;
        portions: string[];
        calories_per_100g: number | null;
    }>;
}>;

for (const definition of CASES) {
    const hits = await repository.searchLocal(definition.query, 8);
    if (hits.length < 2) {
        throw new Error(
            `${definition.id} returned only ${hits.length} local candidates; semantic adjudication needs alternatives`,
        );
    }
    const candidates = hits.map((hit, index) => ({
        index,
        name: hit.candidate.name,
        brand: hit.candidate.brand ?? null,
        data_kind: hit.candidate.dataKind,
        confidence: hit.candidate.confidence,
        portions: hit.candidate.portions
            .slice(0, 5)
            .map((portion) => portion.label),
        calories_per_100g: hit.candidate.nutrientsPer100g?.calories ?? null,
    }));
    const hasAcceptable = candidates.some((candidate) => {
        const name = normalized(candidate.name);
        return (
            definition.required.every((token) =>
                name.includes(normalized(token)),
            ) &&
            definition.forbidden.every(
                (token) => !name.includes(normalized(token)),
            )
        );
    });
    if (!hasAcceptable) {
        throw new Error(
            `${definition.id} retrieval omitted an acceptable candidate: ${candidates
                .map((candidate) => candidate.name)
                .join(" | ")}`,
        );
    }
    prepared.push({
        id: definition.id,
        query: definition.query,
        context: definition.context,
        candidates,
    });
}

const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://munch.business",
        "X-Title": "Munch food adjudication CI",
    },
    body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
            {
                role: "system",
                content:
                    "You are the semantic food-candidate adjudicator for Munch. The application has already retrieved factual food database candidates. For each case, choose exactly one candidate index using the user's complete context, especially quantity, unit, preparation, food form, and brand. Do not assume index 0 is correct. Do not invent a candidate. A tablespoon of bacon bits and strips of bacon are different foods; use the context and portion labels. Return only the requested JSON.",
            },
            {
                role: "user",
                content: JSON.stringify({ cases: prepared }),
            },
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "munch_food_adjudication",
                strict: true,
                schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["selections"],
                    properties: {
                        selections: {
                            type: "array",
                            items: {
                                type: "object",
                                additionalProperties: false,
                                required: [
                                    "id",
                                    "selected_index",
                                    "confidence",
                                ],
                                properties: {
                                    id: { type: "string" },
                                    selected_index: {
                                        type: "integer",
                                        minimum: 0,
                                    },
                                    confidence: {
                                        type: "number",
                                        minimum: 0,
                                        maximum: 1,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    }),
    signal: AbortSignal.timeout(60_000),
});

if (!response.ok) {
    throw new Error(
        `OpenRouter food adjudication failed: ${response.status} ${(await response.text()).slice(0, 1000)}`,
    );
}

const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
};
const content = payload.choices?.[0]?.message?.content;
if (!content) throw new Error("OpenRouter returned no adjudication content");
const parsed = JSON.parse(content) as {
    selections?: Array<{
        id?: string;
        selected_index?: number;
        confidence?: number;
    }>;
};
if (!Array.isArray(parsed.selections)) {
    throw new Error("Luna adjudication returned no selections array");
}

const byId = new Map(
    parsed.selections.map((selection) => [selection.id, selection]),
);
const results: Array<Record<string, unknown>> = [];
for (const definition of CASES) {
    const selection = byId.get(definition.id);
    const preparedCase = prepared.find((item) => item.id === definition.id)!;
    if (!selection || !Number.isInteger(selection.selected_index)) {
        throw new Error(`Luna omitted selection for ${definition.id}`);
    }
    const chosen = preparedCase.candidates[selection.selected_index!];
    if (!chosen) {
        throw new Error(
            `Luna selected invalid index ${selection.selected_index} for ${definition.id}`,
        );
    }
    const name = normalized(chosen.name);
    const ok =
        definition.required.every((token) =>
            name.includes(normalized(token)),
        ) &&
        definition.forbidden.every(
            (token) => !name.includes(normalized(token)),
        );
    results.push({
        id: definition.id,
        query: definition.query,
        context: definition.context,
        selected_index: selection.selected_index,
        selected_name: chosen.name,
        confidence: selection.confidence ?? null,
        ok,
        candidate_names: preparedCase.candidates.map(
            (candidate) => candidate.name,
        ),
    });
    if (!ok) {
        throw new Error(
            `Luna chose an implausible candidate for ${definition.id}: ${chosen.name}`,
        );
    }
}

const report = {
    model,
    cases: results.length,
    passed: results.length,
    results,
};
console.log(
    `[food_ai_adjudication] ${JSON.stringify({ model, cases: results.length, passed: results.length })}`,
);
console.log(JSON.stringify(report, null, 2));

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
    appendFileSync(
        summary,
        `\n### Luna food candidate adjudication\n\nModel: \`${model}\`\n\nPassed: **${results.length}/${results.length}** contextual candidate selections.\n`,
    );
}
