import { withAuthDatabase } from "../../src/platform/database.js";

export async function createSmokeUser(prefix: string): Promise<string> {
    const userId = crypto.randomUUID();
    const normalizedPrefix = prefix
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "smoke";

    await withAuthDatabase(async (tx) => {
        await tx`
            insert into munch.users (id, email, name, email_verified, status)
            values (
                ${userId},
                ${`${normalizedPrefix}-${userId}@example.test`},
                ${prefix},
                true,
                'active'
            )
        `;
    });

    return userId;
}
