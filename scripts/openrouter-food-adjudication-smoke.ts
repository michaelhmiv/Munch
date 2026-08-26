#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { foodCatalogConfig } from "../src/food-providers/catalog-config.js";
import { FoodCatalogRepository } from "../src/food-providers/catalog-repository.js";
import type { FoodCandidate } from "../src/food-providers/types.js";

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
    userPhrase: string;
    context: string;
    required: string[];
    requiredAny?: string[];
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

interface PreparedSearch {
    search_query: string;
    candidates: PreparedCandidate[];
}

const CASES: CaseDefinition[] = [
    {
        id: "bacon-strips",
        userPhrase: "bacon",
        context: "I ate 3 strips of bacon with breakfast.",
        required: ["bacon"],
        forbidden: ["bit", "canadian", "meatless"],
    },
    {
        id: "bacon-bits",
        userPhrase: "bacon",
        context: "I added 2 tablespoons of bacon bits to a salad.",
        required: ["bacon", "bit"],
        forbidden: [],
    },
    {
        id: "diced-onion",
        userPhrase: "onion",
        context: "The recipe used 1 medium onion, diced.",
        required: ["onion"],
        forbidden: ["gravy", "mix", "ring", "powder", "dip", "bread", "soup"],
    },
    {
        id: "white-rice",
        userPhrase: "white rice",
        context: "I ate 1 cup of cooked white rice.",
        required: ["rice"],
        forbidden: ["flour", "bean"],
    },
    {
        id: "plain-walnuts",
        userPhrase: "walnuts",
        context: "I ate 1 ounce of plain walnuts as a snack.",
        required: ["walnut"],
        forbidden: ["glazed", "honey"],
    },
    {
        id: "salmon-fillet",
        userPhrase: "salmon",
        context: "Dinner included a 6 ounce grilled salmon fillet.",
        required: ["salmon"],
        forbidden: ["salad"],
    },
    {
        id: "blueberries",
        userPhrase: "blueberries",
        context: "I ate 1 cup of fresh blueberries.",
        required: ["blueberr"],
        forbidden: ["juice", "milk"],
    },
    {
        id: "cooked-spaghetti",
        userPhrase: "spaghetti",
        context:
            "I ate 2 cups of cooked spaghetti noodles with sauce logged separately.",
        required: ["cooked"],
        requiredAny: ["spaghetti", "noodle"],
        forbidden: [
            "spinach",
            "squash",
            "meatball",
            "sauce",
            "dry",
            "protein fortified",
        ],
    },
    {
        id: "whole-egg",
        userPhrase: "egg",
        context: "Breakfast included 1 large whole egg.",
        required: ["egg"],
        forbidden: ["yolk", "dried", "bread", "burrito", "soup"],
    },
    {
        id: "chicken-thigh",
        userPhrase: "chicken thigh",
        context: "I ate one grilled boneless skinless chicken thigh.",
        required: ["chicken", "thigh"],
        forbidden: ["breaded", "reheated", "coated"],
    },
    {
        id: "two-percent-milk",
        userPhrase: "2% milk",
        context: "I drank 1 cup of 2% dairy milk.",
        required: ["milk"],
        forbidden: ["yogurt", "rennin", "mix", "chocolate", "strawberry"],
    },
    {
        id: "skim-milk",
        userPhrase: "skim milk",
        context: "I used 1 cup of skim milk in the recipe.",
        required: ["milk"],
        forbidden: ["yogurt", "chocolate", "strawberry", "cheese"],
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
    const hasRequired = definition.required.every((token) =>
        name.includes(normalized(token)),
    );
    const hasRequiredAny =
        !definition.requiredAny?.length ||
        definition.requiredAny.some((token) =>
            name.includes(normalized(token)),
        );
    const avoidsForbidden = definition.forbidden.every(
        (token) => !name.includes(normalized(token)),
    );
    return hasRequired && hasRequiredAny && avoidsForbidden;
}

async function openRouterJson<T>(
    title: string,
    system: string,
    user: unknown,
    schemaName: string,
    schema: Record<string, unknown>,
): Promise<T> {
    const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                "HTTP-Referer": "https://munch.business",
                "X-Title": title,
            },
            body: JSON.stringify({
                model,
                temperature: 0,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: JSON.stringify(user) },
                ],
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: schemaName,
                        strict: true,
                        schema,
                    },
                },
            }),
            signal: AbortSignal.timeout(60_000),
        },
    );
    if (!response.ok) {
        throw new Error(
            `OpenRouter ${schemaName} failed: ${response.status} ${(await response.text()).slice(0, 1000)}`,
        );
    }
    const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content)
        throw new Error(`OpenRouter returned no ${schemaName} content`);
    return JSON.parse(content) as T;
}

async function askLunaForSearch(
    definition: CaseDefinition,
    previous: PreparedSearch,
): Promise<string> {
    const result = await openRouterJson<{ search_query: string }>(
        "Munch food search refinement CI",
        "You refine a nutrition-database search only after seeing that a broader food phrase did not return a reasonable match. Use the user's full context and the actual prior candidates. Database vocabulary may differ from conversational serving words, so do not mechanically copy every quantity or measurement term into the query. Keep the core food identity, add preparation or subtype facts only when they improve retrieval, and broaden or change wording when the previous query was too narrow or returned the wrong form. Do not invent an unmentioned brand, flavor, ingredient, species, or preparation. Return a short food search phrase, not an explanation.",
        {
            user_phrase: definition.userPhrase,
            context: definition.context,
            previous_search: previous,
        },
        "munch_food_search_query",
        {
            type: "object",
            additionalProperties: false,
            required: ["search_query"],
            properties: {
                search_query: { type: "string", minLength: 1, maxLength: 120 },
            },
        },
    );
    const query = result.search_query.trim();
    if (!query)
        throw new Error(
            `Luna returned an empty search query for ${definition.id}`,
        );
    return query;
}

