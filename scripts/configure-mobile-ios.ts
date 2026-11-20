#!/usr/bin/env bun

import { cp, readFile } from "node:fs/promises";

// The iOS counterpart of scripts/configure-mobile-android.ts: the
// canonical first-party plugin sources live in mobile/ios/ and are
// copied into the App target, where the copies are committed and the
// Xcode project references them. Capacitor's `cap sync ios` only
// manages the CapApp-SPM package — App-target Swift files survive it —
// so this copy step is the whole drift surface, and the iOS workflow
// runs it right after `cap sync ios` so the reproducibility check
// (`git diff --exit-code -- ios ...`) covers both. Bridge-contract
// drift is additionally pinned by src/ios-native-bridge.test.ts.
//
// The ads plugin follows the same copy pattern; the project/plist
// wiring that `cap sync` does not own (Swift package dependencies,
// AdMob keys) is verified, never rewritten — a missing piece fails
// the lane instead of being silently patched.
const appDir = "ios/App/App";
for (const file of [
    "MunchSecureSessionPlugin.swift",
    "MunchAppleSignInPlugin.swift",
    "MunchGoogleSignInPlugin.swift",
    "MunchBridgeViewController.swift",
]) {
    await cp(`mobile/ios/${file}`, `${appDir}/${file}`);
}

await cp("mobile/ios/MunchAdsPlugin.swift", "ios/App/App/MunchAdsPlugin.swift");
const plugin = await readFile("ios/App/App/MunchAdsPlugin.swift", "utf8");
if (!plugin.includes('public let jsName = "MunchAds"')) {
    throw new Error("iOS ads plugin lost its MunchAds bridge name");
}
if (!plugin.includes('"npa": "1"')) {
    throw new Error(
        "iOS ads plugin lost the non-personalized request extra (PR #255)",
    );
}

const project = await readFile("ios/App/App.xcodeproj/project.pbxproj", "utf8");
for (const required of [
    "MunchAdsPlugin.swift",
    "swift-package-manager-google-mobile-ads.git",
    "swift-package-manager-google-user-messaging-platform.git",
    "productName = GoogleMobileAds;",
    "productName = GoogleUserMessagingPlatform;",
]) {
    if (!project.includes(required)) {
        throw new Error(`iOS project is missing ads wiring: ${required}`);
    }
}

// The Google sign-in wiring follows the same verify-never-rewrite
// rule: the GIDSignIn Swift package dependency and the plugin's
// project membership are committed project state; a missing piece
// fails the lane instead of being silently patched.
for (const required of [
    "MunchGoogleSignInPlugin.swift",
    "google/GoogleSignIn-iOS.git",
    "productName = GoogleSignIn;",
]) {
    if (!project.includes(required)) {
        throw new Error(
            `iOS project is missing Google sign-in wiring: ${required}`,
        );
    }
}

const infoPlist = await readFile("ios/App/App/Info.plist", "utf8");
if (
    !infoPlist.includes(
        "<string>ca-app-pub-2708638041809482~8470224712</string>",
    )
) {
    throw new Error("Info.plist is missing the iOS AdMob application ID");
}
if (!infoPlist.includes("<key>NSUserTrackingUsageDescription</key>")) {
    throw new Error("Info.plist is missing the ATT usage description");
}
if (!infoPlist.includes("cstr6suwn9.skadnetwork")) {
    throw new Error("Info.plist is missing the SKAdNetwork items");
}
// The reversed client ID of the "Munch iOS" OAuth client
// (949731430033-87g1d2pd73432f4mft6t9f6jvvltn5ii) — the URL scheme
// the Google Sign-In OAuth redirect returns on.
if (
    !infoPlist.includes(
        "<string>com.googleusercontent.apps.949731430033-87g1d2pd73432f4mft6t9f6jvvltn5ii</string>",
    )
) {
    throw new Error(
        "Info.plist is missing the Google sign-in redirect URL scheme",
    );
}

console.log(
    "Configured iOS first-party plugins, ads plugin, SPM ad packages, AdMob Info.plist keys, and Google sign-in wiring",
);
