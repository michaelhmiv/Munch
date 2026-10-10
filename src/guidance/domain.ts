import type {
    GuidancePreferences,
    GeneratedRecipeProposal,
} from "./contracts.js";

const normalized = (value: string) =>
    value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");

const allergenAliases: Record<string, string[]> = {
    milk: [
        "milk",
        "cheese",
        "butter",
        "cream",
        "whey",
        "casein",
        "yogurt",
        "ghee",
    ],
    egg: ["egg", "eggs", "mayonnaise", "albumin"],
    fish: ["fish", "salmon", "tuna", "cod", "anchovy", "anchovies"],
    shellfish: [
        "shrimp",
        "crab",
        "lobster",
        "crayfish",
        "shellfish",
        "prawn",
        "clam",
        "oyster",
        "mussel",
    ],
    tree_nut: [
        "almond",
        "cashew",
        "walnut",
        "pecan",
        "pistachio",
        "hazelnut",
        "macadamia",
        "brazil nut",
        "pine nut",
        "tree nut",
    ],
    peanut: ["peanut", "groundnut", "peanut butter"],
    wheat: [
        "wheat",
        "flour",
        "bread crumbs",
        "breadcrumbs",
        "semolina",
        "farro",
        "bulgur",
        "couscous",
    ],
    soy: ["soy", "soya", "tofu", "tempeh", "edamame", "miso", "soy sauce"],
    sesame: ["sesame", "tahini", "sesame oil"],
};

const knownIngredients = new Set(
    [
        "water",
        "salt",
        "black pepper",
        "pepper",
        "olive oil",
        "vegetable oil",
        "canola oil",
        "avocado oil",
        "garlic",
        "garlic powder",
        "onion",
        "onion powder",
        "scallion",
        "green onion",
        "lemon",
        "lime",
        "vinegar",
        "apple cider vinegar",
        "balsamic vinegar",
        "sugar",
        "brown sugar",
        "honey",
        "maple syrup",
        "tomato",
        "tomatoes",
        "tomato paste",
        "tomato sauce",
        "potato",
        "potatoes",
        "sweet potato",
        "carrot",
        "celery",
        "bell pepper",
        "red bell pepper",
        "spinach",
        "kale",
        "broccoli",
        "cauliflower",
        "zucchini",
        "mushroom",
        "mushrooms",
        "corn",
        "peas",
        "green beans",
        "black beans",
        "kidney beans",
        "chickpeas",
        "lentils",
        "rice",
        "brown rice",
        "quinoa",
        "oats",
        "cornstarch",
        "baking powder",
        "baking soda",
        "basil",
        "oregano",
        "thyme",
        "rosemary",
        "cumin",
        "paprika",
        "chili powder",
        "cayenne",
        "cinnamon",
        "parsley",
        "cilantro",
        "dill",
        "bay leaf",
        "chicken breast",
        "chicken thigh",
        "chicken thighs",
        "beef",
        "ground beef",
        "pork",
        "pork tenderloin",
        "turkey",
        "ground turkey",
        "shrimp",
        "salmon",
        "cod",
        "apple",
        "banana",
        "orange",
        "blueberries",
        "strawberries",
        "avocado",
        "coconut milk",
        "stock",
        "broth",
    ].map(normalized),
);

function containsTerm(ingredient: string, term: string): boolean {
    const value = normalized(ingredient);
    const target = normalized(term);
    return value === target || ` ${value} `.includes(` ${target} `);
}

function canonicalAllergen(value: string): string {
    const text = normalized(value).replace(/ /g, "_");
    if (text.includes("nut") && !text.includes("peanut")) return "tree_nut";
    if (text.includes("shell") || text.includes("crustacean"))
        return "shellfish";
    if (text.includes("egg")) return "egg";
    if (text.includes("milk") || text.includes("dairy")) return "milk";
    if (text.includes("wheat") || text.includes("gluten")) return "wheat";
    if (text.includes("soy")) return "soy";
    if (text.includes("sesame")) return "sesame";
    if (text.includes("fish")) return "fish";
    if (text.includes("peanut")) return "peanut";
    return text;
}

export interface ConstraintCheck {
    blockers: string[];
    warnings: string[];
}

/** Conservative ingredient screening. An unknown ingredient is a blocker when
 * the user has listed an allergy, because the recipe text alone cannot establish
 * packaged-food or cross-contact safety. */
