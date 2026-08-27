#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const config = await readFile("capacitor.config.ts", "utf8");
const runtime = await readFile("mobile/runtime.js", "utf8");
const navigation = await readFile("mobile/navigation.js", "utf8");
const mobileEntry = await readFile("mobile/mobile-entry.js", "utf8");
const mobileLogin = await readFile("mobile/mobile-login.js", "utf8");
const pantryNative = await readFile("mobile/pantry-native.js", "utf8");
const buildMobileWeb = await readFile("scripts/build-mobile-web.ts", "utf8");
const plugin = await readFile(
    "mobile/android/MunchSecureSessionPlugin.java",
    "utf8",
);
const playBillingPlugin = await readFile(
    "mobile/android/MunchPlayBillingPlugin.java",
    "utf8",
);
const billingRoutes = await readFile("src/billing/routes.ts", "utf8");
const googlePlayClient = await readFile(
    "src/billing/google-play-client.ts",
    "utf8",
);
const googlePlayVerifier = await readFile("src/billing/google-play.ts", "utf8");
const googlePlayRtdn = await readFile("src/billing/google-play-rtdn.ts", "utf8");
const googlePubSubAuth = await readFile(
    "src/billing/google-pubsub-auth.ts",
    "utf8",
);
const storeRepository = await readFile(
    "src/billing/store-repository.ts",
    "utf8",
);
const configure = await readFile("scripts/configure-mobile-android.ts", "utf8");
const server = await readFile("src/index.ts", "utf8");
const inventoryRoutes = await readFile("src/inventory/routes.ts", "utf8");
const appRoutes = await readFile("src/app/routes.ts", "utf8");

