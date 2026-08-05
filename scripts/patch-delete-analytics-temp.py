from pathlib import Path

analytics = Path("src/analytics.ts")
text = analytics.read_text()
old = """    options?: {
        outcome?: (result: T) => { success: boolean; errorCategory?: string };
    },
"""
new = """    options?: {
        outcome?: (result: T) => { success: boolean; errorCategory?: string };
        // A successful destructive action may remove the user row that owns
        // tool_events. Skip only the success insert in that case; failures are
        // still persisted because the user remains available for diagnosis.
        persistSuccess?: boolean;
    },
"""
if old not in text:
    raise SystemExit("analytics option block not found")
text = text.replace(old, new, 1)
old = """        persistAnalytics({
            user_id: context.userId,
            tool_name: toolName,
            success: outcome.success,
            duration_ms: durationMs,
            error_category: outcome.success
                ? undefined
                : (outcome.errorCategory ?? \"unknown\"),
            date_range_days: dateRangeDays,
            mcp_session_id: context.sessionId,
            invoked_at: invokedAt,
        });

        return result;
"""
new = """        if (options?.persistSuccess !== false) {
            persistAnalytics({
                user_id: context.userId,
                tool_name: toolName,
                success: outcome.success,
                duration_ms: durationMs,
                error_category: outcome.success
                    ? undefined
                    : (outcome.errorCategory ?? \"unknown\"),
                date_range_days: dateRangeDays,
                mcp_session_id: context.sessionId,
                invoked_at: invokedAt,
            });
        }

        return result;
"""
if old not in text:
    raise SystemExit("analytics success persistence block not found")
analytics.write_text(text.replace(old, new, 1))

mcp = Path("src/mcp.ts")
text = mcp.read_text()
old = """                    await deleteAllUserData(userId);
                    return {
                        content: [
                            {
                                type: \"text\",
                                text: \"Your account and all associated data have been permanently deleted.\",
                            },
                        ],
                    };
                },
                { userId },
            );
"""
new = """                    await deleteAllUserData(userId);
                    return {
                        content: [
                            {
                                type: \"text\",
                                text: \"Your account and all associated data have been permanently deleted.\",
                            },
                        ],
                    };
                },
                { userId },
                undefined,
                { persistSuccess: !confirm },
            );
"""
if old not in text:
    raise SystemExit("delete_account analytics call not found")
mcp.write_text(text.replace(old, new, 1))

smoke = Path("scripts/account-deletion-smoke.ts")
text = smoke.read_text()
old = """const email = `account-deletion-${crypto.randomUUID()}@example.test`;
"""
new = """const analyticsWarnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
    analyticsWarnings.push(args.map(String).join(\" \"));
    originalWarn(...args);
};

const email = `account-deletion-${crypto.randomUUID()}@example.test`;
"""
if old not in text:
    raise SystemExit("account deletion smoke setup anchor not found")
text = text.replace(old, new, 1)
old = """    const afterDeletion = await counts();
    if (
        afterDeletion.users !== 0 ||
        afterDeletion.meals !== 0 ||
        afterDeletion.sessions !== 0 ||
        afterDeletion.loginTokens !== 0
    ) {
        throw new Error(
            `Account deletion left persisted data behind: ${JSON.stringify(afterDeletion)}`,
        );
    }

    console.log(
"""
new = """    const afterDeletion = await counts();
    if (
        afterDeletion.users !== 0 ||
        afterDeletion.meals !== 0 ||
        afterDeletion.sessions !== 0 ||
        afterDeletion.loginTokens !== 0
    ) {
        throw new Error(
            `Account deletion left persisted data behind: ${JSON.stringify(afterDeletion)}`,
        );
    }

    await Bun.sleep(50);
    if (
        analyticsWarnings.some((warning) =>
            warning.includes(\"Failed to persist analytics for delete_account\"),
        )
    ) {
        throw new Error(
            \"Account deletion attempted to persist analytics after removing the user\",
        );
    }

    console.log(
"""
if old not in text:
    raise SystemExit("account deletion assertion anchor not found")
text = text.replace(old, new, 1)
old = """} finally {
    await client.close().catch(() => undefined);
"""
new = """} finally {
    console.warn = originalWarn;
    await client.close().catch(() => undefined);
"""
if old not in text:
    raise SystemExit("account deletion finally anchor not found")
smoke.write_text(text.replace(old, new, 1))

Path(".github/workflows/fix-delete-analytics-temp.yml").unlink()
Path("scripts/patch-delete-analytics-temp.py").unlink()
