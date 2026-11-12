import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function read(path: string): string {
    return readFileSync(`${root}${path}`, "utf8");
}

// The iOS first-party plugin bridge contract. Android's plugins are
// guarded by scripts/mobile-shell-smoke.ts in the Android lanes; these
// tests are the iOS mirror in the always-on unit lane: canonical
// sources in mobile/ios/, committed App-target copies, Xcode project
// membership, bridge registration, and cross-platform contract parity
// with the Android plugins the shared runtime was written against.
describe("iOS native bridge contract", () => {
    const secureSessionSwift = read(
        "mobile/ios/MunchSecureSessionPlugin.swift",
    );
    const appleSignInSwift = read("mobile/ios/MunchAppleSignInPlugin.swift");
    const bridgeViewController = read(
        "mobile/ios/MunchBridgeViewController.swift",
    );
    const secureSessionJava = read(
        "mobile/android/MunchSecureSessionPlugin.java",
    );
    const runtime = read("mobile/runtime.js");

    test("committed App-target copies are byte-identical to the canonical sources", () => {
        for (const file of [
            "MunchSecureSessionPlugin.swift",
            "MunchAppleSignInPlugin.swift",
            "MunchBridgeViewController.swift",
        ]) {
            expect(read(`ios/App/App/${file}`)).toBe(
                read(`mobile/ios/${file}`),
            );
        }
        expect(read("scripts/configure-mobile-ios.ts")).toContain(
            "MunchSecureSessionPlugin.swift",
        );
    });

    test("the Xcode project compiles all three first-party Swift files into the App target", () => {
        const project = read("ios/App/App.xcodeproj/project.pbxproj");
        for (const file of [
            "MunchSecureSessionPlugin.swift",
            "MunchAppleSignInPlugin.swift",
            "MunchBridgeViewController.swift",
        ]) {
            expect(project).toContain(`${file} in Sources`);
            expect(project).toContain(`path = ${file};`);
        }
    });

    test("the bridge view controller registers both plugins and SceneDelegate uses it", () => {
        expect(bridgeViewController).toContain("CAPBridgeViewController");
        expect(bridgeViewController).toContain(
            "registerPluginInstance(MunchSecureSessionPlugin())",
        );
        expect(bridgeViewController).toContain(
            "registerPluginInstance(MunchAppleSignInPlugin())",
        );
        expect(read("ios/App/App/SceneDelegate.swift")).toContain(
            "MunchBridgeViewController()",
        );
    });

    test("SecureSession exposes the same six bridge methods on iOS and Android", () => {
        const methods = [
            "getToken",
            "setToken",
            "clearToken",
            "getPendingAuth",
            "setPendingAuth",
            "clearPendingAuth",
        ];
        expect(secureSessionSwift).toContain('jsName = "MunchSecureSession"');
        for (const method of methods) {
            expect(secureSessionSwift).toContain(
                `CAPPluginMethod(name: "${method}"`,
            );
            expect(secureSessionJava).toContain(
                `public void ${method}(PluginCall call)`,
            );
        }
        expect(runtime).toContain('registerPlugin("MunchSecureSession")');
    });

    test("iOS SecureSession storage mirrors the Android limits and stays device-only", () => {
        // Android ceilings (MunchSecureSessionPlugin.java): session
        // token 16384 chars, pending auth 4096 chars; unreadable stored
        // values are deleted rather than trusted.
        expect(secureSessionSwift).toContain("tokenLimit = 16384");
        expect(secureSessionSwift).toContain("pendingAuthLimit = 4096");
        expect(secureSessionSwift).toContain(
            "kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly",
        );
        expect(secureSessionSwift).toContain("kSecClassGenericPassword");
        // Reads resolve empty strings, never null, exactly like Android.
        expect(secureSessionSwift).toContain('call.resolve([resultKey: ""])');
        expect(secureSessionSwift).toContain(
            '"Unable to read the installed Munch session"',
        );
        expect(secureSessionSwift).toContain(
            '"A valid Munch session token is required"',
        );
    });

    test("the Apple plugin runs ASAuthorization and returns only an ID token", () => {
        expect(appleSignInSwift).toContain('jsName = "MunchAppleSignIn"');
        expect(appleSignInSwift).toContain("ASAuthorizationAppleIDProvider");
        expect(appleSignInSwift).toContain("ASAuthorizationController");
        expect(appleSignInSwift).toContain('["idToken": idToken]');
        // The raw nonce stays in the runtime's idToken body; the
        // request carries its SHA-256 hex, which the server's Apple
        // verifier accepts (node_modules/@better-auth/core apple
        // provider: claim === nonce || claim === sha256(nonce)).
        expect(appleSignInSwift).toContain("SHA256.hash");
        expect(appleSignInSwift).toContain("request.nonce = hashedNonce");
        expect(runtime).toContain('registerPlugin("MunchAppleSignIn")');
        expect(runtime).toContain('provider: "apple"');
        expect(runtime).toContain("/mobile/auth/apple-config");
    });

    test("the packaged sign-in surface carries the Apple door in the shared grammar", () => {
        const loginHtml = read("mobile/mobile-login.html");
        expect(loginHtml).toContain('id="apple-sign-in"');
        expect(loginHtml).toContain('class="button button-apple"');
        expect(loginHtml).toContain("Continue with Apple");
        const loginJs = read("mobile/mobile-login.js");
        expect(loginJs).toContain("signInWithApple");
        expect(loginJs).toContain("isAppleSignInAvailable");
        // The Apple availability probe is iOS-gated in the runtime so
        // the button can never surface in the Android package.
        expect(runtime).toContain('Capacitor.getPlatform() !== "ios"');
    });

    test("the App target declares the Sign in with Apple entitlement", () => {
        const entitlements = read("ios/App/App/App.entitlements");
        expect(entitlements).toContain("com.apple.developer.applesignin");
        expect(entitlements).toContain("<string>Default</string>");
    });

    test("CI ensures the APPLE_ID_AUTH capability before minting the profile", () => {
        const workflow = read(".github/workflows/mobile-ios.yml");
        const ensure = workflow.indexOf('"APPLE_ID_AUTH"');
        const mint = workflow.indexOf('"/profiles"');
        expect(ensure).toBeGreaterThan(-1);
        expect(mint).toBeGreaterThan(-1);
        expect(ensure).toBeLessThan(mint);
        expect(workflow).toContain("bun scripts/configure-mobile-ios.ts");
    });
});
