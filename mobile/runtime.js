import { App } from "@capacitor/app";
import {
    CapacitorBarcodeScanner,
    CapacitorBarcodeScannerAndroidScanningLibrary,
    CapacitorBarcodeScannerCameraDirection,
    CapacitorBarcodeScannerTypeHintALLOption,
} from "@capacitor/barcode-scanner";
import { Camera } from "@capacitor/camera";
import { registerPlugin } from "@capacitor/core";
import {
    getMunchPlatformKind,
    requestJson,
    resolveMunchApiUrl,
    setMunchPlatformAdapter,
} from "../public/app-api.js";
import {
    installedAppRoute,
    installedLoginHref,
    installedRouteFromUrl,
} from "./navigation.js";

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

export function installedReturnRoute(value) {
    return installedAppRoute(value) || "/app";
}

export function currentInstalledAppRoute() {
    return installedReturnRoute(location.pathname);
}

export function installedLoginUrl(returnTo = currentInstalledAppRoute()) {
    return installedLoginHref(returnTo);
}

function moveToLogin(returnTo = currentInstalledAppRoute()) {
    const href = installedLoginHref(returnTo);
    if (location.pathname === LOGIN_PATH) {
        history.replaceState({}, "", href);
        return;
    }
    location.replace(href);
}

function navigateInstalledRoute(route, replace = false) {
    const safeRoute = installedAppRoute(route);
    if (!safeRoute) return null;
    if (replace) history.replaceState({}, "", safeRoute);
    else history.pushState({}, "", safeRoute);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return safeRoute;
}

setMunchPlatformAdapter({
    kind: "mobile",
    apiBaseUrl: API_BASE_URL,
    getAccessToken: storedToken,
    async onAuthenticationRequired() {
        const returnTo = currentInstalledAppRoute();
        await clearStoredToken();
        moveToLogin(returnTo);
    },
});

export { getMunchPlatformKind, requestJson, resolveMunchApiUrl };

export async function hasStoredSession() {
    return Boolean(await storedToken());
}

export async function restoreInstalledEntryRoute(explicitRoute) {
    const requested = installedAppRoute(explicitRoute);
    if (requested) return navigateInstalledRoute(requested, true);

    try {
        const launch = await App.getLaunchUrl();
        const launchedRoute = installedRouteFromUrl(launch?.url);
        if (launchedRoute) return navigateInstalledRoute(launchedRoute, true);
    } catch {
        // A missing launch URL is a normal app start.
    }

    return installedAppRoute(location.pathname);
}

export async function signInWithPassword(identifier, password) {
    const normalizedIdentifier = String(identifier || "").trim();
    const normalizedPassword = String(password || "");
    if (!normalizedIdentifier || !normalizedPassword) {
        throw new Error("Email or username and password are required");
    }

    const usesEmail = normalizedIdentifier.includes("@");
    const endpoint = usesEmail
        ? "/api/auth/sign-in/email"
        : "/api/auth/sign-in/username";
    const body = usesEmail
        ? {
              email: normalizedIdentifier.toLowerCase(),
              password: normalizedPassword,
              rememberMe: true,
          }
        : {
              username: normalizedIdentifier,
              password: normalizedPassword,
              rememberMe: true,
          };

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
            payload?.message ||
                payload?.error ||
                `Sign in failed (${response.status})`,
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

export async function takeInstalledPhoto() {
    return Camera.takePhoto({
        quality: 88,
        correctOrientation: true,
        saveToGallery: false,
        includeMetadata: true,
        editable: "no",
    });
}

export async function chooseInstalledPhoto() {
    const result = await Camera.chooseFromGallery({
        quality: 88,
        correctOrientation: true,
        allowMultipleSelection: false,
        includeMetadata: true,
        editable: "no",
    });
    return result.results?.[0] ?? null;
}

export async function scanInstalledBarcode() {
    return CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHintALLOption.ALL,
        scanInstructions: "Center the food barcode in the frame",
        scanButton: false,
        cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
        cancelButtonAccessibilityLabel: "Cancel barcode scan",
        torchButtonOnAccessibilityLabel: "Turn flashlight off",
        torchButtonOffAccessibilityLabel: "Turn flashlight on",
        android: {
            scanningLibrary:
                CapacitorBarcodeScannerAndroidScanningLibrary.MLKIT,
        },
    });
}

App.addListener("appUrlOpen", ({ url }) => {
    const route = installedRouteFromUrl(url);
    if (!route) return;
    if (location.pathname === LOGIN_PATH) {
        history.replaceState({}, "", installedLoginHref(route));
        return;
    }
    navigateInstalledRoute(route);
});

App.addListener("appRestoredResult", (event) => {
    if (
        event?.success !== true ||
        event.pluginId !== "Camera" ||
        !["takePhoto", "chooseFromGallery", "getPhoto"].includes(
            event.methodName,
        )
    ) {
        return;
    }
    const data =
        event.methodName === "chooseFromGallery"
            ? event.data?.results?.[0]
            : event.data;
    if (!data?.webPath) return;
    window.dispatchEvent(
        new CustomEvent("munch:camera-restored", { detail: data }),
    );
});
