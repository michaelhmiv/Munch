#!/usr/bin/env bun

Object.assign(process.env, {
    NODE_ENV: "production",
    MUNCH_APP_BASE_URL: "https://munch.example",
    BETTER_AUTH_SECRET:
        "operations-smoke-better-auth-secret-0123456789abcdef0123456789abcdef",
    RESEND_API_KEY: "re_test_operations",
    MUNCH_EMAIL_FROM: "Munch <support@munch.example>",
    STRIPE_SECRET_KEY: "sk_test_operations",
    STRIPE_WEBHOOK_SECRET: "whsec_operations",
    STRIPE_PRICE_ID: "price_operations",
    STRIPE_HOUSEHOLD_MEMBER_PRICE_ID: "price_household_operations",
    OFF_USER_AGENT: "Munch operations smoke (test@example.com)",
    USDA_FDC_API_KEY: "operations-usda-key",
    MUNCH_DB_POOL_SIZE: "5",
    RAILWAY_GIT_COMMIT_SHA: "operations-smoke-sha",
    RAILWAY_DEPLOYMENT_ID: "operations-smoke-deployment",
    RAILWAY_ENVIRONMENT_NAME: "production",
    RAILWAY_SERVICE_ID: "operations-smoke-service",
});

const { Hono } = await import("hono");
const { buildReadinessReport } = await import("../src/operations/readiness.js");
const { createOperationsRouter } = await import("../src/operations/routes.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for operations smoke tests");
}

const report = await buildReadinessReport();
if (!report.ready || report.backend !== "railway") {
    throw new Error(`Readiness failed: ${JSON.stringify(report)}`);
}
for (const required of [
    "configuration",
    "database",
    "migrations",
    "database_roles",
    "row_level_security",
]) {
    if (
        !report.components.some(
            (component) => component.name === required && component.ok,
        )
    ) {
        throw new Error(`Readiness component ${required} was unavailable`);
    }
}

const app = new Hono();
app.route("/", createOperationsRouter());
const live = await app.request("https://munch.example/health/live");
if (live.status !== 200 || live.headers.get("cache-control") !== "no-store") {
    throw new Error("Liveness route failed");
}
const ready = await app.request("https://munch.example/health/ready");
if (
    ready.status !== 200 ||
    !((await ready.json()) as { ready: boolean }).ready
) {
    throw new Error("Readiness route failed");
}
const version = await app.request("https://munch.example/health/version");
if (version.status !== 200 || version.headers.get("cache-control") !== "no-store") {
    throw new Error("Version route failed");
}
const release = (await version.json()) as {
    git_sha?: string;
    deployment_id?: string;
    environment?: string;
    service_id?: string;
};
if (
    release.git_sha !== "operations-smoke-sha" ||
    release.deployment_id !== "operations-smoke-deployment" ||
    release.environment !== "production" ||
    release.service_id !== "operations-smoke-service"
) {
    throw new Error(`Version route returned unexpected data: ${JSON.stringify(release)}`);
}

await closePlatformDatabase();
const maintenance = Bun.spawn(["bun", "scripts/maintenance.ts"], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
});
const [exitCode, stdout, stderr] = await Promise.all([
    maintenance.exited,
    new Response(maintenance.stdout).text(),
    new Response(maintenance.stderr).text(),
]);
if (exitCode !== 0) {
    throw new Error(`Maintenance failed: ${stderr || stdout}`);
}
const result = JSON.parse(stdout.trim()) as { maintenance?: string };
if (result.maintenance !== "complete") {
    throw new Error("Maintenance did not return a completion result");
}

console.log("Munch readiness, release identity, and maintenance smoke test passed.");