export function checkRecipeConstraints(
    recipe: Pick<
        GeneratedRecipeProposal,
        | "name"
        | "ingredients"
        | "difficulty"
        | "preparation_minutes"
        | "cooking_minutes"
        | "required_equipment"
        | "primary_protein"
        | "cuisine_tags"
        | "cooking_methods"
    >,
    preferences: GuidancePreferences,
): ConstraintCheck {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const allergies = [
        ...new Set(preferences.allergies.map(canonicalAllergen)),
    ];

    for (const ingredient of recipe.ingredients) {
        const name = normalized(ingredient.name);
        if (
            preferences.excluded_ingredients.some((term) =>
                containsTerm(name, term),
            )
        ) {
            blockers.push(`Excluded ingredient: ${ingredient.name}`);
        }
        const matchedAllergens = Object.entries(allergenAliases)
            .filter(([, aliases]) =>
                aliases.some((alias) => containsTerm(name, alias)),
            )
            .map(([key]) => key);
        const allergenMatch = matchedAllergens.find((key) =>
            allergies.includes(key),
        );
        if (allergenMatch)
            blockers.push(
                `Possible allergy match (${allergenMatch.replaceAll("_", " ")}): ${ingredient.name}`,
            );
        else if (
            allergies.length > 0 &&
            matchedAllergens.length === 0 &&
            !knownIngredients.has(name)
        ) {
            blockers.push(`Allergen status is unknown for: ${ingredient.name}`);
        }
        if (
            preferences.disliked_ingredients.some((term) =>
                containsTerm(name, term),
            )
        ) {
            warnings.push(`Disliked ingredient included: ${ingredient.name}`);
        }
    }

    const equipment = new Set(preferences.equipment.map(normalized));
    for (const required of recipe.required_equipment) {
        if (equipment.size > 0 && !equipment.has(normalized(required))) {
            blockers.push(`Unavailable required equipment: ${required}`);
        }
    }
    if (
        preferences.difficulty !== "any" &&
        preferences.difficulty !== recipe.difficulty
    ) {
        warnings.push(
            `Recipe difficulty (${recipe.difficulty}) differs from preference (${preferences.difficulty})`,
        );
    }
    const prep = recipe.preparation_minutes ?? 0;
    const cook = recipe.cooking_minutes ?? 0;
    if (
        preferences.max_prep_minutes != null &&
        prep > preferences.max_prep_minutes
    ) {
        warnings.push(
            `Preparation time is above ${preferences.max_prep_minutes} minutes`,
        );
    }
    if (
        preferences.max_total_minutes != null &&
        prep + cook > preferences.max_total_minutes
    ) {
        warnings.push(
            `Total time is above ${preferences.max_total_minutes} minutes`,
        );
    }
    if (
        preferences.avoided_methods.some((method) =>
            recipe.cooking_methods.some((used) => containsTerm(used, method)),
        )
    ) {
        blockers.push("Recipe uses an avoided cooking method");
    }
    if (
        preferences.preferred_methods.length > 0 &&
        !preferences.preferred_methods.some((method) =>
            recipe.cooking_methods.some((used) => containsTerm(used, method)),
        )
    ) {
        warnings.push("Recipe does not use a preferred cooking method");
    }
    if (
        preferences.liked_ingredients.length > 0 &&
        !preferences.liked_ingredients.some((like) =>
            recipe.ingredients.some((item) => containsTerm(item.name, like)),
        )
    ) {
        warnings.push("Recipe does not include a listed liked ingredient");
    }
    if (
        preferences.cuisines.length > 0 &&
        !preferences.cuisines.some((like) =>
            recipe.cuisine_tags.some((tag) => containsTerm(tag, like)),
        )
    ) {
        warnings.push("Recipe does not match a listed cuisine preference");
    }

    return {
        blockers: [...new Set(blockers)],
        warnings: [...new Set(warnings)],
    };
}

export function recipeFingerprint(input: {
    name: string;
    ingredients: string[];
    cuisineTags?: string[];
    primaryProtein?: string | null;
    cookingMethods?: string[];
}) {
    return {
        title: normalized(input.name),
        ingredients: [
            ...new Set(input.ingredients.map(normalized).filter(Boolean)),
        ].sort(),
        cuisines: [
            ...new Set(
                (input.cuisineTags ?? []).map(normalized).filter(Boolean),
            ),
        ].sort(),
        protein: input.primaryProtein ? normalized(input.primaryProtein) : "",
        methods: [
            ...new Set(
                (input.cookingMethods ?? []).map(normalized).filter(Boolean),
            ),
        ].sort(),
    };
}

