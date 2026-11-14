/**
 * Stored-data sweep — findings persistence (audit §3).
 *
 * The platform store's write path for `munch.jev_sweep_findings`, split
 * out of `scripts/jev-sweep.ts` so the insert is importable (and
 * regression-testable) without running the sweep itself.
 *
 * BINDING LAW: the payload binds as a plain object — `${payload}::jsonb`,
 * the same idiom every other jsonb write in the codebase uses (e.g.
 * `src/service-platform/repository.ts`). Bun's SQL driver serializes a
 * JS object to JSON itself; handing it a pre-stringified string makes
 * the driver encode that string AGAIN, so the column receives a JSON
 * string instead of an object and the insert violates the
 * `jev_sweep_findings_payload_object` check (`jsonb_typeof(payload)`
 * must be 'object'). That double-encoding is exactly what crashed the
 * first live sweep run (2026-11-13): the heal committed, then the
 * first findings insert threw SQLSTATE 23514 and zero findings were
 * recorded. Never `JSON.stringify` a value bound for a jsonb column.
 */
import type { SQL } from "bun";
import type { SweepFinding } from "./sweep.js";

/** The user-facing payload persisted per finding kind. */
export function sweepFindingPayload(
    finding: SweepFinding,
): Record<string, unknown> {
    return finding.kind === "recipe_healed"
        ? {
              recipe_id: finding.recipeId,
              before_revision_id: finding.beforeRevisionId,
              after_revision_id: finding.afterRevisionId,
              confirmed_ingredients: finding.confirmedIngredients,
              per_serving_before: finding.perServingBefore,
              per_serving_after: finding.perServingAfter,
          }
        : finding.kind === "recipe_flagged"
          ? {
                recipe_id: finding.recipeId,
                confirmed_ingredients: finding.confirmedIngredients,
                signatures: finding.signatures,
            }
          : {
                meal_id: finding.mealId,
                item_id: finding.itemId,
                item_name: finding.itemName,
                signatures: finding.signatures,
            };
}

export async function recordSweepFindings(
    database: SQL,
    findings: SweepFinding[],
): Promise<void> {
    for (const finding of findings) {
        const payload = sweepFindingPayload(finding);
        await database`
            insert into munch.jev_sweep_findings (user_id, kind, recipe_id, meal_id, payload)
            values (
                ${finding.userId}::uuid,
                ${finding.kind},
                ${finding.kind === "meal_check" ? null : finding.recipeId}::uuid,
                ${finding.kind === "meal_check" ? finding.mealId : null}::uuid,
                ${payload}::jsonb
            )
        `;
    }
}
