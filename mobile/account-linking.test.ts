import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    mock,
    test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleAccountAction } from "../public/app-account.js";
import { resetMunchPlatformAdapter } from "../public/app-api.js";

/**
 * W1b — Packaged-app account linking parity tests.
 *
 * Exercises both:
 *   1. Settings -> Sign-in methods -> Link (`public/app-account.js`)
 *      using the native ID-token path on packaged surfaces while
 *      keeping the web consent redirect untouched.
 *   2. `mobile/runtime.js` native ID-token acquisition and
 *      cross-provider collision prompt recording for both Google and
 *      Apple (with mocked Capacitor plugins and fetch).
 */

let mockPlatform: "ios" | "android" = "ios";
const secureStore = new Map<string, string>();
let appleSignInCalls: Array<{ nonce?: string }> = [];
let googleSignInCalls: Array<Record<string, unknown>> = [];
let nextAppleIdToken = "apple-native-id-token";
let nextGoogleIdToken = "google-native-id-token";

const mockSecureSession = {
    async getToken() {
        return { token: secureStore.get("token") ?? "" };
    },
    async setToken({ token }: { token: string }) {
        secureStore.set("token", token);
    },
    async clearToken() {
        secureStore.delete("token");
    },
    async getPendingAuth() {
        return { value: secureStore.get("pendingAuth") ?? "" };
    },
    async setPendingAuth({ value }: { value: string }) {
        secureStore.set("pendingAuth", value);
    },
    async clearPendingAuth() {
        secureStore.delete("pendingAuth");
    },
    async getPendingLinkPrompt() {
        return { value: secureStore.get("pendingLinkPrompt") ?? "" };
    },
    async setPendingLinkPrompt({ value }: { value: string }) {
        secureStore.set("pendingLinkPrompt", value);
    },
    async clearPendingLinkPrompt() {
        secureStore.delete("pendingLinkPrompt");
    },
};

const mockAppleSignIn = {
    async signIn(options: { nonce?: string }) {
        appleSignInCalls.push(options);
        return { idToken: nextAppleIdToken };
    },
};

const mockGoogleSignIn = {
    async signIn(options: Record<string, unknown>) {
        googleSignInCalls.push(options);
        return { idToken: nextGoogleIdToken };
    },
};

mock.module("@capacitor/core", () => ({
    Capacitor: {
        getPlatform: () => mockPlatform,
    },
    registerPlugin: (name: string) => {
        if (name === "MunchSecureSession") return mockSecureSession;
        if (name === "MunchAppleSignIn") return mockAppleSignIn;
        if (name === "MunchGoogleSignIn") return mockGoogleSignIn;
        return {};
    },
}));

mock.module("@capacitor/app", () => ({
    App: {
        addListener: () => ({ remove: async () => {} }),
        getLaunchUrl: async () => null,
        exitApp: async () => {},
    },
}));

mock.module("@capacitor/camera", () => ({
    Camera: {
        takePhoto: async () => ({}),
        chooseFromGallery: async () => ({ results: [] }),
    },
}));

mock.module("@capacitor/barcode-scanner", () => ({
    CapacitorBarcodeScanner: { scanBarcode: async () => ({}) },
    CapacitorBarcodeScannerAndroidScanningLibrary: { MLKIT: 0 },
    CapacitorBarcodeScannerCameraDirection: { BACK: 1 },
    CapacitorBarcodeScannerTypeHintALLOption: { ALL: 17 },
}));

const originalWindow = globalThis.window;
const originalLocation = globalThis.location;
const originalFetch = globalThis.fetch;

if (typeof globalThis.window === "undefined") {
    Object.defineProperty(globalThis, "window", {
        value: {},
        configurable: true,
        writable: true,
    });
}

const runtime = await import("./runtime.js");
resetMunchPlatformAdapter();

beforeEach(() => {
    mockPlatform = "ios";
    secureStore.clear();
    appleSignInCalls = [];
    googleSignInCalls = [];
    nextAppleIdToken = "apple-native-id-token";
    nextGoogleIdToken = "google-native-id-token";
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "location", {
        value: originalLocation,
        configurable: true,
        writable: true,
    });
});

afterAll(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
        writable: true,
    });
    Object.defineProperty(globalThis, "location", {
        value: originalLocation,
        configurable: true,
        writable: true,
    });
    resetMunchPlatformAdapter();
});

function makeLinkButton(provider: string, providerLabel: string) {
    return {
        dataset: {
            action: "sign-in-method-link",
            provider,
            providerLabel,
        },
        disabled: false,
    };
}

