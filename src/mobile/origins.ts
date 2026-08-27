export const MUNCH_ANDROID_WEB_ORIGIN = "https://localhost";
export const MUNCH_IOS_WEB_ORIGIN = "capacitor://localhost";
export const MUNCH_DEEP_LINK_ORIGIN = "munch://";

export const MUNCH_MOBILE_WEB_ORIGINS = Object.freeze([
    MUNCH_ANDROID_WEB_ORIGIN,
    MUNCH_IOS_WEB_ORIGIN,
] as const);

const DEVELOPMENT_LOOPBACK_ORIGINS = Object.freeze([
    /^https?:\/\/localhost(?::\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
] as const);

function normalizedHttpOrigin(value: string): string | null {
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null;
        }
        return parsed.origin;
    } catch {
        return null;
    }
}

export function configuredCorsOrigins(
    value = process.env.ALLOWED_ORIGINS,
): readonly string[] {
    if (!value) return [];
    return Object.freeze(
        value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map(normalizedHttpOrigin)
            .filter((entry): entry is string => Boolean(entry)),
    );
}

export function isAllowedApplicationCorsOrigin(
    origin: string,
    options: {
        production?: boolean;
        configuredOrigins?: readonly string[];
    } = {},
): boolean {
    if (MUNCH_MOBILE_WEB_ORIGINS.includes(origin as never)) return true;

    const configured = options.configuredOrigins ?? configuredCorsOrigins();
    if (configured.includes(origin)) return true;

    const production =
        options.production ?? process.env.NODE_ENV === "production";
    if (production) return false;

    return DEVELOPMENT_LOOPBACK_ORIGINS.some((pattern) => pattern.test(origin));
}

export function betterAuthTrustedOrigins(baseUrl: string): readonly string[] {
    const origins = new Set<string>([
        new URL(baseUrl).origin,
        ...MUNCH_MOBILE_WEB_ORIGINS,
        MUNCH_DEEP_LINK_ORIGIN,
    ]);

    if (process.env.NODE_ENV !== "production") {
        origins.add("http://localhost:*");
        origins.add("http://127.0.0.1:*");
        origins.add("https://localhost:*");
        origins.add("https://127.0.0.1:*");
    }

    return Object.freeze([...origins]);
}
