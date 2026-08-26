#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { foodCatalogConfig } from "../src/food-providers/catalog-config.js";
import {
    FoodCatalogRepository,
    normalizeFoodText,
} from "../src/food-providers/catalog-repository.js";

const COMMON_FOODS = [
    "apple",
    "banana",
    "orange",
    "grapes",
    "strawberries",
    "blueberries",
    "raspberries",
    "blackberries",
    "pear",
    "peach",
    "plum",
    "pineapple",
    "mango",
    "watermelon",
    "cantaloupe",
    "kiwi",
    "avocado",
    "lemon",
    "lime",
    "carrots",
    "broccoli",
    "cauliflower",
    "spinach",
    "kale",
    "lettuce",
    "cabbage",
    "sweet potato",
    "potato",
    "tomato",
    "onion",
    "garlic",
    "bell pepper",
    "green beans",
    "peas",
    "corn",
    "asparagus",
    "zucchini",
    "squash",
    "cucumber",
    "celery",
    "mushrooms",
    "beets",
    "chicken breast",
    "chicken thigh",
    "turkey breast",
    "ground beef 90%",
    "ground beef 80%",
    "beef sirloin",
    "beef tenderloin",
    "pork chop",
    "pork tenderloin",
    "bacon",
    "ham",
    "salmon",
    "tuna",
    "cod",
    "shrimp",
    "tilapia",
    "egg",
    "egg white",
    "whole milk",
    "2% milk",
    "skim milk",
    "cheddar cheese",
    "mozzarella cheese",
    "cottage cheese",
    "ricotta cheese",
    "plain yogurt",
    "Greek yogurt",
    "butter",
    "cream cheese",
    "heavy cream",
    "white rice",
    "brown rice",
    "oats",
    "quinoa",
    "barley",
    "couscous",
    "spaghetti",
    "macaroni",
    "whole wheat bread",
    "white bread",
    "flour tortilla",
    "corn tortilla",
    "bagel",
    "English muffin",
    "black beans",
    "kidney beans",
    "chickpeas",
    "lentils",
    "peanuts",
    "peanut butter",
    "almonds",
    "walnuts",
    "cashews",
    "pistachios",
    "chia seeds",
    "flax seeds",
    "olive oil",
    "canola oil",
    "coconut oil",
    "mayonnaise",
    "ketchup",
    "mustard",
    "soy sauce",
    "vinegar",
    "salt",
    "black pepper",
    "paprika",
    "cumin",
    "oregano",
    "basil",
    "thyme",
    "rosemary",
    "cinnamon",
    "garlic powder",
    "onion powder",
    "baked potato",
    "mashed potatoes",
    "cooked broccoli",
    "cooked rice",
    "cooked pasta",
] as const;

const STOP_WORDS = new Set(["and", "with", "the", "of"]);

function canonicalToken(token: string): string {
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

function tokens(value: string): string[] {
    return normalizeFoodText(value)
        .split(" ")
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
        .map(canonicalToken);
}

function tokenCoverage(query: string, name: string, brand?: string): number {
    const queryTokens = tokens(query);
    if (queryTokens.length === 0) return 0;
    const candidateTokens = new Set(tokens(`${brand ?? ""} ${name}`));
    const matched = queryTokens.filter((token) =>
        candidateTokens.has(token),
    ).length;
    return matched / queryTokens.length;
}

const PLAIN_INGREDIENT_FORM_TOKENS = new Set([
    "bun",
    "sauce",
    "stick",
    "pickled",
    "breaded",
    "reheated",
    "prepackaged",
    "honey",
    "roasted",
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
    "salad",
    "sandwich",
    "pie",
    "chip",
    "cookie",
    "cracker",
    "soup",
    "cake",
    "cereal",
    "pizza",
    "casserole",
    "dip",
    "dressing",
    "powder",
    "flour",
    "yogurt",
    "custard",
    "pancake",
    "bagel",
    "gravy",
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
]);

function plainIngredientFormQuality(query: string, name: string): boolean {
    const queryTokens = new Set(tokens(query));
    const nameTokens = new Set(tokens(name));
    for (const token of PLAIN_INGREDIENT_FORM_TOKENS) {
        if (!queryTokens.has(token) && nameTokens.has(token)) return false;
    }
    return true;
}

function percentile(values: number[], fraction: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 0) return 0;
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * fraction) - 1),
    );
    return Number(sorted[index]!.toFixed(2));
}

