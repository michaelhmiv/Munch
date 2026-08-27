const APP_ROUTE_PATTERN = /^\/app(?:\/|$)/;
const MAGIC_LINK_HOST = "app";
const MAGIC_LINK_PATH = "/auth";

export function installedAppRoute(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!APP_ROUTE_PATTERN.test(trimmed)) return null;
    try {
        const parsed = new URL(trimmed, "https://installed.munch.invalid");
        if (parsed.origin !== "https://installed.munch.invalid") return null;
        if (!APP_ROUTE_PATTERN.test(parsed.pathname)) return null;
        return parsed.pathname;
    } catch {
        return null;
    }
}

export function installedMagicLinkFromUrl(value) {
    try {
        const parsed = new URL(value);
        if (
            parsed.protocol !== "munch:" ||
            parsed.hostname !== MAGIC_LINK_HOST ||
            parsed.pathname !== MAGIC_LINK_PATH
        ) {
            return null;
        }
        const token = parsed.searchParams.get("token")?.trim() ?? "";
        if (token.length < 20 || token.length > 2048) return null;
        return {
            token,
            returnTo:
                installedAppRoute(parsed.searchParams.get("return_to")) ||
                "/app",
        };
    } catch {
        return null;
    }
}

export function installedRouteFromUrl(value) {
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== "munch:") return null;
        if (installedMagicLinkFromUrl(value)) return null;
        const route = `/${[parsed.hostname, parsed.pathname]
            .filter(Boolean)
            .join("/")
            .replace(/\/{2,}/g, "/")}`;
        return installedAppRoute(route);
    } catch {
        return null;
    }
}

export function installedLoginHref(returnTo = "/app") {
    const route = installedAppRoute(returnTo) || "/app";
    return `/mobile-login.html?return_to=${encodeURIComponent(route)}`;
}
