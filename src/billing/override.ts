import { withBillingDatabase } from "../platform/database.js";

export async function hasActivePremiumOverride(
    userId: string,
    now = new Date(),
): Promise<boolean> {
    return withBillingDatabase(async (tx) => {
        const rows = await tx<Array<{ active: boolean }>>`
            select active
            from munch.entitlements
            where user_id = ${userId}
              and feature_key = 'premium_access'
              and active = true
              and (expires_at is null or expires_at > ${now})
            limit 1
        `;
        return rows[0]?.active === true;
    });
}
