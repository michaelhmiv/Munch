#!/usr/bin/env bun

import { cp, readFile } from "node:fs/promises";

// Mirrors scripts/configure-mobile-android.ts for the iOS shell: the
// canonical ads plugin lives in mobile/ios/ and is copied into the app
// target, and the project/plist wiring that `cap sync` does not own
// (Swift package dependencies, AdMob keys) is verified, never rewritten —
// a missing piece fails the lane instead of being silently patched.

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
    "productName = UserMessagingPlatform;",
]) {
    if (!project.includes(required)) {
        throw new Error(`iOS project is missing ads wiring: ${required}`);
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

console.log(
    "Configured iOS ads plugin, SPM ad packages, and AdMob Info.plist keys",
);
