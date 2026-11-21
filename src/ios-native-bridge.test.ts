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
    const googleSignInSwift = read("mobile/ios/MunchGoogleSignInPlugin.swift");
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
            "MunchGoogleSignInPlugin.swift",
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

    test("the Xcode project compiles all four first-party Swift files into the App target", () => {
        const project = read("ios/App/App.xcodeproj/project.pbxproj");
        for (const file of [
            "MunchSecureSessionPlugin.swift",
            "MunchAppleSignInPlugin.swift",
            "MunchGoogleSignInPlugin.swift",
            "MunchBridgeViewController.swift",
        ]) {
            expect(project).toContain(`${file} in Sources`);
            expect(project).toContain(`path = ${file};`);
        }
    });

    test("the bridge view controller registers the first-party plugins and SceneDelegate uses it", () => {
        expect(bridgeViewController).toContain("CAPBridgeViewController");
        expect(bridgeViewController).toContain(
            "registerPluginInstance(MunchSecureSessionPlugin())",
        );
        expect(bridgeViewController).toContain(
            "registerPluginInstance(MunchAppleSignInPlugin())",
        );
        expect(bridgeViewController).toContain(
            "registerPluginInstance(MunchGoogleSignInPlugin())",
        );
        expect(read("ios/App/App/SceneDelegate.swift")).toContain(
            "MunchBridgeViewController()",
        );
    });

    test("SecureSession exposes the same nine bridge methods on iOS and Android", () => {
        const methods = [
            "getToken",
            "setToken",
            "clearToken",
            "getPendingAuth",
            "setPendingAuth",
            "clearPendingAuth",
            "getPendingLinkPrompt",
            "setPendingLinkPrompt",
            "clearPendingLinkPrompt",
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
        // token 16384 chars, pending auth 4096 chars, pending link
        // prompt 512 chars; unreadable stored values are deleted rather
        // than trusted.
        expect(secureSessionSwift).toContain("tokenLimit = 16384");
        expect(secureSessionSwift).toContain("pendingAuthLimit = 4096");
        expect(secureSessionSwift).toContain("pendingLinkPromptLimit = 512");
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
        expect(secureSessionSwift).toContain(
            '"Unable to read the pending Munch link prompt"',
        );
        expect(secureSessionSwift).toContain(
            '"A valid pending Munch link prompt is required"',
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

    test("the APPLE_ID_AUTH create carries the documented consent setting", () => {
        const workflow = read(".github/workflows/mobile-ios.yml");
        const ensure = workflow.indexOf('"APPLE_ID_AUTH"');
        const mint = workflow.indexOf('"/profiles"');
        const block = workflow.slice(ensure, mint);
        // The ASC API rejects an APPLE_ID_AUTH create with no settings
        // (409 ENTITY_ERROR: "Please select at least one configuration
        // for Sign In with Apple."). Apple's CapabilitySetting and
        // CapabilityOption references document the configuration as the
        // APPLE_ID_AUTH_APP_CONSENT setting with the PRIMARY_APP_CONSENT
        // option enabled (this bundle ID is the primary App ID).
        expect(block).toContain('"settings"');
        expect(block).toContain('"APPLE_ID_AUTH_APP_CONSENT"');
        expect(block).toContain('"PRIMARY_APP_CONSENT"');
        expect(block).toContain('"enabled": True');
    });

    test("the Google plugin runs GIDSignIn and returns only an ID token", () => {
        expect(googleSignInSwift).toContain('jsName = "MunchGoogleSignIn"');
        expect(googleSignInSwift).toContain("import GoogleSignIn");
        expect(googleSignInSwift).toContain("GIDSignIn.sharedInstance");
        expect(googleSignInSwift).toContain("GIDConfiguration(");
        // The runtime hands over the iOS platform's identifiers from
        // GET /mobile/auth/google-config plus its raw nonce; the SDK
        // returns the nonce as the token's claim for the server
        // verifier, exactly like the Android plugin's contract.
        expect(googleSignInSwift).toContain('call.getString("clientId")');
        expect(googleSignInSwift).toContain('call.getString("serverClientId")');
        expect(googleSignInSwift).toContain('call.getString("nonce")');
        expect(googleSignInSwift).toContain('["idToken": idToken]');
        // Failure shapes mirror the sibling plugins: not configured,
        // no token, and one shared cancelled/could-not-complete line
        // the login page prints verbatim.
        expect(googleSignInSwift).toContain(
            '"Google sign-in is not configured"',
        );
        expect(googleSignInSwift).toContain(
            '"Google did not return an ID token"',
        );
        expect(googleSignInSwift).toContain(
            '"Google sign-in was cancelled or could not be completed"',
        );
        expect(read("scripts/configure-mobile-ios.ts")).toContain(
            "MunchGoogleSignInPlugin.swift",
        );
    });

    test("the runtime gates the Google door on the iOS platform block", () => {
        expect(runtime).toContain('registerPlugin("MunchGoogleSignIn")');
        expect(runtime).toContain("/mobile/auth/google-config");
        // On iOS the runtime reads platforms.ios and passes the iOS
        // client ID + web client ID (as serverClientId) to the
        // plugin; the Android call keeps its webClientId shape.
        expect(runtime).toContain('Capacitor.getPlatform() === "ios"');
        expect(runtime).toContain("payload.platforms?.ios");
        expect(runtime).toContain("clientId: config.clientId");
        expect(runtime).toContain("serverClientId: config.serverClientId");
        expect(runtime).toContain("webClientId: config.webClientId");
        // The packaged sign-in surface carries the Google door in the
        // shared grammar, shown only when the platform probe passes.
        const loginHtml = read("mobile/mobile-login.html");
        expect(loginHtml).toContain('id="google-sign-in"');
        expect(loginHtml).toContain("Continue with Google");
        const loginJs = read("mobile/mobile-login.js");
        expect(loginJs).toContain("signInWithGoogle");
        expect(loginJs).toContain("isGoogleSignInAvailable");
    });

    test("the Google SDK package and OAuth redirect scheme are wired", () => {
        const project = read("ios/App/App.xcodeproj/project.pbxproj");
        expect(project).toContain("google/GoogleSignIn-iOS.git");
        expect(project).toContain("productName = GoogleSignIn;");
        expect(project).toContain("GoogleSignIn in Frameworks");
        // The OAuth redirect returns on the reversed client ID of
        // the Munch iOS OAuth client; the scheme in Info.plist must
        // be that client's exact reversal.
        const infoPlist = read("ios/App/App/Info.plist");
        expect(infoPlist).toContain(
            "com.googleusercontent.apps.949731430033-87g1d2pd73432f4mft6t9f6jvvltn5ii",
        );
        expect(read("scripts/configure-mobile-ios.ts")).toContain(
            "com.googleusercontent.apps.949731430033-87g1d2pd73432f4mft6t9f6jvvltn5ii",
        );
        // Both URL entry points give GIDSignIn first claim on the
        // redirect (AppDelegate per the SDK's documented integration,
        // SceneDelegate because that is the path this app takes).
        expect(read("ios/App/App/AppDelegate.swift")).toContain(
            "GIDSignIn.sharedInstance.handle(url)",
        );
        expect(read("ios/App/App/SceneDelegate.swift")).toContain(
            "GIDSignIn.sharedInstance.handle",
        );
    });
});
