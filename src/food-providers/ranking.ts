import { nutrientCompleteness } from "./nutrients.js";
import type { FoodCandidate, FoodSearchInput } from "./types.js";

const NEUTRAL_DESCRIPTOR_TOKENS = new Set([
    "raw",
    "cooked",
    "fresh",
    "frozen",
    "plain",
    "nfs",
    "ns",
    "prepared",
    "unenriched",
    "whole",
    "fluid",
    "boneless",
    "skinless",
    "table",
    "fish",
    "spice",
    "nut",
]);

const COMPOSITE_FOOD_TOKENS = new Set([
    "salad",
    "sandwich",
    "pie",
    "chip",
    "cookie",
    "wafer",
    "granola",
    "dessert",
    "soup",
    "cake",
    "cereal",
    "pizza",
    "casserole",
    "dip",
    "dressing",
    "powder",
    "flour",
    "cracker",
    "yogurt",
    "custard",
    "pancake",
    "bagel",
    "raisin",
    "meatless",
    "tofu",
    "cheese",
    "bean",
    "babyfood",
    "ring",
    "pudding",
    "bread",
    "turkey",
    "mix",
    "gravy",
    "bun",
    "sauce",
    "stick",
    "pickled",
    "breaded",
    "reheated",
    "prepackaged",
    "honey",
    "roasted",
    "dried",
    "yolk",
    "white",
    "pita",
    "spaghetti",
    "macaroni",
    "vegetable",
    "raab",
    "light",
    "cream",
    "beef",
    "juice",
    "concentrate",
    "canned",
    "bit",
    "glazed",
    "spinach",
    "tuna",
    "chinese",
    "canadian",
    "squash",
    "chili",
    "muffin",
    "meatball",
    "dinner",
    "meal",
    "vegetable",
]);

export function normalizeFoodText(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function singularToken(token: string): string {
    if (token.length > 4 && token.endsWith("ies")) {
        return `${token.slice(0, -3)}y`;
    }
    if (token.length > 4 && token.endsWith("oes")) {
        return token.slice(0, -2);
    }
    if (
        token.length > 3 &&
        token.endsWith("s") &&
        !token.endsWith("ss") &&
        !token.endsWith("us")
    ) {
        return token.slice(0, -1);
    }
    return token;
}

function normalizedTokens(value: string): string[] {
    return normalizeFoodText(value)
        .split(" ")
        .filter(Boolean)
        .map(singularToken);
}

function comparisonTokens(value: string, queryTokens: Set<string>): string[] {
    return normalizedTokens(value).filter(
        (token) =>
            queryTokens.has(token) || !NEUTRAL_DESCRIPTOR_TOKENS.has(token),
    );
}

function tokenFit(
    query: string,
    value: string,
): {
    recall: number;
    precision: number;
} {
    const queryTokens = new Set(normalizedTokens(query));
    if (queryTokens.size === 0) return { recall: 0, precision: 0 };
    const candidateTokens = new Set(comparisonTokens(value, queryTokens));
    let matches = 0;
    for (const token of queryTokens) {
        if (candidateTokens.has(token)) matches += 1;
    }
    return {
        recall: matches / queryTokens.size,
        precision:
            candidateTokens.size === 0 ? 0 : matches / candidateTokens.size,
    };
}

function datasetPreference(candidate: FoodCandidate): number {
    if (candidate.provider !== "usda" || candidate.dataKind !== "generic") {
        return 0;
    }
    const dataset = candidate.raw?.dataset;
    if (dataset === "foundation") return 0.09;
    if (dataset === "sr_legacy") return 0.08;
    if (dataset === "survey") return 0.01;
    return 0.03;
}

function unexpectedCompositeCount(
    query: string,
    candidate: FoodCandidate,
): number {
    const queryTokens = new Set(normalizedTokens(query));
    const nameTokens = new Set(normalizedTokens(candidate.name));
    let count = 0;
    for (const token of COMPOSITE_FOOD_TOKENS) {
        if (!queryTokens.has(token) && nameTokens.has(token)) count += 1;
    }
    return count;
}

function compositePenalty(query: string, candidate: FoodCandidate): number {
    return Math.min(0.48, unexpectedCompositeCount(query, candidate) * 0.12);
}

function leadingIngredientBonus(
    query: string,
    candidate: FoodCandidate,
): number {
    if (unexpectedCompositeCount(query, candidate) > 0) return 0;
    const queryTokens = new Set(normalizedTokens(query));
    const leading = normalizedTokens(candidate.name)[0];
    if (!leading || !queryTokens.has(leading)) return 0;
    return 0.08;
}

export function candidateIdentity(candidate: FoodCandidate): string {
    if (candidate.barcode) return `barcode:${candidate.barcode}`;
    return [
        normalizeFoodText(candidate.brand ?? ""),
        normalizeFoodText(candidate.name),
        candidate.dataKind,
    ].join("|");
}

export function deduplicateCandidates(
    candidates: FoodCandidate[],
): FoodCandidate[] {
    const best = new Map<string, FoodCandidate>();
    for (const candidate of candidates) {
        const key = candidateIdentity(candidate);
        const existing = best.get(key);
        if (!existing || candidate.confidence > existing.confidence) {
            best.set(key, candidate);
        }
    }
    return [...best.values()];
}

export function scoreCandidate(
    input: Pick<FoodSearchInput, "query">,
    candidate: FoodCandidate,
): number {
    const query = normalizeFoodText(input.query);
    const name = normalizeFoodText(candidate.name);
    const brandedName = normalizeFoodText(
        `${candidate.brand ?? ""} ${candidate.name}`,
    );
    const exactName = query !== "" && query === name ? 1 : 0;
    const exactBrandAndName = query !== "" && query === brandedName ? 1 : 0;
    const nameFit = tokenFit(query, candidate.name);
    const brandedFit = tokenFit(
        query,
        `${candidate.brand ?? ""} ${candidate.name}`,
    );
    const recall = Math.max(nameFit.recall, brandedFit.recall);
    const precision = Math.max(nameFit.precision, brandedFit.precision);
    const phraseMatch =
        query !== "" && (name.includes(query) || brandedName.includes(query))
            ? 1
            : 0;
    const portionQuality = candidate.portions.length > 0 ? 1 : 0;
    const nutrients =
        candidate.portions[0]?.nutrients ?? candidate.nutrientsPer100g ?? {};
    const completeness = nutrientCompleteness(nutrients);
    const providerPreference = candidate.provider === "usda" ? 0.01 : 0;
    const genericPreference = candidate.dataKind === "generic" ? 0.07 : 0;
    const packagedPenalty =
        candidate.dataKind === "packaged" && !exactBrandAndName ? 0.04 : 0;

    return (
        exactBrandAndName * 0.42 +
        exactName * 0.34 +
        recall * 0.28 +
        precision * 0.24 +
        phraseMatch * 0.06 +
        leadingIngredientBonus(query, candidate) +
        candidate.confidence * 0.1 +
        completeness * 0.04 +
        portionQuality * 0.01 +
        providerPreference +
        genericPreference +
        datasetPreference(candidate) -
        compositePenalty(query, candidate) -
        packagedPenalty
    );
}

export function rankCandidates(
    input: Pick<FoodSearchInput, "query">,
    candidates: FoodCandidate[],
): FoodCandidate[] {
    return deduplicateCandidates(candidates)
        .map((candidate, index) => ({
            candidate,
            index,
            score: scoreCandidate(input, candidate),
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(({ candidate }) => candidate);
}