function requireText(source: string, needle: string, label: string) {
    if (!source.includes(needle))
        throw new Error(`${label}: missing ${needle}`);
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
requireText(
    runtime,
    'const API_BASE_URL = "https://munch.business"',
    "Mobile runtime",
);
requireText(runtime, 'registerPlugin("MunchSecureSession")', "Mobile runtime");
requireText(
    runtime,
    'registerPlugin("MunchPlayBilling")',
    "Play Billing runtime",
);
requireText(runtime, 'credentials: "omit"', "Mobile runtime");
requireText(runtime, "Camera.takePhoto", "Native camera integration");
requireText(
    runtime,
    "Camera.chooseFromGallery",
    "Native photo picker integration",
);
requireText(
    runtime,
    "CapacitorBarcodeScanner.scanBarcode",
    "Native barcode integration",
);
requireText(runtime, '"appRestoredResult"', "Android capture restoration");
requireText(runtime, "App.getLaunchUrl", "Cold-start deep-link restoration");
requireText(runtime, '"appUrlOpen"', "Warm deep-link routing");
requireText(runtime, '"appStateChange"', "Foreground session lifecycle");
requireText(
    runtime,
    '"/api/auth/get-session"',
    "Foreground session validation",
);
requireText(
    runtime,
    "blocksNewPurchase === true",
    "Server-owned duplicate purchase decision",
);
if (/App\.addListener\(["']backButton["']/.test(runtime)) {
    throw new Error(
        "Installed runtime must retain Capacitor's default Android back handling",
    );
}
if (/localStorage/.test(runtime)) {
    throw new Error("Installed bearer credentials must not use localStorage");
}

requireText(
    navigation,
    "^\\/app(?:\\/|$)",
    "Strict installed application route boundary",
);
requireText(
    mobileEntry,
    "restoreInstalledEntryRoute",
    "Installed cold-start bootstrap",
);
requireText(
    mobileEntry,
    "installedLoginUrl",
    "Installed signed-out route preservation",
);
requireText(
    mobileLogin,
    "installedReturnRoute",
    "Installed post-login return validation",
);

requireText(
    plugin,
    'KeyStore.getInstance("AndroidKeyStore")',
    "Keystore plugin",
);
requireText(
    plugin,
    'Cipher.getInstance("AES/GCM/NoPadding")',
    "Keystore plugin",
);
requireText(configure, "minSdkVersion = 26", "Android configuration");
requireText(configure, "compileSdkVersion\\s*=\\s*36", "Android configuration");
requireText(configure, "targetSdkVersion\\s*=\\s*36", "Android configuration");
requireText(
    configure,
    'android:usesCleartextTraffic="false"',
    "Android manifest policy",
);
requireText(server, '"set-auth-token"', "Installed auth CORS contract");
requireText(
    configure,
    "com.android.billingclient:billing:9.1.0",
    "Google Play Billing dependency",
);
requireText(
    playBillingPlugin,
    "setObfuscatedAccountId",
    "Google Play account binding",
);
requireText(
    playBillingPlugin,
    "queryPurchasesAsync",
    "Google Play purchase restore",
);
requireText(
    playBillingPlugin,
    "includeSuspendedSubscriptions(true)",
    "Google Play suspended subscription reconciliation",
);
if (/acknowledgePurchase/.test(playBillingPlugin)) {
    throw new Error("Google Play acknowledgement must remain server-owned");
}
requireText(
    billingRoutes,
    '"/billing/google-play/verify"',
    "Google Play verification endpoint",
);
requireText(
    billingRoutes,
    '"/webhooks/google-play"',
    "Google Play RTDN endpoint",
);
requireText(
    billingRoutes,
    "verifyGooglePubSubPushAuthorization",
    "Authenticated Google Pub/Sub webhook boundary",
);
requireText(
    billingRoutes,
    "upsertStoreAccountBinding",
    "First-purchase RTDN account binding",
);
requireText(
    billingRoutes,
    'munchAuthTransport") !== "bearer"',
    "Google Play installed bearer boundary",
);
requireText(
    googlePlayClient,
    "/purchases/subscriptionsv2/tokens/",
    "Google Play SubscriptionPurchaseV2 source of truth",
);
requireText(
    googlePlayVerifier,
    "googlePlayObfuscatedAccountId",
    "Google Play account hash",
);
requireText(
    googlePlayVerifier,
    "resolveGooglePlayPurchaseUser",
    "RTDN purchase ownership resolution",
);
requireText(
    googlePlayRtdn,
    "recordStoreBillingEvent",
    "RTDN idempotency ledger",
);
requireText(
    googlePlayRtdn,
    "getGooglePlaySubscription",
    "RTDN source-of-truth refresh",
);
requireText(
    googlePubSubAuth,
    "https://www.googleapis.com/oauth2/v3/certs",
    "Google Pub/Sub signing-key source",
);
requireText(
    googlePubSubAuth,
    "pushServiceAccountEmail",
    "Google Pub/Sub service-account validation",
);
requireText(
    googlePubSubAuth,
    "pushAudience",
    "Google Pub/Sub audience validation",
);
requireText(
    storeRepository,
    "store_account_bindings",
    "Opaque app-store account binding repository",
);
requireText(
    buildMobileWeb,
    "billing-native.js",
    "Installed Play Billing UI bundle",
);

requireText(
    pantryNative,
    "/api/app/food-barcode?barcode=",
    "Native barcode canonical lookup",
);
requireText(
    pantryNative,
    '"/api/app/pantry/reconcile"',
    "Native Pantry write contract",
);
requireText(pantryNative, "food_provider:", "Native Pantry provider field");
requireText(
    pantryNative,
    "candidate.provider",
    "Native Pantry provider identity",
);
requireText(
    pantryNative,
    "provider_food_id:",
    "Native Pantry provider food field",
);
requireText(
    pantryNative,
    "candidate.provider_food_id",
    "Native Pantry provider food identity",
);
requireText(
    pantryNative,
    "new DataTransfer()",
    "Native image handoff to existing review flow",
);
requireText(
    buildMobileWeb,
    'src="/pantry-native.js"',
    "Native Pantry bundle injection",
);
requireText(
    inventoryRoutes,
    "foodProvider:",
    "Pantry canonical identity parser",
);
requireText(inventoryRoutes, "providerFoodId:", "Pantry provider food parser");
requireText(inventoryRoutes, "barcode:", "Pantry barcode parser");
requireText(
    appRoutes,
    'app.get("/api/app/food-barcode"',
    "Canonical barcode API",
);

console.log("Installed Android architecture smoke checks passed.");
