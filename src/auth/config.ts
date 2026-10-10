export interface BetterAuthRuntimeConfig {
    baseUrl: string;
    databaseUrl: string;
    secret: string;
    production: boolean;
    publicPasswordSignup: boolean;
    magicLinkExpiresIn: number;
    databasePoolSize: number;
    googleWebClientId?: string;
    googleAndroidClientId?: string;
    googleClientSecret?: string;
}

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function optional(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

export function getBetterAuthRuntimeConfig(): BetterAuthRuntimeConfig {
    const baseUrl = required("MUNCH_APP_BASE_URL");
    const parsedBaseUrl = new URL(baseUrl);
    if (
        process.env.NODE_ENV === "production" &&
        parsedBaseUrl.protocol !== "https:"
    ) {
        throw new Error("MUNCH_APP_BASE_URL must use HTTPS in production");
    }
    if (
        parsedBaseUrl.pathname !== "/" ||
        parsedBaseUrl.search ||
        parsedBaseUrl.hash
    ) {
        throw new Error(
            "MUNCH_APP_BASE_URL must be an origin without path, query, or fragment",
        );
    }

    const secret = required("BETTER_AUTH_SECRET");
    if (secret.length < 32) {
        throw new Error(
            "BETTER_AUTH_SECRET must contain at least 32 characters",
        );
    }

    const magicLinkExpiresIn = Number(
        process.env.MUNCH_MAGIC_LINK_TTL_SECONDS || 600,
    );
    if (
        !Number.isInteger(magicLinkExpiresIn) ||
        magicLinkExpiresIn < 300 ||
        magicLinkExpiresIn > 3600
    ) {
        throw new Error(
            "MUNCH_MAGIC_LINK_TTL_SECONDS must be an integer from 300 to 3600",
        );
    }

    const databasePoolSize = Number(process.env.MUNCH_AUTH_DB_POOL_SIZE || 5);
    if (
        !Number.isInteger(databasePoolSize) ||
        databasePoolSize < 1 ||
        databasePoolSize > 20
    ) {
        throw new Error(
            "MUNCH_AUTH_DB_POOL_SIZE must be an integer from 1 to 20",
        );
    }

    const googleWebClientId = optional("MUNCH_GOOGLE_WEB_CLIENT_ID");
    const googleAndroidClientId = optional("MUNCH_GOOGLE_ANDROID_CLIENT_ID");
    const googleClientSecret = optional("MUNCH_GOOGLE_CLIENT_SECRET");
    if (Boolean(googleWebClientId) !== Boolean(googleClientSecret)) {
        throw new Error(
            "MUNCH_GOOGLE_WEB_CLIENT_ID and MUNCH_GOOGLE_CLIENT_SECRET must be configured together",
        );
    }
    if (googleAndroidClientId && !googleWebClientId) {
        throw new Error(
            "MUNCH_GOOGLE_ANDROID_CLIENT_ID requires Google web client credentials",
        );
    }

    return {
        baseUrl: parsedBaseUrl.origin,
        databaseUrl: required("DATABASE_URL"),
        secret,
        production: process.env.NODE_ENV === "production",
        publicPasswordSignup:
            process.env.MUNCH_PUBLIC_PASSWORD_SIGNUP === "true",
        magicLinkExpiresIn,
        databasePoolSize,
        googleWebClientId,
        googleAndroidClientId,
        googleClientSecret,
    };
}
