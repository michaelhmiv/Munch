import { App } from "@capacitor/app";
import { registerPlugin } from "@capacitor/core";
import {
    getMunchPlatformKind,
    requestJson,
    resolveMunchApiUrl,
    setMunchPlatformAdapter,
} from "../public/app-api.js";

const API_BASE_URL = "https://munch.business";
const LOGIN_PATH = "/mobile-login.html";

const MunchSecureSession = registerPlugin("MunchSecureSession");

async function storedToken() {
    try {
        const result = await MunchSecureSession.getToken();
        return typeof result?.token === "string" && result.token.length > 0
            ? result.token
            : null;
    } catch {
        return null;
    }
}

async function clearStoredToken() {
    try {
        await MunchSecureSession.clearToken();
    } catch {
        // A missing native plugin is treated as a signed-out state. The Android
        // build registers this plugin before BridgeActivity starts.
    }
}

function moveToLogin() {
    if (location.pathname !== LOGIN_PATH) location.replace(LOGIN_PATH);
}

setMunchPlatformAdapter({
    kind: "mobile",
    apiBaseUrl: API_BASE_URL,
    getAccessToken: storedToken,
    async onAuthenticationRequired() {
        await clearStoredToken();
        moveToLogin();
    },
});

export { getMunchPlatformKind, requestJson, resolveMunchApiUrl };

export async function hasStoredSession() {
    return Boolean(await storedToken());
}

export async function signInWithPassword(identifier, password) {
    const normalizedIdentifier = String(identifier || "").trim();
    const normalizedPassword = String(password || "");
    if (!normalizedIdentifier || !normalizedPassword) {
        throw new Error("Email or username and password are required");
    }

    const usesEmail = normalizedIdentifier.includes("@");
    const endpoint = usesEmail ? "/api/auth/sign-in/email" : "/api/auth/sign-in/username";
    const body = usesEmail
        ? { email: normalizedIdentifier.toLowerCase(), password: normalizedPassword, rememberMe: true }
        : { username: normalizedIdentifier, password: normalizedPassword, rememberMe: true };

    const response = await fetch(new URL(endpoint, API_BASE_URL), {
        method: "POST",
        credentials: "omit",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(
            payload?.message || payload?.error || `Sign in failed (${response.status})`,
        );
    }

    const token = response.headers.get("set-auth-token");
    if (!token) {
        throw new Error("Munch did not return an installed-app session token");
    }

    await MunchSecureSession.setToken({ token });
    return payload;
}

export async function signOutInstalledSession() {
    const token = await storedToken();
    try {
        if (token) {
            await fetch(new URL("/api/auth/sign-out", API_BASE_URL), {
                method: "POST",
                credentials: "omit",
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                },
            });
        }
    } finally {
        await clearStoredToken();
    }
}

export function installedRouteFromUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "munch:") return null;
        const route = `/${[parsed.hostname, parsed.pathname]
            .filter(Boolean)
            .join("/")
            .replace(/\/{2,}/g, "/")}`;
        return route.startsWith("/app") ? route : null;
    } catch {
        return null;
    }
}

App.addListener("appUrlOpen", ({ url }) => {
    const route = installedRouteFromUrl(url);
    if (!route) return;
    history.pushState({}, "", route);
    window.dispatchEvent(new PopStateEvent("popstate"));
});
