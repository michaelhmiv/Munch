import { Hono } from "hono";

const DISABLED_PROVENANCE_RESPONSE = {
    startDate: "—",
    endDate: "—",
    timezone: "temporarily disabled",
    coverage: {
        mealCount: 0,
        structuredMealCount: 0,
        legacyMealCount: 0,
        itemCount: 0,
        totalCalories: 0,
        itemizedCalories: 0,
        itemizedCaloriePercent: 0,
    },
    sources: [],
    confidence: {
        recordedItemCount: 0,
        average: null,
        highConfidenceItemCount: 0,
        estimatedItemCount: 0,
    },
    contributors: {
        calories: [],
        protein_g: [],
        carbs_g: [],
        fat_g: [],
        fiber_g: [],
        sugar_g: [],
        sodium_mg: [],
    },
} as const;

export function createProvenanceRouter(): Hono {
    const router = new Hono();

    // Production circuit breaker: an older Insights client can continuously
    // request this optional endpoint. Keep the compatibility route extremely
    // cheap and return the complete legacy shape so those clients can settle
    // without touching session, timezone, meal, or provenance database work.
    router.get("/api/app/provenance", (c) =>
        c.json(DISABLED_PROVENANCE_RESPONSE, 200, {
            "Cache-Control": "private, no-store",
            Pragma: "no-cache",
        }),
    );

    return router;
}