const repository = new FoodCatalogRepository(foodCatalogConfig());
const rows: Array<{
    query: string;
    hit: boolean;
    quality: boolean;
    top: string | null;
    coverage: number;
    duration_ms: number;
}> = [];

for (const query of COMMON_FOODS) {
    const startedAt = performance.now();
    const hits = await repository.searchLocal(query, 5);
    const durationMs = performance.now() - startedAt;
    const top = hits[0]?.candidate;
    const coverage = top ? tokenCoverage(query, top.name, top.brand) : 0;
    rows.push({
        query,
        hit: hits.length > 0,
        quality: Boolean(
            top &&
            coverage >= 0.5 &&
            plainIngredientFormQuality(query, top.name),
        ),
        top: top ? [top.brand, top.name].filter(Boolean).join(" — ") : null,
        coverage: Number(coverage.toFixed(2)),
        duration_ms: Number(durationMs.toFixed(2)),
    });
}

const hits = rows.filter((row) => row.hit).length;
const qualityHits = rows.filter((row) => row.quality).length;
const durations = rows.map((row) => row.duration_ms);
const hitRate = hits / rows.length;
const qualityRate = qualityHits / rows.length;
const report = {
    corpus_size: rows.length,
    local_hits: hits,
    local_hit_rate: Number(hitRate.toFixed(4)),
    quality_hits: qualityHits,
    quality_rate: Number(qualityRate.toFixed(4)),
    latency: {
        p50_ms: percentile(durations, 0.5),
        p95_ms: percentile(durations, 0.95),
        max_ms: Number(Math.max(...durations).toFixed(2)),
    },
    misses: rows.filter((row) => !row.hit),
    quality_failures: rows.filter((row) => row.hit && !row.quality),
    rows,
};

const reportPath =
    process.env.MUNCH_FOOD_CORPUS_REPORT ?? "/tmp/food-catalog-corpus.json";
await Bun.write(reportPath, JSON.stringify(report, null, 2));
console.log(
    `[food_catalog_corpus] ${JSON.stringify({
        corpus_size: report.corpus_size,
        local_hit_rate: report.local_hit_rate,
        quality_rate: report.quality_rate,
        p95_ms: report.latency.p95_ms,
    })}`,
);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
    appendFileSync(
        summaryPath,
        `\n### USDA local food corpus\n\n| Metric | Result |\n| --- | ---: |\n| Foods | ${report.corpus_size} |\n| Local hit rate | ${(report.local_hit_rate * 100).toFixed(1)}% |\n| Top-result token quality | ${(report.quality_rate * 100).toFixed(1)}% |\n| Local p50 | ${report.latency.p50_ms} ms |\n| Local p95 | ${report.latency.p95_ms} ms |\n| Local max | ${report.latency.max_ms} ms |\n`,
    );
}

if (report.local_hit_rate < 0.95) {
    throw new Error(
        `USDA local hit rate ${(report.local_hit_rate * 100).toFixed(1)}% is below the 95% gate`,
    );
}
if (report.quality_rate < 0.98) {
    throw new Error(
        `USDA top-result quality rate ${(report.quality_rate * 100).toFixed(1)}% is below the 98% gate`,
    );
}
if (report.latency.p95_ms > 75) {
    throw new Error(
        `USDA local corpus p95 ${report.latency.p95_ms}ms exceeded the 75ms gate`,
    );
}
