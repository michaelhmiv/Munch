import { withAuthDatabase } from "../platform/database.js";

export interface AccountIdentity {
    userId: string;
    email: string;
}

export async function getAccountIdentity(
    userId: string,
): Promise<AccountIdentity | null> {
    return withAuthDatabase(async (tx) => {
        const rows = await tx<Array<{ id: string; email: string }>>`
            select id, email
            from munch.users
            where id = ${userId}
              and status not in ('deleted', 'deletion_pending')
            limit 1
        `;
        const row = rows[0];
        return row ? { userId: row.id, email: row.email } : null;
    });
}
