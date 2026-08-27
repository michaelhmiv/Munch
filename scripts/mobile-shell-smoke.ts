#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const config = await readFile("capacitor.config.ts", "utf8");
const runtime = await readFile("mobile/runtime.js", "utf8");
const plugin = await readFile(
    "mobile/android/MunchSecureSessionPlugin.java",
    "utf8",
);
const configure = await readFile("scripts/configure-mobile-android.ts", "utf8");
const server = await readFile("src/index.ts", "utf8");

function requireText(source: string, needle: string, label: string) {
    if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}

for (const [name, version] of Object.entries({
    "@capacitor/core": "8.5.0",
    "@capacitor/android": "8.5.0",
    "@capacitor/app": "8.1.1",
    "@capacitor/camera": "8.2.3",
    "@capacitor/barcode-scanner": "3.1.1",
})) {
    if (packageJson.dependencies?.[name] !== version) {
        throw new Error(`${name} must be pinned to ${version}`);
    }
}
if (packageJson.devDependencies?.["@capacitor/cli"] !== "8.5.0") {
    throw new Error("@capacitor/cli must be pinned to 8.5.0");
}

requireText(config, 'appId: "business.munch.app"', "Capacitor config");
requireText(config, 'webDir: ".mobile-web"', "Capacitor config");
requireText(config, 'androidScheme: "https"', "Capacitor config");
requireText(runtime, 'const API_BASE_URL = "https://munch.business"', "Mobile runtime");
requireText(runtime, 'registerPlugin("MunchSecureSession")', "Mobile runtime");
requireText(runtime, 'credentials: "omit"', "Mobile runtime");
if (/localStorage|sessionStorage/.test(runtime)) {
    throw new Error("Installed bearer credentials must not use Web Storage");
}
requireText(plugin, 'KeyStore.getInstance("AndroidKeyStore")', "Keystore plugin");
requireText(plugin, 'Cipher.getInstance("AES/GCM/NoPadding")', "Keystore plugin");
requireText(configure, "minSdkVersion = 26", "Android configuration");
requireText(configure, "compileSdkVersion\\s*=\\s*36", "Android configuration");
requireText(configure, "targetSdkVersion\\s*=\\s*36", "Android configuration");
requireText(configure, 'android:usesCleartextTraffic="false"', "Android manifest policy");
requireText(server, '"set-auth-token"', "Installed auth CORS contract");

console.log("Installed Android architecture smoke checks passed.");
