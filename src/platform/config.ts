export interface PlatformConfig {
    databaseUrl: string;
    appBaseUrl: string;
    stripeSecretKey: string;
    stripeWebhookSecret: string;
    stripePriceId: string;
    stripeGrandfatheredPriceIds: string[];
    stripeHouseholdMemberPriceId: string;
}

function requiredEnvironmentVariable(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function normalizedBaseUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("MUNCH_APP_BASE_URL must be an absolute URL");
    }

    if (url.protocol !== "https:" && url.hostname !== "localhost") {
        throw new Error(
            "MUNCH_APP_BASE_URL must use HTTPS outside local development",
        );
    }

    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}

export function parseStripeGrandfatheredPriceIds(
    raw = process.env.STRIPE_GRANDFATHERED_PRICE_IDS,
): string[] {
    if (!raw) return [];
    const seen = new Set<string>();
    for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (trimmed) seen.add(trimmed);
    }
    return [...seen];
}

export function knownPremiumStripePriceIds(input: {
    stripePriceId?: string | null;
    stripeGrandfatheredPriceIds?: readonly string[];
    stripeHouseholdMemberPriceId?: string | null;
}): Set<string> {
    const seatPriceId = input.stripeHouseholdMemberPriceId?.trim() || null;
    const ids = new Set<string>();
    const current = input.stripePriceId?.trim();
    if (current && current !== seatPriceId) ids.add(current);
    for (const legacy of input.stripeGrandfatheredPriceIds ?? []) {
        const trimmed = legacy.trim();
        if (trimmed && trimmed !== seatPriceId) ids.add(trimmed);
    }
    return ids;
}

export function isKnownPremiumStripePriceId(
    priceId: string | null | undefined,
    config: Pick<
        PlatformConfig,
        | "stripePriceId"
        | "stripeGrandfatheredPriceIds"
        | "stripeHouseholdMemberPriceId"
    >,
): boolean {
    if (!priceId) return false;
    return knownPremiumStripePriceIds(config).has(priceId);
}

export function selectPrimaryStripePriceId(
    items: ReadonlyArray<{ stripePriceId: string }>,
    input?: {
        stripePriceId?: string | null;
        stripeGrandfatheredPriceIds?: readonly string[];
        stripeHouseholdMemberPriceId?: string | null;
    },
): string | null {
    const cfg = input ?? {
        stripePriceId: process.env.STRIPE_PRICE_ID,
        stripeGrandfatheredPriceIds: parseStripeGrandfatheredPriceIds(),
        stripeHouseholdMemberPriceId:
            process.env.STRIPE_HOUSEHOLD_MEMBER_PRICE_ID,
    };
    const known = knownPremiumStripePriceIds(cfg);
    const seatPriceId = cfg.stripeHouseholdMemberPriceId?.trim() || null;
    return (
        items.find((item) => known.has(item.stripePriceId))?.stripePriceId ??
        items.find(
            (item) =>
                Boolean(item.stripePriceId) &&
                item.stripePriceId !== seatPriceId,
        )?.stripePriceId ??
        items[0]?.stripePriceId ??
        null
    );
}

export function getPlatformConfig(): PlatformConfig {
    return {
        databaseUrl: requiredEnvironmentVariable("DATABASE_URL"),
        appBaseUrl: normalizedBaseUrl(
            requiredEnvironmentVariable("MUNCH_APP_BASE_URL"),
        ),
        stripeSecretKey: requiredEnvironmentVariable("STRIPE_SECRET_KEY"),
        stripeWebhookSecret: requiredEnvironmentVariable(
            "STRIPE_WEBHOOK_SECRET",
        ),
        stripePriceId: requiredEnvironmentVariable("STRIPE_PRICE_ID"),
        stripeGrandfatheredPriceIds: parseStripeGrandfatheredPriceIds(),
        stripeHouseholdMemberPriceId: requiredEnvironmentVariable(
            "STRIPE_HOUSEHOLD_MEMBER_PRICE_ID",
        ),
    };
}

export function platformConfigurationAvailable(): boolean {
    return [
        "DATABASE_URL",
        "MUNCH_APP_BASE_URL",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PRICE_ID",
        "STRIPE_HOUSEHOLD_MEMBER_PRICE_ID",
    ].every((name) => Boolean(process.env[name]?.trim()));
}
