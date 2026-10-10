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
await cp(
    "mobile/android/MunchGoogleSignInPlugin.java",
    `${javaDir}/MunchGoogleSignInPlugin.java`,
);

const buildGradlePath = "android/app/build.gradle";
let buildGradle = await readFile(buildGradlePath, "utf8");
const requiredDependencies = [
    "com.android.billingclient:billing:9.1.0",
    "androidx.credentials:credentials:1.6.0",
    "androidx.credentials:credentials-play-services-auth:1.6.0",
    "com.google.android.libraries.identity.googleid:googleid:1.2.1",
];
for (const dependency of requiredDependencies) {
    if (!buildGradle.includes(dependency)) {
        buildGradle = buildGradle.replace(
            "dependencies {",
            `dependencies {\n    implementation "${dependency}"`,
        );
    }
    if (!buildGradle.includes(dependency)) {
        throw new Error(`Android dependency is missing: ${dependency}`);
    }
}
await writeFile(buildGradlePath, buildGradle);

const manifestPath = "android/app/src/main/AndroidManifest.xml";
let manifest = await readFile(manifestPath, "utf8");
manifest = manifest.replace(
    'android:allowBackup="true"',
    'android:allowBackup="false"',
);
if (!manifest.includes('android:usesCleartextTraffic="false"')) {
    const secureTheme = [
        'android:theme="@style/AppTheme"',
        '        android:usesCleartextTraffic="false">',
    ].join("\n");
    manifest = manifest.replace(
        'android:theme="@style/AppTheme">',
        secureTheme,
    );
}
const deepLink = [
    "            <intent-filter>",
    '                <action android:name="android.intent.action.VIEW" />',
    '                <category android:name="android.intent.category.DEFAULT" />',
    '                <category android:name="android.intent.category.BROWSABLE" />',
    '                <data android:scheme="munch" android:host="app" />',
    "            </intent-filter>",
    "",
].join("\n");
if (!manifest.includes('android:scheme="munch"')) {
    manifest = manifest.replace(
        "        </activity>",
        `${deepLink}        </activity>`,
    );
}
const verifiedAuthLink = [
    '            <intent-filter android:autoVerify="true">',
    '                <action android:name="android.intent.action.VIEW" />',
    '                <category android:name="android.intent.category.DEFAULT" />',
    '                <category android:name="android.intent.category.BROWSABLE" />',
    "                <data",
    '                    android:scheme="https"',
    '                    android:host="munch.business"',
    '                    android:pathPrefix="/mobile/auth/callback" />',
    "            </intent-filter>",
    "",
].join("\n");
if (!manifest.includes('android:pathPrefix="/mobile/auth/callback"')) {
    manifest = manifest.replace(
        "        </activity>",
        `${verifiedAuthLink}        </activity>`,
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
    "Configured Android API 36, Billing, sign-in, App Links, and plugins",
);
