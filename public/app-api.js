const webPlatform = Object.freeze({
    kind: "web",
    apiBaseUrl: null,
    async getAccessToken() {
        return null;
    },
    async onAuthenticationRequired() {
        const returnTo = `${location.pathname}${location.search}${location.hash}`;
        location.href = `/connect/sign-in?return_to=${encodeURIComponent(returnTo)}`;
    },
});

let platform = webPlatform;

function normalizedApiBaseUrl(value) {
    if (!value) return null;
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
        throw new Error("Munch API base URL must use HTTPS");
    }
    return parsed.origin;
}

export function setMunchPlatformAdapter(adapter) {
    if (!adapter || (adapter.kind !== "web" && adapter.kind !== "mobile")) {
        throw new Error("Invalid Munch platform adapter");
    }
    platform = Object.freeze({
        kind: adapter.kind,
        apiBaseUrl: normalizedApiBaseUrl(adapter.apiBaseUrl),
        getAccessToken:
            typeof adapter.getAccessToken === "function"
                ? adapter.getAccessToken
                : webPlatform.getAccessToken,
        onAuthenticationRequired:
            typeof adapter.onAuthenticationRequired === "function"
                ? adapter.onAuthenticationRequired
                : webPlatform.onAuthenticationRequired,
    });
}

export function resetMunchPlatformAdapter() {
    platform = webPlatform;
}

export function getMunchPlatformKind() {
    return platform.kind;
}

export function resolveMunchApiUrl(path) {
    if (typeof path !== "string" || !path.startsWith("/")) {
        throw new Error("Munch API path must be root-relative");
    }
    if (!platform.apiBaseUrl) return path;
    return new URL(path, platform.apiBaseUrl).toString();
}

function shouldSetJsonContentType(body) {
    if (body === undefined || body === null) return false;
    if (typeof FormData !== "undefined" && body instanceof FormData)
        return false;
    if (
        typeof URLSearchParams !== "undefined" &&
        body instanceof URLSearchParams
    )
        return false;
    if (typeof Blob !== "undefined" && body instanceof Blob) return false;
    return true;
}

function errorMessage(payload, status) {
    if (payload && typeof payload === "object") {
        if (typeof payload.message === "string" && payload.message) {
            return payload.message;
        }
        if (typeof payload.error === "string" && payload.error) {
            return payload.error;
        }
    }
    return `Request failed (${status})`;
}

export async function requestJson(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (
        !headers.has("Content-Type") &&
        shouldSetJsonContentType(options.body)
    ) {
        headers.set("Content-Type", "application/json");
    }

    const token = await platform.getAccessToken();
    if (platform.kind === "mobile") {
        if (!token) {
            await platform.onAuthenticationRequired({
                reason: "missing_token",
            });
            throw new Error("Authentication required");
        }
        headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetch(resolveMunchApiUrl(path), {
        ...options,
        headers,
        credentials: platform.kind === "mobile" ? "omit" : "same-origin",
    });

    if (response.status === 401) {
        await platform.onAuthenticationRequired({ reason: "unauthorized" });
        const error = new Error("Authentication required");
        error.status = 401;
        throw error;
    }

    const text = await response.text();
    let payload = {};
    if (text) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = { error: text };
        }
    }

    if (!response.ok) {
        const error = new Error(errorMessage(payload, response.status));
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}