function jaccard(left: string[], right: string[]): number {
    const a = new Set(left);
    const b = new Set(right);
    if (!a.size && !b.size) return 1;
    const intersection = [...a].filter((value) => b.has(value)).length;
    const union = new Set([...a, ...b]).size;
    return union ? intersection / union : 0;
}

export function isNearDuplicate(
    candidate: ReturnType<typeof recipeFingerprint>,
    existing: ReturnType<typeof recipeFingerprint>,
): boolean {
    if (candidate.title && candidate.title === existing.title) return true;
    const titleSimilarity = jaccard(
        candidate.title.split(" "),
        existing.title.split(" "),
    );
    const ingredientSimilarity = jaccard(
        candidate.ingredients,
        existing.ingredients,
    );
    return (
        ingredientSimilarity >= 0.82 ||
        (titleSimilarity >= 0.8 && ingredientSimilarity >= 0.55)
    );
}

export interface VarietyRecipe {
    name: string;
    ingredients: string[];
    cuisineTags?: string[];
    primaryProtein?: string | null;
    cookingMethods?: string[];
}

/** Produces stable, explainable candidate order; hard constraints must be checked
 * before calling this ranking function. */
export function varietyScore(
    candidate: VarietyRecipe,
    chosen: VarietyRecipe[],
): number {
    if (chosen.length === 0) return 100;
    const candidateFp = recipeFingerprint(candidate);
    const recent = chosen.map(recipeFingerprint);
    let score = 100;
    for (const prior of recent.slice(-5)) {
        if (isNearDuplicate(candidateFp, prior)) score -= 100;
        if (candidateFp.protein && candidateFp.protein === prior.protein)
            score -= 16;
        if (candidateFp.cuisines.some((tag) => prior.cuisines.includes(tag)))
            score -= 8;
        if (candidateFp.methods.some((tag) => prior.methods.includes(tag)))
            score -= 6;
        score -= Math.round(
            jaccard(candidateFp.ingredients, prior.ingredients) * 12,
        );
    }
    return score;
}

export function dayTotalsAfterMealSwap(input: {
    dayTotals: { calories: number | null; protein_g: number | null };
    currentPerServing: { calories: number | null; protein_g: number | null };
    replacementPerServing: {
        calories: number | null;
        protein_g: number | null;
    };
    servings: number;
}) {
    const replace = (
        total: number | null,
        current: number | null,
        replacement: number | null,
    ) =>
        total == null || current == null || replacement == null
            ? null
            : Number(
                  (
                      total -
                      current * input.servings +
                      replacement * input.servings
                  ).toFixed(1),
              );
    return {
        calories: replace(
            input.dayTotals.calories,
            input.currentPerServing.calories,
            input.replacementPerServing.calories,
        ),
        protein_g: replace(
            input.dayTotals.protein_g,
            input.currentPerServing.protein_g,
            input.replacementPerServing.protein_g,
        ),
    };
}

export interface CheckinMeal {
    calories: number | null;
    protein_g: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
    nutrition_status?: "complete" | "partial" | "unavailable" | null;
}

export interface CheckinDay {
    date: string;
    meals: CheckinMeal[];
    waterMl: number;
    plannedMeals: number;
    loggedPlannedMeals: number;
}

export interface CheckinGoals {
    calories: number | null;
    protein_g: number | null;
    water_ml: number | null;
    revision_id?: string | null;
}

