import {
    countMeals,
    existingIdempotencyKeys,
    getProfile,
    insertMeal,
} from "./storage.js";
import { runImport, type BulkImportArgs, type ImportResult } from "./import.js";

/** Hard ceiling shared by MCP and website history imports. */
export const MAX_MEALS_PER_USER = 200_000;

/**
 * Run the canonical user-scoped import adapter used by both MCP and the web.
 * The parser/validation/idempotency semantics remain in src/import.ts; this
 * adapter supplies the authenticated user's profile and Railway-backed writes.
 */
export async function runUserImport(
    userId: string,
    args: BulkImportArgs,
): Promise<ImportResult> {
    const profile = await getProfile(userId);
    const tz = profile?.timezone ?? "UTC";
    const existingCount = await countMeals(userId);
    if (existingCount + args.meals.length > MAX_MEALS_PER_USER) {
        return {
            status: "failed",
            dry_run: args.dry_run ?? false,
            summary: {
                total: args.meals.length,
                created: 0,
                deduplicated: 0,
                would_create: 0,
                failed: 0,
                not_attempted: 0,
                duplicate_rows_in_file: 0,
                rows_without_calories: 0,
                skipped_by_caller: args.rows_skipped ?? 0,
            },
            warnings: [
                `This import would exceed the maximum of ${MAX_MEALS_PER_USER} stored meals (you have ${existingCount}). Delete some history first.`,
            ],
            results: [],
        };
    }

    return runImport(args, {
        userId,
        tz,
        tzConfigured: profile !== null,
        nowMs: Date.now(),
        insert: (input) => insertMeal(userId, input),
        existingKeys: (keys) => existingIdempotencyKeys(userId, keys),
    });
}
