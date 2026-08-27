import { safeLocalRedirectPath } from "../accounts/redirect.js";

const MOBILE_APP_ROUTE_PATTERN = /^\/app(?:\/|$)/;

export function buildScannerSafeMagicLink(input: {
    generatedUrl: string;
    baseUrl: string;
}): string {
    const generated = new URL(input.generatedUrl);
    const token = generated.searchParams.get("token");
    if (!token) throw new Error("Better Auth magic-link URL is missing token");

    const callback =
        generated.searchParams.get("callbackURL") ??
        generated.searchParams.get("callbackUrl") ??
        undefined;
    const returnTo = safeLocalRedirectPath(callback, "/account/portal");
    const confirmation = new URL("/connect/confirm", input.baseUrl);
    confirmation.searchParams.set("token", token);
    confirmation.searchParams.set("return_to", returnTo);
    return confirmation.toString();
}

export function safeMagicLinkReturnPath(value: unknown): string {
    return safeLocalRedirectPath(
        typeof value === "string" ? value : undefined,
        "/account/portal",
    );
}

export function safeInstalledMagicLinkReturnPath(value: unknown): string {
    const local = safeLocalRedirectPath(
        typeof value === "string" ? value : undefined,
        "/app",
    );
    return MOBILE_APP_ROUTE_PATTERN.test(local) ? local : "/app";
}

export function mobileMagicLinkRequest(metadata: unknown): {
    requested: boolean;
    returnTo: string;
} {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return { requested: false, returnTo: "/app" };
    }
    const record = metadata as Record<string, unknown>;
    return {
        requested: record.munch_mobile === true,
        returnTo: safeInstalledMagicLinkReturnPath(record.return_to),
    };
}

export function buildInstalledMagicLinkConfirmation(input: {
    token: string;
    baseUrl: string;
    returnTo: string;
}): string {
    if (!input.token || input.token.length > 2048) {
        throw new Error("Installed magic-link token is invalid");
    }
    const confirmation = new URL("/mobile/confirm", input.baseUrl);
    confirmation.searchParams.set("token", input.token);
    confirmation.searchParams.set(
        "return_to",
        safeInstalledMagicLinkReturnPath(input.returnTo),
    );
    return confirmation.toString();
}

export function buildInstalledMagicLinkDeepLink(input: {
    token: string;
    returnTo: string;
}): string {
    if (!input.token || input.token.length > 2048) {
        throw new Error("Installed magic-link token is invalid");
    }
    const link = new URL("munch://app/auth");
    link.searchParams.set("token", input.token);
    link.searchParams.set(
        "return_to",
        safeInstalledMagicLinkReturnPath(input.returnTo),
    );
    return link.toString();
}
