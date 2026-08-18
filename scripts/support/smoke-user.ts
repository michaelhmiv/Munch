import { withAuthDatabase } from "../../src/platform/database.js";

export interface SmokeIdentity {
    userId: string;
    email: string;
}

export async function createSmokeIdentity(
    prefix: string,
): Promise<SmokeIdentity> {
    const userId = crypto.randomUUID();
    const normalizedPrefix =
        prefix
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "smoke";
    const email = `${normalizedPrefix}-${userId}@example.test`;

    await withAuthDatabase(async (tx) => {
        await tx`
            insert into munch.users (id, email, name, email_verified, status)
            values (
                ${userId},
                ${email},
                ${prefix},
                true,
                'active'
            )
        `;
    });

    return { userId, email };
}

export async function createSmokeUser(prefix: string): Promise<string> {
    return (await createSmokeIdentity(prefix)).userId;
}
