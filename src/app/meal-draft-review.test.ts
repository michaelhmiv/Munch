import { describe, expect, test } from "bun:test";
import {
    draftItemInputFromBody,
    serializeMealDraftForApp,
} from "./meal-draft-review.js";

describe("web meal draft review", () => {
    test("normalizes editable item fields without filling missing nutrients", () => {
        expect(
            draftItemInputFromBody({
                name: "Toast",
                quantity: "2",
                portion_label: "slices",
                nutrients: { calories: "180", protein_g: 6 },
                source_type: "user_supplied",
            }),
        ).toEqual({
            name: "Toast",
            quantity: 2,
            portionLabel: "slices",
            gramWeight: undefined,
            nutrients: { calories: 180, protein_g: 6 },
            sourceType: "user_supplied",
            provider: undefined,
            providerFoodId: undefined,
            providerRevision: undefined,
            sourceUrl: undefined,
            sourceUpdatedAt: undefined,
            confidence: undefined,
            assumptions: [],
            sourceSnapshot: {},
        });
    });

    test("serializes provenance, questions, and totals for the website", () => {
        const result = serializeMealDraftForApp({
            id: "draft-1",
            userId: "user-1",
            status: "awaiting_confirmation",
            sourceMode: "photo",
            mealType: "lunch",
            description: "Plate",
            loggedAt: "2026-08-20T12:00:00.000Z",
            notes: null,
            version: 3,
            expiresAt: "2026-08-21T12:00:00.000Z",
            confirmedMealId: null,
            createdAt: "2026-08-20T11:00:00.000Z",
            updatedAt: "2026-08-20T11:30:00.000Z",
            items: [
                {
                    id: "item-1",
                    position: 0,
                    item: {
                        name: "Chicken",
                        nutrients: { calories: 400, protein_g: 35 },
                        sourceType: "model_estimate",
                        assumptions: ["Skin-on estimate"],
                        sourceSnapshot: { resolution_layer: "photo" },
                    },
                    createdAt: "2026-08-20T11:00:00.000Z",
                    updatedAt: "2026-08-20T11:00:00.000Z",
                },
            ],
            questions: [],
        });

        expect(result.totals).toEqual({ calories: 400, protein_g: 35 });
        expect(result.items[0]).toMatchObject({
            name: "Chicken",
            source_type: "model_estimate",
            source_snapshot: { resolution_layer: "photo" },
        });
        expect(result.assumptions).toEqual(["Skin-on estimate"]);
        expect(result.ready_for_confirmation).toBe(true);
    });
});
