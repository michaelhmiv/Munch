import { PRODUCT_CONFIG, formatMonthlyPrice } from "../src/product-config.js";

const errors: string[] = [];

function normalizedText(source: string): string {
    return source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

if (PRODUCT_CONFIG.trialEnabled) {
    errors.push("PRODUCT_CONFIG.trialEnabled must remain false");
}
if (!PRODUCT_CONFIG.freeTierEnabled) {
    errors.push("The permanent Free tier must remain enabled");
}

const publicHtml = new Bun.Glob("public/**/*.html");
for await (const path of publicHtml.scan({ cwd: "." })) {
    const source = await Bun.file(path).text();
    if (/\btrial\b/i.test(normalizedText(source))) {
        errors.push(`${path}: contains user-facing trial language`);
    }
}

const stripeClient = await Bun.file("src/billing/stripe-client.ts").text();
for (const forbidden of [
    "trial_period_days",
    "MUNCH_TRIAL_DAYS",
    "trialDays",
]) {
    if (stripeClient.includes(forbidden)) {
        errors.push(`Stripe checkout still contains ${forbidden}`);
    }
}

const terms = normalizedText(await Bun.file("public/terms.html").text());
for (const required of [
    "permanent core access",
    "optional subscription",
    formatMonthlyPrice(),
    "support@munch.business",
    "State of South Carolina",
]) {
    if (!terms.includes(required)) {
        errors.push(`Terms are missing required text: ${required}`);
    }
}

const privacy = normalizedText(await Bun.file("public/privacy.html").text());
for (const required of [
    "10 minutes",
    "30 days",
    "5 minutes",
    "15 minutes",
    "90 days",
    "one hour",
    "support@munch.business",
    "security@munch.business",
]) {
    if (!privacy.includes(required)) {
        errors.push(`Privacy Policy is missing retention/contact text: ${required}`);
    }
}

const help = await Bun.file("public/help.html").text();
if (!help.includes("mailto:support@munch.business")) {
    errors.push("Help page must provide a direct support email");
}

const environmentExample = await Bun.file(".env.example").text();
if (!/^OPENAI_APPS_CHALLENGE=$/m.test(environmentExample)) {
    errors.push(".env.example must document OPENAI_APPS_CHALLENGE");
}

if (errors.length > 0) {
    console.error("Policy consistency check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log("Policy consistency check passed.");