export function buildWeeklyCheckin(input: {
    startDate: string;
    endDate: string;
    timezone: string;
    days: CheckinDay[];
    goals: CheckinGoals;
}) {
    const loggedDays = input.days.filter((day) => day.meals.length > 0);
    const coverageDays = loggedDays.filter((day) =>
        day.meals.some(
            (meal) => meal.calories != null || meal.protein_g != null,
        ),
    );
    const averageOn = (field: "calories" | "protein_g" | "waterMl") => {
        const values = input.days
            .filter((day) =>
                field === "waterMl"
                    ? day.waterMl > 0
                    : day.meals.some((meal) => meal[field] != null),
            )
            .map((day) =>
                field === "waterMl"
                    ? day.waterMl
                    : day.meals.reduce(
                          (sum, meal) => sum + (meal[field] ?? 0),
                          0,
                      ),
            );
        return {
            average: values.length
                ? Number(
                      (
                          values.reduce((a, b) => a + b, 0) / values.length
                      ).toFixed(1),
                  )
                : null,
            days: values.length,
        };
    };
    const uncertainMeals = input.days
        .flatMap((day) => day.meals)
        .filter((meal) => meal.nutrition_status !== "complete").length;
    const missingCoreNutrientMeals = input.days
        .flatMap((day) => day.meals)
        .filter(
            (meal) => meal.calories == null || meal.protein_g == null,
        ).length;
    const planned = input.days.reduce((sum, day) => sum + day.plannedMeals, 0);
    const loggedPlanned = input.days.reduce(
        (sum, day) => sum + day.loggedPlannedMeals,
        0,
    );
    const observations: string[] = [];
    if (loggedDays.length === 0)
        observations.push(
            "No meals were recorded in this period, so intake trends cannot be assessed.",
        );
    else
        observations.push(
            `Meals were recorded on ${loggedDays.length} of ${input.days.length} days; unrecorded days are unknown.`,
        );
    const calories = averageOn("calories");
    if (calories.average != null && input.goals.calories != null)
        observations.push(
            `Recorded-day calorie average: ${Math.round(calories.average)} kcal across ${calories.days} days; current daily target is ${Math.round(input.goals.calories)} kcal.`,
        );
    if (uncertainMeals > 0)
        observations.push(
            `${uncertainMeals} logged meals have partial or unavailable nutrition; target comparisons may be incomplete.`,
        );
    return {
        start_date: input.startDate,
        end_date: input.endDate,
        timezone: input.timezone,
        calendar_days: input.days.length,
        days_with_meals: loggedDays.length,
        nutrition_target_coverage_days: coverageDays.length,
        coverage_percent: input.days.length
            ? Math.round((coverageDays.length / input.days.length) * 100)
            : 0,
        averages_on_recorded_days: {
            calories:
                calories.average == null
                    ? null
                    : { value: calories.average, days: calories.days },
            protein_g: averageOn("protein_g"),
            water_ml: averageOn("waterMl"),
        },
        missing_core_nutrient_meals: missingCoreNutrientMeals,
        uncertain_nutrition_meals: uncertainMeals,
        planned_meals: planned,
        planned_meals_logged: loggedPlanned,
        goal_revision_id: input.goals.revision_id ?? null,
        observations: observations.slice(0, 3),
    };
}

export function buildDailyGuidance(input: {
    date: string;
    objective: GuidancePreferences["objective"];
    calories: number | null;
    protein_g: number | null;
    water_ml: number | null;
    goals: CheckinGoals;
    plannedMeals: Array<{ meal_slot: string | null; recipe_name: string }>;
}) {
    const recorded = input.calories != null || input.protein_g != null;
    const actions: string[] = [];
    if (!recorded)
        actions.push(
            "No food is recorded for today yet; this is not evidence that you have eaten nothing.",
        );
    else if (
        input.goals.protein_g != null &&
        input.protein_g != null &&
        input.protein_g < input.goals.protein_g
    ) {
        actions.push(
            `Protein recorded so far: ${Math.round(input.protein_g)} g of a ${Math.round(input.goals.protein_g)} g target.`,
        );
    }
    if (input.plannedMeals.length)
        actions.push(
            `${input.plannedMeals.length} meal${input.plannedMeals.length === 1 ? " is" : "s are"} planned; planning does not mean the meal was eaten.`,
        );
    if (input.water_ml != null && input.goals.water_ml != null)
        actions.push(
            `Water recorded: ${Math.round(input.water_ml)} ml of a ${Math.round(input.goals.water_ml)} ml target.`,
        );
    if (actions.length === 0)
        actions.push(
            "Keep logging meals as you go; today’s summary updates from recorded information.",
        );
    return {
        date: input.date,
        objective: input.objective,
        source_status: recorded ? "recorded_data" : "sparse_data",
        logged: {
            calories: input.calories,
            protein_g: input.protein_g,
            water_ml: input.water_ml,
        },
        goals: input.goals,
        planned_meals: input.plannedMeals,
        actions: actions.slice(0, 2),
    };
}

export function objectiveLabel(
    objective: GuidancePreferences["objective"],
): string {
    return {
        maintain: "maintain weight",
        gain: "gain weight",
        lose: "lose weight",
        track_only: "track without an objective",
    }[objective];
}
