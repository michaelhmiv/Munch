#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(
    path: string,
    before: string,
    after: string,
    label: string,
) {
    const source = await readFile(path, "utf8");
    const occurrences = source.split(before).length - 1;
    if (occurrences !== 1) {
        throw new Error(
            `${label}: expected exactly one match, found ${occurrences}`,
        );
    }
    await writeFile(path, source.replace(before, after));
}

const routes = "src/app/routes.ts";
await replaceOnce(
    routes,
    'import { getSubscriptionSnapshot } from "../billing/repository.js";',
    'import { getDirectSubscriptionSnapshot } from "../billing/subscription-sources.js";',
    "settings subscription import",
);
await replaceOnce(
    routes,
    "getSubscriptionSnapshot(userId),",
    "getDirectSubscriptionSnapshot(userId),",
    "settings direct subscription lookup",
);
await replaceOnce(
    routes,
    `                entitlementSource: capabilities.entitlementSource,\n                canInvite: false,`,
    `                entitlementSource: capabilities.entitlementSource,\n                canCreateHousehold: await ownerCanPurchaseHouseholdSeats(userId),\n                canInvite: false,`,
    "empty household create capability",
);
await replaceOnce(
    routes,
    `            entitlementSource: capabilities.entitlementSource,\n            canInvite,`,
    `            entitlementSource: capabilities.entitlementSource,\n            canCreateHousehold: false,\n            canInvite,`,
    "active household create capability",
);

const account = "public/app-account.js";
await replaceOnce(
    account,
    "            `${planLabel(data)} · manage website billing`,",
    "            `${planLabel(data)} · subscription & charges`,",
    "settings billing card copy",
);
await replaceOnce(
    account,
    `    const status = data.subscription?.status || null;\n    let billingSummary = "Free";`,
    `    const status = data.subscription?.status || null;\n    const provider = data.subscription?.provider || null;\n    let billingSummary = "Free";`,
    "billing provider state",
);
await replaceOnce(
    account,
    `    } else if (directPremium) {\n        billingSummary = \`Munch Premium · \${premiumPrice}/month\`;\n        detail = status\n            ? \`Stripe subscription status: \${status}.\`\n            : "Your account currently has Premium capabilities.";\n    }`,
    `    } else if (directPremium) {\n        billingSummary = \`Munch Premium · \${premiumPrice}/month\`;\n        if (provider === "google_play") {\n            detail = status\n                ? \`Google Play subscription status: \${status}.\`\n                : "Your account currently has Google Play Premium capabilities.";\n        } else if (provider === "stripe") {\n            detail = status\n                ? \`Stripe subscription status: \${status}.\`\n                : "Your account currently has Premium capabilities.";\n        } else {\n            detail = "Your account currently has Premium capabilities.";\n        }\n    }`,
    "provider-aware billing summary",
);
await replaceOnce(
    account,
    `        : directPremium\n          ? \`<button class="button button-primary" data-action="billing-portal">Manage billing in Stripe</button>\`\n          : \`<button class="button button-primary" data-action="billing-checkout">Get Premium — \${premiumPrice}/month</button>\`;`,
    `        : directPremium\n          ? provider === "google_play"\n              ? \`<button class="button button-primary" data-action="billing-play-manage">Manage in Google Play</button>\`\n              : \`<button class="button button-primary" data-action="billing-portal">Manage billing in Stripe</button>\`\n          : \`<button class="button button-primary" data-action="billing-checkout">Get Premium — \${premiumPrice}/month</button>\`;`,
    "provider-aware billing action",
);
await replaceOnce(
    account,
    `\${sectionHeading("Billing", "Plan & billing", "See exactly how your Munch access is funded. Payment methods, invoices and cancellation remain hosted by Stripe.")}`,
    `\${sectionHeading("Billing", "Plan & billing", "See exactly how your Munch access is funded. Manage payment and cancellation with the provider that owns the active subscription.")}`,
    "provider-aware billing heading",
);
await replaceOnce(
    account,
    `            data.tier === "premium" &&\n            data.entitlementSource !== "household_subscription"`,
    `            data.tier === "premium" &&\n            data.canCreateHousehold === true`,
    "household create billing gate",
);
await replaceOnce(
    account,
    `        return \`<div class="settings-empty household-empty"><span class="more-icon" aria-hidden="true">⌂</span><h2>No household is connected</h2><p>Premium owners can create a household and add additional members for \${seatPrice}/month each.</p><a class="button button-primary" href="/app/settings/billing">View plan & billing</a></div>\`;`,
    `        const householdMessage =\n            data.tier === "premium"\n                ? "Your current Premium subscription covers your personal features. Discounted household seats are currently available through Munch website billing."\n                : \`Premium owners can create a household and add additional members for \${seatPrice}/month each.\`;\n        return \`<div class="settings-empty household-empty"><span class="more-icon" aria-hidden="true">⌂</span><h2>No household is connected</h2><p>\${esc(householdMessage)}</p><a class="button button-primary" href="/app/settings/billing">View plan & billing</a></div>\`;`,
    "household Play billing copy",
);
await replaceOnce(
    account,
    `    if (action === "connection-revoke") {`,
    `    if (action === "billing-play-manage") {\n        window.open(\n            "https://play.google.com/store/account/subscriptions",\n            "_blank",\n            "noopener,noreferrer",\n        );\n        return true;\n    }\n    if (action === "connection-revoke") {`,
    "web Google Play management action",
);

console.log("Patched shared app surfaces for provider-aware Play billing.");
