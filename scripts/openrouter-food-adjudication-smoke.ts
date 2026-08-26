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

interface PreparedCandidate {
    index: number;
    name: string;
    brand: string | null;
    data_kind: string;
    confidence: number;
    portions: string[];
    calories_per_100g: number | null;
}

interface PreparedCase {
    id: string;
    query: string;
    context: string;
    candidates: PreparedCandidate[];
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

function candidatePasses(
    definition: CaseDefinition,
    candidate: PreparedCandidate,
): boolean {
    const name = normalized(candidate.name);
    return (
        definition.required.every((token) =>
            name.includes(normalized(token)),
        ) &&
        definition.forbidden.every(
            (token) => !name.includes(normalized(token)),
        )
    );
}

async function prepareCase(definition: CaseDefinition): Promise<PreparedCase> {
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
    if (!candidates.some((candidate) => candidatePasses(definition, candidate))) {
        throw new Error(
            `${definition.id} retrieval omitted an acceptable candidate: ${candidates
                .map((candidate) => candidate.name)
                .join(" | ")}`,
        );
    }
    return {
        id: definition.id,
        query: definition.query,
        context: definition.context,
        candidates,
    };
}

async function askLuna(preparedCase: PreparedCase): Promise<{
    selected_index: number;
    confidence: number;
}> {
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
                        "You are selecting a factual food database candidate for Munch. The database has already retrieved plausible candidates; your job is semantic interpretation. Use every explicit fact in the user's context, especially quantity, unit, preparation, food form, brand, and anything the user says is logged separately. Do not assume candidate 0 is correct. Prefer the candidate that satisfies the stated facts while introducing the fewest unsupported assumptions or extra ingredients/modifiers. Do not infer an unmentioned flavor, ingredient, preparation, subtype, or brand. Use portion labels as evidence when they help distinguish forms. Select exactly one provided candidate and do not invent a new food.",
                },
                {
                    role: "user",
                    content: JSON.stringify(preparedCase),
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
                        required: ["selected_index", "confidence"],
                        properties: {
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
        }),
        signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
        throw new Error(
            `OpenRouter food adjudication failed for ${preparedCase.id}: ${response.status} ${(await response.text()).slice(0, 1000)}`,
        );
    }

    const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error(`OpenRouter returned no content for ${preparedCase.id}`);
    }
    const parsed = JSON.parse(content) as {
        selected_index?: number;
        confidence?: number;
    };
    if (!Number.isInteger(parsed.selected_index)) {
        throw new Error(`Luna omitted selected_index for ${preparedCase.id}`);
    }
    return {
        selected_index: parsed.selected_index!,
        confidence:
            typeof parsed.confidence === "number" ? parsed.confidence : 0,
    };
}

const results: Array<Record<string, unknown>> = [];
const failures: string[] = [];

for (const definition of CASES) {
    const preparedCase = await prepareCase(definition);
    const startedAt = performance.now();
    try {
        const selection = await askLuna(preparedCase);
        const chosen = preparedCase.candidates[selection.selected_index];
        if (!chosen) {
            throw new Error(
                `selected invalid index ${selection.selected_index} (candidate count ${preparedCase.candidates.length})`,
            );
        }
        const ok = candidatePasses(definition, chosen);
        results.push({
            id: definition.id,
            query: definition.query,
            context: definition.context,
            selected_index: selection.selected_index,
            selected_name: chosen.name,
            confidence: selection.confidence,
            duration_ms: Number((performance.now() - startedAt).toFixed(2)),
            ok,
            candidate_names: preparedCase.candidates.map(
                (candidate) => candidate.name,
            ),
        });
        if (!ok) {
            failures.push(`${definition.id}: ${chosen.name}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
            id: definition.id,
            query: definition.query,
            context: definition.context,
            duration_ms: Number((performance.now() - startedAt).toFixed(2)),
            ok: false,
            error: message,
            candidate_names: preparedCase.candidates.map(
                (candidate) => candidate.name,
            ),
        });
        failures.push(`${definition.id}: ${message}`);
    }
}

const passed = results.filter((result) => result.ok === true).length;
const report = { model, cases: results.length, passed, failures, results };
console.log(
    `[food_ai_adjudication] ${JSON.stringify({ model, cases: results.length, passed, failed: failures.length })}`,
);
console.log(JSON.stringify(report, null, 2));

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
    appendFileSync(
        summary,
        `\n### Luna food candidate adjudication\n\nModel: \`${model}\`\n\nPassed: **${passed}/${results.length}** independent contextual candidate selections.\n`,
    );
}

if (failures.length > 0) {
    throw new Error(
        `Luna food adjudication failed ${failures.length}/${results.length} cases: ${failures.join("; ")}`,
    );
}
