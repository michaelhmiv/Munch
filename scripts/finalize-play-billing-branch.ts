#!/usr/bin/env bun

import { readFile, rm, writeFile } from "node:fs/promises";

async function replaceOnce(
    path: string,
    before: string,
    after: string,
    label: string,
) {
    const source = await readFile(path, "utf8");
    const count = source.split(before).length - 1;
    if (count !== 1) {
        throw new Error(`${label}: expected one match, found ${count}`);
    }
    await writeFile(path, source.replace(before, after));
}

async function includeSuspendedSubscriptionsInRestore(path: string) {
    const source = await readFile(path, "utf8");
    const methodStart = source.indexOf("public void restorePremium(PluginCall call)");
    const methodEnd = source.indexOf("private Purchase matchingPurchase", methodStart);
    if (methodStart < 0 || methodEnd < 0) {
        throw new Error(`${path}: restorePremium method boundary not found`);
    }
    const beforeMethod = source.slice(0, methodStart);
    let method = source.slice(methodStart, methodEnd);
    const afterMethod = source.slice(methodEnd);
    const needle = `.setProductType(BillingClient.ProductType.SUBS)\n                .build();`;
    const replacement = `.setProductType(BillingClient.ProductType.SUBS)\n                .includeSuspendedSubscriptions(true)\n                .build();`;
    const count = method.split(needle).length - 1;
    if (count !== 1) {
        throw new Error(`${path}: expected one restore query, found ${count}`);
    }
    method = method.replace(needle, replacement);
    await writeFile(path, beforeMethod + method + afterMethod);
}

for (const path of [
    "mobile/android/MunchPlayBillingPlugin.java",
    "android/app/src/main/java/business/munch/app/MunchPlayBillingPlugin.java",
]) {
    await includeSuspendedSubscriptionsInRestore(path);
}

await replaceOnce(
    "public/app-account.js",
    `        billingSummary = \`Munch Premium · \${premiumPrice}/month\`;\n        if (provider === "google_play") {`,
    `        billingSummary =\n            provider === "google_play"\n                ? "Munch Premium · Google Play"\n                : \`Munch Premium · \${premiumPrice}/month\`;\n        if (provider === "google_play") {`,
    "Google Play localized billing summary",
);
await replaceOnce(
    "public/app-account.js",
    `    const chargeCard = directPremium\n        ? \`<div class="billing-price"><span>Current Munch subscription</span><strong>\${dollars(total)}<small>/month</small></strong>\${ownerHousehold ? \`<p>\${premiumPrice} Premium + \${ownerHousehold.activeNonOwnerCount} household seat\${ownerHousehold.activeNonOwnerCount === 1 ? "" : "s"} × \${seatPrice}.</p>\` : \`<p>Household members are \${seatPrice}/month each when added.</p>\`}</div>\`\n        : "";`,
    `    const chargeCard =\n        directPremium && provider !== "google_play"\n            ? \`<div class="billing-price"><span>Current Munch subscription</span><strong>\${dollars(total)}<small>/month</small></strong>\${ownerHousehold ? \`<p>\${premiumPrice} Premium + \${ownerHousehold.activeNonOwnerCount} household seat\${ownerHousehold.activeNonOwnerCount === 1 ? "" : "s"} × \${seatPrice}.</p>\` : \`<p>Household members are \${seatPrice}/month each when added.</p>\`}</div>\`\n            : "";`,
    "Google Play localized charge card",
);

const smokePath = "scripts/mobile-shell-smoke.ts";
let smoke = await readFile(smokePath, "utf8");
smoke = smoke.replace(
    `const plugin = await readFile(\n    "mobile/android/MunchSecureSessionPlugin.java",\n    "utf8",\n);`,
    `const plugin = await readFile(\n    "mobile/android/MunchSecureSessionPlugin.java",\n    "utf8",\n);\nconst playBillingPlugin = await readFile(\n    "mobile/android/MunchPlayBillingPlugin.java",\n    "utf8",\n);\nconst billingRoutes = await readFile("src/billing/routes.ts", "utf8");\nconst googlePlayClient = await readFile(\n    "src/billing/google-play-client.ts",\n    "utf8",\n);\nconst googlePlayVerifier = await readFile(\n    "src/billing/google-play.ts",\n    "utf8",\n);`,
);
smoke = smoke.replace(
    `requireText(runtime, 'registerPlugin("MunchSecureSession")', "Mobile runtime");`,
    `requireText(runtime, 'registerPlugin("MunchSecureSession")', "Mobile runtime");\nrequireText(runtime, 'registerPlugin("MunchPlayBilling")', "Play Billing runtime");`,
);
smoke = smoke.replace(
    `requireText(server, '"set-auth-token"', "Installed auth CORS contract");`,
    `requireText(server, '"set-auth-token"', "Installed auth CORS contract");\nrequireText(\n    configure,\n    "com.android.billingclient:billing:9.1.0",\n    "Google Play Billing dependency",\n);\nrequireText(\n    playBillingPlugin,\n    "setObfuscatedAccountId",\n    "Google Play account binding",\n);\nrequireText(\n    playBillingPlugin,\n    "queryPurchasesAsync",\n    "Google Play purchase restore",\n);\nrequireText(\n    playBillingPlugin,\n    "includeSuspendedSubscriptions(true)",\n    "Google Play suspended subscription reconciliation",\n);\nif (/acknowledgePurchase/.test(playBillingPlugin)) {\n    throw new Error("Google Play acknowledgement must remain server-owned");\n}\nrequireText(\n    billingRoutes,\n    '"/billing/google-play/verify"',\n    "Google Play verification endpoint",\n);\nrequireText(\n    billingRoutes,\n    'munchAuthTransport") !== "bearer"',\n    "Google Play installed bearer boundary",\n);\nrequireText(\n    googlePlayClient,\n    "/purchases/subscriptionsv2/tokens/",\n    "Google Play SubscriptionPurchaseV2 source of truth",\n);\nrequireText(\n    googlePlayVerifier,\n    "googlePlayObfuscatedAccountId",\n    "Google Play account hash",\n);\nrequireText(\n    buildMobileWeb,\n    'billing-native.js',\n    "Installed Play Billing UI bundle",\n);`,
);
await writeFile(smokePath, smoke);

const gradlePath = "android/app/build.gradle";
const gradle = await readFile(gradlePath, "utf8");
await writeFile(
    gradlePath,
    gradle.replace(
        "https://android.googlesource.com/platforms/base/+/","+
"        "https://android.googlesource.com/platform/frameworks/base/+/",
    ),
);

await rm(".github/workflows/play-billing-shared-helper.yml", { force: true });
await rm("scripts/patch-play-billing-shared-ui.ts", { force: true });

console.log("Finalized Play Billing branch source and removed first helper.");