function prepareCandidates(candidates: FoodCandidate[]): PreparedCandidate[] {
    return candidates.map((candidate, index) => ({
        index,
        name: candidate.name,
        brand: candidate.brand ?? null,
        data_kind: candidate.dataKind,
        confidence: candidate.confidence,
        portions: candidate.portions
            .slice(0, 5)
            .map((portion) => portion.label),
        calories_per_100g: candidate.nutrientsPer100g?.calories ?? null,
    }));
}

async function retrieve(searchQuery: string): Promise<PreparedSearch> {
    const hits = await repository.searchLocal(searchQuery, 10);
    return {
        search_query: searchQuery,
        candidates: prepareCandidates(hits.map((hit) => hit.candidate)),
    };
}

async function searchWithLuna(definition: CaseDefinition): Promise<{
    searches: PreparedSearch[];
    candidates: PreparedCandidate[];
}> {
    const searches: PreparedSearch[] = [];
    let result = await retrieve(definition.userPhrase);
    searches.push(result);

    if (
        result.candidates.some((candidate) =>
            candidatePasses(definition, candidate),
        )
    ) {
        return { searches, candidates: result.candidates };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const query = await askLunaForSearch(definition, result);
        result = await retrieve(query);
        searches.push(result);
        if (
            result.candidates.some((candidate) =>
                candidatePasses(definition, candidate),
            )
        ) {
            return { searches, candidates: result.candidates };
        }
    }

    const allCandidates = searches.flatMap((search) => search.candidates);
    throw new Error(
        `${definition.id} model-guided retrieval omitted an acceptable candidate after ${searches.length} searches: ${allCandidates
            .map((candidate) => candidate.name)
            .join(" | ")}`,
    );
}

async function askLunaToSelect(
    definition: CaseDefinition,
    searches: PreparedSearch[],
    candidates: PreparedCandidate[],
): Promise<{ selected_index: number; confidence: number }> {
    const result = await openRouterJson<{
        selected_index: number;
        confidence: number;
    }>(
        "Munch food adjudication CI",
        "You are selecting a factual food database candidate for Munch. Use every explicit fact in the user's context, especially quantity, unit, preparation, food form, brand, and anything logged separately. Candidate ordering is retrieval order, not a correctness ranking. Prefer the candidate that satisfies the stated facts while introducing the fewest unsupported assumptions or extra ingredients/modifiers. If no candidate exactly preserves every label word, a conservative generic candidate is preferable to a more specific candidate that invents an unmentioned subtype or ingredient. Do not infer an unmentioned flavor, ingredient, subtype, brand, or preparation. Use portion labels as evidence when useful. Select exactly one provided candidate and do not invent a new food.",
        {
            user_phrase: definition.userPhrase,
            context: definition.context,
            searches: searches.map((search) => search.search_query),
            candidates,
        },
        "munch_food_adjudication",
        {
            type: "object",
            additionalProperties: false,
            required: ["selected_index", "confidence"],
            properties: {
                selected_index: { type: "integer", minimum: 0 },
                confidence: { type: "number", minimum: 0, maximum: 1 },
            },
        },
    );
    if (!Number.isInteger(result.selected_index)) {
        throw new Error(`Luna omitted selected_index for ${definition.id}`);
    }
    return result;
}

const results: Array<Record<string, unknown>> = [];
const failures: string[] = [];

for (const definition of CASES) {
    const startedAt = performance.now();
    try {
        const { searches, candidates } = await searchWithLuna(definition);
        const selection = await askLunaToSelect(
            definition,
            searches,
            candidates,
        );
        const chosen = candidates[selection.selected_index];
        if (!chosen) {
            throw new Error(
                `selected invalid index ${selection.selected_index} (candidate count ${candidates.length})`,
            );
        }
        const ok = candidatePasses(definition, chosen);
        results.push({
            id: definition.id,
            user_phrase: definition.userPhrase,
            context: definition.context,
            search_queries: searches.map((search) => search.search_query),
            selected_index: selection.selected_index,
            selected_name: chosen.name,
            confidence: selection.confidence,
            duration_ms: Number((performance.now() - startedAt).toFixed(2)),
            ok,
            candidate_names: candidates.map((candidate) => candidate.name),
        });
        if (!ok) failures.push(`${definition.id}: ${chosen.name}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
            id: definition.id,
            user_phrase: definition.userPhrase,
            context: definition.context,
            duration_ms: Number((performance.now() - startedAt).toFixed(2)),
            ok: false,
            error: message,
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
        `\n### Luna food search + candidate adjudication\n\nModel: \`${model}\`\n\nPassed: **${passed}/${results.length}** contextual agent loops.\n`,
    );
}

if (failures.length > 0) {
    throw new Error(
        `Luna food agent loop failed ${failures.length}/${results.length} cases: ${failures.join("; ")}`,
    );
}