function makeAccountCtx(overrides: Record<string, unknown> = {}) {
    const apiCalls: Array<{ path: string; options: Record<string, unknown> }> =
        [];
    const toasts: Array<{ message: string; kind?: string }> = [];
    let rendered = 0;
    const alertEl = { textContent: "", hidden: true };

    const ctx = {
        content: {
            querySelector: (selector: string) =>
                selector === "[data-sign-in-methods-alert]" ? alertEl : null,
        },
        api: async (path: string, options: Record<string, unknown>) => {
            apiCalls.push({ path, options });
            return { url: "", redirect: false, status: true };
        },
        toast: (message: string, kind?: string) => {
            toasts.push({ message, kind });
        },
        renderRoute: async () => {
            rendered += 1;
        },
        ...overrides,
    };

    return {
        ctx,
        apiCalls,
        toasts,
        alertEl,
        renderedCount: () => rendered,
    };
}

describe("Settings -> Sign-in methods -> Link (app-account.js)", () => {
    test("packaged app sends native Google ID token and links in place without navigating", async () => {
        const fakeLocation = { href: "https://localhost/app/settings/account" };
        Object.defineProperty(globalThis, "location", {
            value: fakeLocation,
            configurable: true,
            writable: true,
        });

        const button = makeLinkButton("google", "Google");
        const tokenCalls: string[] = [];
        const { ctx, apiCalls, toasts, renderedCount } = makeAccountCtx({
            nativeProviderIdToken: async (provider: string) => {
                tokenCalls.push(provider);
                return "google-id-token-123";
            },
        });

        const handled = await handleAccountAction(
            button as never,
            ctx as never,
        );

        expect(handled).toBe(true);
        expect(tokenCalls).toEqual(["google"]);
        expect(apiCalls).toHaveLength(1);
        expect(apiCalls[0]?.path).toBe("/api/app/sign-in-methods/google/link");
        expect(JSON.parse(String(apiCalls[0]?.options.body))).toEqual({
            callbackURL: "/app/settings/account",
            errorCallbackURL: "/app/settings/account",
            idToken: "google-id-token-123",
        });
        expect(fakeLocation.href).toBe(
            "https://localhost/app/settings/account",
        );
        expect(toasts).toEqual([
            { message: "Google linked.", kind: undefined },
        ]);
        expect(renderedCount()).toBe(1);
        expect(button.disabled).toBe(false);
    });

    test("packaged app sends native Apple ID token and links in place without navigating", async () => {
        const fakeLocation = { href: "https://localhost/app/settings/account" };
        Object.defineProperty(globalThis, "location", {
            value: fakeLocation,
            configurable: true,
            writable: true,
        });

        const button = makeLinkButton("apple", "Apple");
        const tokenCalls: string[] = [];
        const { ctx, apiCalls, toasts, renderedCount } = makeAccountCtx({
            nativeProviderIdToken: async (provider: string) => {
                tokenCalls.push(provider);
                return "apple-id-token-456";
            },
        });

        const handled = await handleAccountAction(
            button as never,
            ctx as never,
        );

        expect(handled).toBe(true);
        expect(tokenCalls).toEqual(["apple"]);
        expect(apiCalls).toHaveLength(1);
        expect(apiCalls[0]?.path).toBe("/api/app/sign-in-methods/apple/link");
        expect(JSON.parse(String(apiCalls[0]?.options.body))).toEqual({
            callbackURL: "/app/settings/account",
            errorCallbackURL: "/app/settings/account",
            idToken: "apple-id-token-456",
        });
        expect(fakeLocation.href).toBe(
            "https://localhost/app/settings/account",
        );
        expect(toasts).toEqual([{ message: "Apple linked.", kind: undefined }]);
        expect(renderedCount()).toBe(1);
        expect(button.disabled).toBe(false);
    });

    test("web flow sends no idToken and follows the returned consent URL", async () => {
        const fakeLocation = {
            href: "https://munch.business/app/settings/account",
        };
        Object.defineProperty(globalThis, "location", {
            value: fakeLocation,
            configurable: true,
            writable: true,
        });

        const button = makeLinkButton("google", "Google");
        const { ctx, apiCalls, renderedCount } = makeAccountCtx({
            nativeProviderIdToken: async () => null,
            api: async (path: string, options: Record<string, unknown>) => {
                apiCalls.push({ path, options });
                return {
                    url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
                    redirect: true,
                };
            },
        });

        const handled = await handleAccountAction(
            button as never,
            ctx as never,
        );

        expect(handled).toBe(true);
        expect(apiCalls).toHaveLength(1);
        expect(JSON.parse(String(apiCalls[0]?.options.body))).toEqual({
            callbackURL: "/app/settings/account",
            errorCallbackURL: "/app/settings/account",
        });
        expect(fakeLocation.href).toBe(
            "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
        );
        expect(renderedCount()).toBe(0);
        expect(button.disabled).toBe(false);
    });

    test("native token failure surfaces in the Settings alert without calling the link API", async () => {
        const button = makeLinkButton("apple", "Apple");
        const { ctx, apiCalls, alertEl } = makeAccountCtx({
            nativeProviderIdToken: async () => {
                throw new Error(
                    "Sign in with Apple was cancelled or could not be completed",
                );
            },
        });

        const handled = await handleAccountAction(
            button as never,
            ctx as never,
        );

        expect(handled).toBe(true);
        expect(apiCalls).toHaveLength(0);
        expect(alertEl.hidden).toBe(false);
        expect(alertEl.textContent).toBe(
            "Sign in with Apple was cancelled or could not be completed",
        );
        expect(button.disabled).toBe(false);
    });

    test("app.js passes nativeProviderIdToken in accountContext()", () => {
        const root = fileURLToPath(new URL("../", import.meta.url));
        const appJs = readFileSync(`${root}public/app.js`, "utf8");
        const start = appJs.indexOf("function accountContext()");
        expect(start).toBeGreaterThan(-1);
        const block = appJs.slice(start, start + 450);
        expect(block).toContain("nativeProviderIdToken");
    });
});

