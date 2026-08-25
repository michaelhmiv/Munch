#!/usr/bin/env bun

import { createSmokeIdentity } from "./support/smoke-user.js";

const { generatePantryMealIdeas } = await import("../src/inventory/meal-ideas.js");
const { classifyPantryFood } = await import("../src/inventory/planning-profile.js");
const { reconcilePantry, setPantryPreference } =
    await import("../src/inventory/repository.js");
const { closePlatformDatabase, withUserDatabase } =
    await import("../src/platform/database.js");

function requireCondition(
    condition: unknown,
    message: string,
): asserts condition {
    if (!condition) throw new Error(message);
}

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the Pantry planning live smoke");
}
if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required for the Pantry planning live smoke");
}
if (process.env.MUNCH_PANTRY_PLANNING_ENABLED !== "true") {
    throw new Error("MUNCH_PANTRY_PLANNING_ENABLED=true is required");
}

const user = await createSmokeIdentity("pantry-planning-live");
await setPantryPreference({ userId: user.userId, enabled: true });

const pantryNames = [
    "Chicken breast",
    "Lean ground beef",
    "Salmon fillet",
    "Eggs",
    "Cottage cheese",
    "Greek yogurt",
    "Rice",
    "Pasta",
    "Flour tortillas",
    "Sweet potato",
    "Spinach",
    "Broccoli",
    "Red bell pepper",
    "Yellow onion",
    "Garlic",
    "Avocado",
    "Olive oil",
    "Soy sauce",
    "Hot sauce",
    "Dijon mustard",
    "Salsa",
    "Lime",
    "Lemon",
    "Cumin",
    "Smoked paprika",
    "Chili powder",
    "Black pepper",
    "Oregano",
];

const seed = await reconcilePantry({
    userId: user.userId,
    scope: { type: "personal" },
    sourceType: "manual",
    idempotencyKey: `pantry-planning-live:${crypto.randomUUID()}`,
    operations: pantryNames.map((name) => ({
        action: "acquire" as const,
        name,
        quantityMode: "presence_only" as const,
        location:
            /chicken|beef|salmon|egg|cottage|yogurt|spinach|broccoli|pepper|onion|avocado|lime|lemon/i.test(
                name,
            )
                ? ("fridge" as const)
                : ("pantry" as const),
    })),
});

const proteinByName: Record<string, number> = {
    "chicken breast": 31,
    "lean ground beef": 26,
    "salmon fillet": 25,
    eggs: 13,
    "cottage cheese": 12,
    "greek yogurt": 10,
};
const caloriesByName: Record<string, number> = {
    "chicken breast": 165,
    "lean ground beef": 215,
    "salmon fillet": 208,
    eggs: 143,
    "cottage cheese": 100,
    "greek yogurt": 90,
};

await withUserDatabase(user.userId, async (tx) => {
    for (const operation of seed.operations) {
        const item = operation.item;
        const classification = classifyPantryFood(item.name);
        const rolesLiteral = `{${classification.culinaryRoles.join(",")}}`;
        const protein = proteinByName[item.normalized_name] ?? null;
        const calories = caloriesByName[item.normalized_name] ?? null;
        await tx`
            insert into munch.inventory_item_profiles (
                inventory_item_id, profile_status, source_type,
                match_confidence, category, culinary_roles,
                basis_quantity, basis_unit, basis_grams,
                calories, protein_g, profile_version, enriched_at
            ) values (
                ${item.id},
                ${protein == null && calories == null ? "partial" : "resolved"},
                'heuristic', 0.95,
                ${classification.category}, ${rolesLiteral}::text[],
                ${protein == null && calories == null ? null : 100},
                ${protein == null && calories == null ? null : "g"},
                ${protein == null && calories == null ? null : 100},
                ${calories}, ${protein}, 1, now()
            )
        `;
    }
});

const { context, result } = await generatePantryMealIdeas({
    userId: user.userId,
    scope: { type: "personal" },
    goal: "high_protein",
    mealType: "dinner",
    servings: 2,
    maxMinutes: 45,
    allowMissingItems: 1,
    assumedStaples: ["salt", "water"],
});

requireCondition(context.pantry.length >= 24, "Live planning context lost Pantry breadth");
requireCondition(result.candidates.length >= 3, "Live planning returned fewer than 3 grounded candidates");

const names = result.candidates.map((candidate) => candidate.name.trim().toLowerCase());
requireCondition(new Set(names).size === names.length, "Live planning returned duplicate meal ideas");

const flavored = result.candidates.filter(
    (candidate) => candidate.flavor_system.length >= 2,
);
requireCondition(
    flavored.length >= 3,
    `Live planning produced too few intentional flavor systems (${flavored.length}/${result.candidates.length})`,
);

const flavorSignatures = new Set(
    flavored.map((candidate) =>
        [...candidate.flavor_system]
            .map((value) => value.toLowerCase())
            .sort()
            .join("|"),
    ),
);
requireCondition(
    flavorSignatures.size >= 2,
    "Live planning did not produce meaningfully distinct flavor directions",
);

const highProtein = result.candidates.filter(
    (candidate) => (candidate.estimated_nutrition.protein_g ?? 0) >= 25,
);
requireCondition(
    highProtein.length >= 2,
    `Live planning did not satisfy the high-protein goal (${highProtein.length} candidates >=25g)`,
);

requireCondition(
    result.candidates.every((candidate) => candidate.on_hand_ingredients.length >= 3),
    "Live planning collapsed a meal into an underdeveloped ingredient pile",
);
requireCondition(
    result.candidates.every((candidate) => candidate.missing_required.length <= 1),
    "Live planning exceeded the requested missing-item budget",
);

const proteinTokens = [
    "chicken",
    "beef",
    "salmon",
    "egg",
    "cottage cheese",
    "greek yogurt",
];
const usedProteins = new Set<string>();
for (const candidate of result.candidates) {
    const haystack = `${candidate.name} ${candidate.on_hand_ingredients.join(" ")}`.toLowerCase();
    for (const protein of proteinTokens) {
        if (haystack.includes(protein)) usedProteins.add(protein);
    }
}
requireCondition(
    usedProteins.size >= 2,
    `Live planning lacked primary-protein diversity: ${[...usedProteins].join(", ")}`,
);

for (const candidate of result.candidates) {
    console.log(
        `${candidate.name} | protein=${candidate.estimated_nutrition.protein_g ?? "unknown"}g | readiness=${candidate.readiness} | flavor=${candidate.flavor_system.join(", ")}`,
    );
}
console.log(
    `Live OpenRouter Pantry planning smoke passed with ${result.candidates.length} grounded candidates across ${usedProteins.size} protein directions and ${flavorSignatures.size} flavor systems.`,
);

await closePlatformDatabase();
