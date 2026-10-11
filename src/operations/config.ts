export interface ConfigurationIssue {
    key: string;
    message: string;
}

function present(key: string): string {
    return process.env[key]?.trim() ?? "";
}

function requireValue(
    issues: ConfigurationIssue[],
    key: string,
    message = `${key} is required`,
): void {
    if (!present(key)) issues.push({ key, message });
}

export function configurationIssues(): ConfigurationIssue[] {
    const issues: ConfigurationIssue[] = [];
    const production = process.env.NODE_ENV === "production";

    const baseUrl = present("MUNCH_APP_BASE_URL");
    requireValue(issues, "MUNCH_APP_BASE_URL");
    if (baseUrl) {
        try {
            const parsed = new URL(baseUrl);
            if (production && parsed.protocol !== "https:") {
                issues.push({
                    key: "MUNCH_APP_BASE_URL",
                    message: "Production application URL must use HTTPS",
                });
            }
            if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
                issues.push({
                    key: "MUNCH_APP_BASE_URL",
                    message:
                        "Application URL must be an origin without a path, query, or fragment",
                });
            }
        } catch {
            issues.push({
                key: "MUNCH_APP_BASE_URL",
                message: "Application URL is invalid",
            });
        }
    }

    requireValue(issues, "BETTER_AUTH_SECRET");
    const secret = present("BETTER_AUTH_SECRET");
    if (secret && secret.length < 32) {
        issues.push({
            key: "BETTER_AUTH_SECRET",
            message: "Better Auth secret must contain at least 32 characters",
        });
    }
    requireValue(issues, "RESEND_API_KEY");
    requireValue(issues, "MUNCH_EMAIL_FROM");
    requireValue(issues, "DATABASE_URL");
    requireValue(issues, "STRIPE_SECRET_KEY");
    requireValue(issues, "STRIPE_WEBHOOK_SECRET");
    requireValue(issues, "STRIPE_PRICE_ID");
    requireValue(issues, "STRIPE_HOUSEHOLD_MEMBER_PRICE_ID");
    requireValue(issues, "OFF_USER_AGENT");
    requireValue(
        issues,
        "USDA_FDC_API_KEY",
        "USDA_FDC_API_KEY is required because the USDA provider is enabled",
    );

    const googleWebClientId = present("MUNCH_GOOGLE_WEB_CLIENT_ID");
    const googleAndroidClientId = present("MUNCH_GOOGLE_ANDROID_CLIENT_ID");
    const googleClientSecret = present("MUNCH_GOOGLE_CLIENT_SECRET");
    if (Boolean(googleWebClientId) !== Boolean(googleClientSecret)) {
        issues.push({
            key: "MUNCH_GOOGLE_WEB_CLIENT_ID",
            message:
                "Google web client ID and secret must be configured together",
        });
    }
    if (googleAndroidClientId && (!googleWebClientId || !googleClientSecret)) {
        issues.push({
            key: "MUNCH_GOOGLE_ANDROID_CLIENT_ID",
            message: "Google Android client ID requires web client credentials",
        });
    }

    const appLinkFingerprints = present(
        "MUNCH_ANDROID_APP_LINK_SHA256_FINGERPRINTS",
    );
    if (
        appLinkFingerprints &&
        appLinkFingerprints
            .split(",")
            .map((value) => value.trim())
            .some(
                (value) =>
                    !/^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(value),
            )
    ) {
        issues.push({
            key: "MUNCH_ANDROID_APP_LINK_SHA256_FINGERPRINTS",
            message:
                "App Link fingerprints must be colon-separated SHA-256 values",
        });
    }

    const pool = Number(present("MUNCH_DB_POOL_SIZE") || 10);
    if (!Number.isInteger(pool) || pool < 1 || pool > 50) {
        issues.push({
            key: "MUNCH_DB_POOL_SIZE",
            message: "Database pool size must be an integer from 1 to 50",
        });
    }
    return issues;
}

export function validateStartupConfiguration(): void {
    const issues = configurationIssues();
    if (issues.length === 0) return;
    const summary = issues
        .map((issue) => `${issue.key}: ${issue.message}`)
        .join("; ");
    throw new Error(`Invalid Munch configuration: ${summary}`);
}
