#!/usr/bin/env bun

import { cp, readFile, writeFile } from "node:fs/promises";

const variablesPath = "android/variables.gradle";
let variables = await readFile(variablesPath, "utf8");
variables = variables.replace(/minSdkVersion\s*=\s*24/, "minSdkVersion = 26");
if (!/minSdkVersion\s*=\s*26/.test(variables)) {
    throw new Error("Android minSdkVersion was not raised to 26");
}
if (!/compileSdkVersion\s*=\s*36/.test(variables)) {
    throw new Error("Capacitor Android shell is not compiling against API 36");
}
if (!/targetSdkVersion\s*=\s*36/.test(variables)) {
    throw new Error("Capacitor Android shell is not targeting API 36");
}
await writeFile(variablesPath, variables);

const javaDir = "android/app/src/main/java/business/munch/app";
await cp("mobile/android/MainActivity.java", `${javaDir}/MainActivity.java`);
await cp(
    "mobile/android/MunchSecureSessionPlugin.java",
    `${javaDir}/MunchSecureSessionPlugin.java`,
);
await cp(
    "mobile/android/MunchPlayBillingPlugin.java",
    `${javaDir}/MunchPlayBillingPlugin.java`,
);

// Keep all custom Gradle release/version/signing policy in a canonical source
// outside the generated Android tree. A clean Capacitor sync can always be
// repaired deterministically by this script.
const canonicalBuildGradle = "mobile/android/app-build.gradle";
const buildGradlePath = "android/app/build.gradle";
await cp(canonicalBuildGradle, buildGradlePath);
const buildGradle = await readFile(buildGradlePath, "utf8");
for (const required of [
    "com.android.billingclient:billing:9.1.0",
    "../mobile/release.json",
    "ANDROID_KEYSTORE_PATH",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
]) {
    if (!buildGradle.includes(required)) {
        throw new Error(`Android build.gradle missing required release contract: ${required}`);
    }
}

const manifestPath = "android/app/src/main/AndroidManifest.xml";
let manifest = await readFile(manifestPath, "utf8");
manifest = manifest.replace(
    'android:allowBackup="true"',
    'android:allowBackup="false"',
);
if (!manifest.includes('android:usesCleartextTraffic="false"')) {
    manifest = manifest.replace(
        'android:theme="@style/AppTheme">',
        'android:theme="@style/AppTheme"\n        android:usesCleartextTraffic="false">',
    );
}
const deepLink = `            <intent-filter>\n                <action android:name="android.intent.action.VIEW" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <category android:name="android.intent.category.BROWSABLE" />\n                <data android:scheme="munch" android:host="app" />\n            </intent-filter>\n`;
if (!manifest.includes('android:scheme="munch"')) {
    manifest = manifest.replace(
        "        </activity>",
        `${deepLink}        </activity>`,
    );
}
if (!manifest.includes('android:allowBackup="false"')) {
    throw new Error(
        "Android backups were not disabled for installed credentials",
    );
}
if (!manifest.includes('android:usesCleartextTraffic="false"')) {
    throw new Error("Android cleartext traffic was not disabled");
}
await writeFile(manifestPath, manifest);

console.log(
    "Configured Android API 36 shell, release versioning/signing, Play Billing 9.1.0, deep links, and native plugins",
);
