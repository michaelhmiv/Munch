#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

interface MobileReleaseMetadata {
    versionName: string;
    androidVersionCode: number;
    iosBuildNumber: number;
}

function requireText(source: string, needle: string, label: string) {
    if (!source.includes(needle)) {
        throw new Error(`${label}: missing ${needle}`);
    }
}

const release = JSON.parse(
    await readFile("mobile/release.json", "utf8"),
) as MobileReleaseMetadata;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(release.versionName)) {
    throw new Error("mobile/release.json versionName must be a semantic version");
}
if (
    !Number.isInteger(release.androidVersionCode) ||
    release.androidVersionCode < 1 ||
    release.androidVersionCode > 2_100_000_000
) {
    throw new Error(
        "mobile/release.json androidVersionCode must be an integer from 1 through 2100000000",
    );
}
if (!Number.isInteger(release.iosBuildNumber) || release.iosBuildNumber < 1) {
    throw new Error(
        "mobile/release.json iosBuildNumber must be a positive integer",
    );
}

const canonicalGradle = await readFile(
    "mobile/android/app-build.gradle",
    "utf8",
);
const generatedGradle = await readFile("android/app/build.gradle", "utf8");
if (canonicalGradle !== generatedGradle) {
    throw new Error(
        "android/app/build.gradle drifted from mobile/android/app-build.gradle; run configure-mobile-android.ts",
    );
}
for (const required of [
    "../mobile/release.json",
    "MOBILE_VERSION_CODE",
    "MOBILE_VERSION_NAME",
    "ANDROID_KEYSTORE_PATH",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
    "signingConfig signingConfigs.release",
]) {
    requireText(canonicalGradle, required, "Android release Gradle contract");
}

const gitignore = await readFile(".gitignore", "utf8");
requireText(gitignore, "*.jks", "Git ignore signing policy");
requireText(gitignore, "*.keystore", "Git ignore signing policy");

const capacitorConfig = await readFile("capacitor.config.ts", "utf8");
requireText(
    capacitorConfig,
    'appId: "business.munch.app"',
    "Capacitor package contract",
);

const productConfig = await readFile("src/product-config.ts", "utf8");
requireText(
    productConfig,
    'googlePlayPackageName: "business.munch.app"',
    "Server Play package contract",
);

const releaseWorkflow = await readFile(
    ".github/workflows/play-release.yml",
    "utf8",
);
for (const required of [
    "bundleRelease",
    "jarsigner -verify",
    "business.munch.app",
    "ANDROID_KEYSTORE_BASE64",
    "PLAY_SERVICE_ACCOUNT_JSON",
    "e738b9dd8f2476ea806d921b64aacd24f34515a5",
]) {
    requireText(releaseWorkflow, required, "Play release workflow");
}

console.log(
    `Mobile release contract passed: ${release.versionName} (Android ${release.androidVersionCode}, iOS build ${release.iosBuildNumber}).`,
);
