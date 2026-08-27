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
    "100000 + GITHUB_RUN_NUMBER",
    "MOBILE_VERSION_CODE=$VERSION_CODE",
    "whatsNewDirectory: mobile/play/release-notes",
    "e738b9dd8f2476ea806d921b64aacd24f34515a5",
]) {
    requireText(releaseWorkflow, required, "Play release workflow");
}

const buildMobileWeb = await readFile("scripts/build-mobile-web.ts", "utf8");
const runtime = await readFile("mobile/runtime.js", "utf8");
const navigation = await readFile("mobile/navigation.js", "utf8");
const mobileLoginHtml = await readFile("mobile/mobile-login.html", "utf8");
const mobileLoginJs = await readFile("mobile/mobile-login.js", "utf8");
const mobileMagicLinkRoutes = await readFile(
    "src/auth/mobile-magic-link-routes.ts",
    "utf8",
);
const auth = await readFile("src/auth/auth.ts", "utf8");
for (const [source, needle, label] of [
    [runtime, "requestInstalledMagicLink", "Installed passwordless runtime"],
    [runtime, '"/api/auth/magic-link/verify"', "Installed token redemption"],
    [runtime, '"munch:magic-link-error"', "Installed magic-link error path"],
    [navigation, "installedMagicLinkFromUrl", "Installed magic-link parser"],
    [mobileLoginHtml, "mobile-magic-link-form", "Installed passwordless login UI"],
    [mobileLoginJs, "requestInstalledMagicLink", "Installed passwordless login wiring"],
    [mobileMagicLinkRoutes, '"/mobile/confirm"', "Scanner-safe mobile confirmation"],
    [auth, "buildInstalledMagicLinkConfirmation", "Better Auth mobile handoff"],
] as const) {
    requireText(source, needle, label);
}
if (/Magic-link app handoff is being added/i.test(mobileLoginHtml)) {
    throw new Error("Mobile login still contains a pre-release magic-link TODO");
}

const aiReportUi = await readFile("mobile/pantry-ai-report.js", "utf8");
const aiReportRoutes = await readFile(
    "src/inventory/ai-content-report-routes.ts",
    "utf8",
);
const aiReportSchema = await readFile(
    "db/schema/0031_ai_content_reports.sql",
    "utf8",
);
requireText(
    buildMobileWeb,
    "pantry-ai-report.js",
    "Installed AI reporting bundle",
);
requireText(
    aiReportUi,
    "Report AI suggestion",
    "Installed AI reporting control",
);
requireText(
    aiReportUi,
    "/api/app/pantry/meal-ideas/report",
    "Installed AI reporting endpoint",
);
requireText(
    aiReportRoutes,
    "requireSameOrigin",
    "AI reporting mutation boundary",
);
requireText(
    aiReportSchema,
    "ai_content_reports_app_insert",
    "AI report RLS policy",
);
requireText(
    aiReportSchema,
    "ai_content_reports_support_select",
    "AI report support review policy",
);
if (/prompt|pantry contents|image/i.test(aiReportSchema.split("comment on table")[1] ?? "")) {
    requireText(
        aiReportSchema,
        "source prompts, Pantry contents, and images are intentionally excluded",
        "AI report privacy contract",
    );
}

const privacy = await readFile("public/privacy.html", "utf8");
const terms = await readFile("public/terms.html", "utf8");
const deleteAccount = await readFile("public/delete-account.html", "utf8");
requireText(privacy, "Google Play", "Play privacy disclosure");
requireText(terms, "Google Play", "Play terms disclosure");
requireText(
    deleteAccount,
    "Delete your Munch account",
    "External account deletion resource",
);

const requiredPlayFiles = [
    "mobile/play/README.md",
    "mobile/play/HANDOFF.md",
    "mobile/play/data-safety.md",
    "mobile/play/health-declaration.md",
    "mobile/play/content-rating.md",
    "mobile/play/review-access.md",
    "mobile/play/assets.md",
    "mobile/play/listing/en-US.md",
    "mobile/play/release-notes/whatsnew-en-US",
];
for (const path of requiredPlayFiles) {
    const contents = await readFile(path, "utf8");
    if (!contents.trim()) throw new Error(`Play submission file is empty: ${path}`);
}

const listing = await readFile("mobile/play/listing/en-US.md", "utf8");
requireText(
    listing,
    "It is not a medical device",
    "Health listing disclaimer",
);
const dataSafety = await readFile("mobile/play/data-safety.md", "utf8");
requireText(
    dataSafety,
    "https://munch.business/delete-account",
    "Data safety deletion resource",
);
const reviewerAccess = await readFile("mobile/play/review-access.md", "utf8");
requireText(
    reviewerAccess,
    "Use a password instead",
    "Deterministic Play reviewer login",
);

console.log(
    `Mobile release contract passed: ${release.versionName} (local Android ${release.androidVersionCode}, iOS build ${release.iosBuildNumber}).`,
);