describe("mobile/runtime.js native Apple linking & collision prompt recording", () => {
    test("nativeProviderIdToken('apple') on iOS mints a fresh Apple ID token via MunchAppleSignIn", async () => {
        mockPlatform = "ios";
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            expect(String(input)).toBe(
                "https://munch.business/mobile/auth/apple-config",
            );
            return Response.json({ configured: true });
        }) as typeof fetch;

        const token = await runtime.nativeProviderIdToken("apple");

        expect(token).toBe("apple-native-id-token");
        expect(appleSignInCalls).toHaveLength(1);
        expect(typeof appleSignInCalls[0]?.nonce).toBe("string");
        expect(appleSignInCalls[0]?.nonce?.length).toBeGreaterThan(20);
    });

    test("nativeProviderIdToken('apple') on Android refuses honestly instead of bouncing to a dead web redirect", async () => {
        mockPlatform = "android";
        let fetched = false;
        globalThis.fetch = (async () => {
            fetched = true;
            return Response.json({ configured: true });
        }) as typeof fetch;

        const error = await runtime
            .nativeProviderIdToken("apple")
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Apple");
        expect(appleSignInCalls).toHaveLength(0);
        expect(fetched).toBe(false);
    });

    test("nativeProviderIdToken('google') still mints a fresh Google ID token on iOS and Android", async () => {
        mockPlatform = "ios";
        globalThis.fetch = (async () =>
            Response.json({
                configured: true,
                webClientId: "web-client-id",
                platforms: {
                    ios: {
                        configured: true,
                        clientId: "ios-client-id",
                        webClientId: "web-client-id",
                    },
                },
            })) as typeof fetch;

        expect(await runtime.nativeProviderIdToken("google")).toBe(
            "google-native-id-token",
        );
        expect(googleSignInCalls[0]?.clientId).toBe("ios-client-id");
        expect(googleSignInCalls[0]?.serverClientId).toBe("web-client-id");

        mockPlatform = "android";
        expect(await runtime.nativeProviderIdToken("google")).toBe(
            "google-native-id-token",
        );
        expect(googleSignInCalls[1]?.webClientId).toBe("web-client-id");
    });

    test("signInWithApple() records a pending link prompt on 401 OAUTH_LINK_ERROR (iOS)", async () => {
        mockPlatform = "ios";
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/mobile/auth/apple-config")) {
                return Response.json({ configured: true });
            }
            expect(url).toBe("https://munch.business/api/auth/sign-in/social");
            return Response.json(
                { code: "OAUTH_LINK_ERROR", message: "account_not_linked" },
                { status: 401 },
            );
        }) as typeof fetch;

        const error = await runtime
            .signInWithApple()
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
            "already has a Munch account",
        );
        expect((error as Error).message).toContain("add Apple");
        expect(await runtime.pendingNativeLinkPrompt()).toBe("apple");

        await runtime.clearPendingNativeLinkPrompt();
        expect(await runtime.pendingNativeLinkPrompt()).toBeNull();
    });

    test("signInWithApple() records a pending link prompt on 401 OAUTH_LINK_ERROR on Android too", async () => {
        mockPlatform = "android";
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/mobile/auth/apple-config")) {
                return Response.json({ configured: true });
            }
            return Response.json(
                { code: "OAUTH_LINK_ERROR", message: "account_not_linked" },
                { status: 401 },
            );
        }) as typeof fetch;

        await expect(runtime.signInWithApple()).rejects.toThrow(
            /already has a Munch account/,
        );
        expect(await runtime.pendingNativeLinkPrompt()).toBe("apple");
    });

    test("signInWithGoogle() still records a pending link prompt on 401 OAUTH_LINK_ERROR", async () => {
        mockPlatform = "ios";
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/mobile/auth/google-config")) {
                return Response.json({
                    configured: true,
                    webClientId: "web-client-id",
                    platforms: {
                        ios: {
                            configured: true,
                            clientId: "ios-client-id",
                            webClientId: "web-client-id",
                        },
                    },
                });
            }
            return Response.json(
                { code: "OAUTH_LINK_ERROR", message: "account_not_linked" },
                { status: 401 },
            );
        }) as typeof fetch;

        await expect(runtime.signInWithGoogle()).rejects.toThrow(
            /already has a Munch account/,
        );
        expect(await runtime.pendingNativeLinkPrompt()).toBe("google");
    });
});
