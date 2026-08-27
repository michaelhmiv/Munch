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

await replaceOnce(
    "public/privacy.html",
    "Last updated: August 25, 2026",
    "Last updated: August 27, 2026",
    "privacy date",
);
await replaceOnce(
    "public/privacy.html",
    `                                Stripe customer, subscription, entitlement,\n                                renewal, cancellation, payment-status,\n                                seat-quantity, and household billing metadata.\n                                Munch does not store raw card numbers or payment\n                                credentials.`,
    `                                Stripe and app-store subscription, entitlement,\n                                renewal, cancellation, payment-status, purchase,\n                                seat-quantity, and household billing metadata.\n                                Google Play purchase tokens are retained only in\n                                the billing backend so Munch can verify lifecycle\n                                state; they are not returned to the app UI. Munch\n                                does not store raw card numbers or payment\n                                credentials.`,
    "privacy billing data",
);
await replaceOnce(
    "public/privacy.html",
    `                            When an eligible Premium user uploads a Pantry,\n                            refrigerator, freezer, or grocery-receipt image\n                            through the Munch website, Munch sends that image\n                            transiently to its configured AI processor to\n                            extract structured food or purchase candidates.`,
    `                            When an eligible Premium user uploads a Pantry,\n                            refrigerator, freezer, meal, or grocery-receipt image\n                            through the Munch website or installed mobile app,\n                            including through the mobile camera or photo picker,\n                            Munch sends that image transiently to its configured\n                            AI processor when AI-assisted extraction is used to\n                            extract structured food or purchase candidates.`,
    "privacy mobile images",
);
await replaceOnce(
    "public/privacy.html",
    `                            <li>\n                                <strong>Stripe</strong> processes Premium\n                                checkout, recurring billing, payment methods,\n                                invoices, cancellations, and subscription\n                                recovery on the Munch website.\n                            </li>`,
    `                            <li>\n                                <strong>Stripe</strong> processes Premium\n                                checkout, recurring billing, payment methods,\n                                invoices, cancellations, and subscription\n                                recovery on the Munch website, including\n                                household-seat billing.\n                            </li>\n                            <li>\n                                <strong>Google Play</strong> processes Android\n                                in-app Premium purchases, recurring billing,\n                                localized pricing and taxes, cancellations, and\n                                subscription lifecycle events. Munch verifies\n                                Android subscription state with Google before\n                                granting or changing Premium access.\n                            </li>`,
    "privacy Google Play provider",
);
await replaceOnce(
    "public/privacy.html",
    `                                <strong>OpenRouter</strong> receives Pantry or\n                                receipt images uploaded through the Munch\n                                website when AI-assisted extraction is enabled,`,
    `                                <strong>OpenRouter</strong> receives Pantry,\n                                meal, or receipt images uploaded through the Munch\n                                website or installed mobile app when AI-assisted\n                                extraction is enabled,`,
    "privacy OpenRouter mobile wording",
);
await replaceOnce(
    "public/privacy.html",
    `                            Munch uses HTTPS in production, signed and expiring\n                            sessions, OAuth authorization with PKCE, verified\n                            Stripe webhook signatures, rate limiting, bounded\n                            request bodies, hashed invitation and export tokens,\n                            and forced PostgreSQL row-level security for\n                            personal and household records.`,
    `                            Munch uses HTTPS in production, signed and expiring\n                            sessions, OAuth authorization with PKCE, verified\n                            Stripe webhook signatures, server-side Google Play\n                            purchase verification, authenticated Google Pub/Sub\n                            subscription notifications, rate limiting, bounded\n                            request bodies, hashed invitation and export tokens,\n                            and forced PostgreSQL row-level security for personal\n                            and household records.`,
    "privacy Play security",
);
await replaceOnce(
    "public/privacy.html",
    `                            You can revoke individual ChatGPT/MCP connections,\n                            manage website billing through Stripe, leave a\n                            household, transfer ownership, dissolve a household,\n                            and permanently delete your Munch account through\n                            available controls.`,
    `                            You can revoke individual ChatGPT/MCP connections,\n                            manage subscription billing through the applicable\n                            provider, leave a household, transfer ownership,\n                            dissolve a household, and permanently delete your\n                            Munch account through available controls.`,
    "privacy provider billing controls",
);
await replaceOnce(
    "public/privacy.html",
    `                            logs, database backups, Stripe records, or records\n                            Munch must retain for fraud, accounting, legal, or\n                            dispute purposes.`,
    `                            logs, database backups, Stripe or Google Play\n                            records, or records Munch must retain for fraud,\n                            accounting, legal, or dispute purposes.`,
    "privacy deletion provider records",
);
await replaceOnce(
    "public/privacy.html",
    `                            overwrites them. Stripe may retain billing,\n                            accounting, fraud, dispute, and tax records for the\n                            periods required by law and its own policies.`,
    `                            overwrites them. Stripe and Google Play may retain\n                            billing, accounting, fraud, dispute, and tax records\n                            for the periods required by law and their own\n                            policies.`,
    "privacy retention providers",
);

await replaceOnce(
    "public/terms.html",
    `content="Terms governing Munch Free, Premium, household workspaces, website billing, OAuth connections, and MCP nutrition tools."`,
    `content="Terms governing Munch Free, Premium, household workspaces, website and app-store billing, OAuth connections, and MCP nutrition tools."`,
    "terms description",
);
await replaceOnce(
    "public/terms.html",
    "Last updated: August 11, 2026",
    "Last updated: August 27, 2026",
    "terms date",
);
await replaceOnce(
    "public/terms.html",
    `                            Munch Premium is an optional subscription purchased\n                            independently on the Munch website for $4.99 per\n                            month, plus applicable taxes. The paid subscription\n                            begins when Stripe confirms checkout and renews each\n                            month until canceled. You authorize Stripe to charge\n                            the saved payment method for recurring fees and\n                            applicable taxes.`,
    `                            Munch Premium is an optional recurring subscription.\n                            On the Munch website, the current direct price is\n                            $4.99 per month plus applicable taxes and is processed\n                            by Stripe. In the installed Android app, Premium may\n                            instead be purchased through Google Play at the\n                            localized price, taxes, renewal terms, and billing\n                            conditions shown by Google Play. A paid subscription\n                            begins only after the applicable billing provider and\n                            Munch verification confirm entitlement and renews\n                            until canceled.`,
    "terms Premium providers",
);
await replaceOnce(
    "public/terms.html",
    `                            Payment methods, invoices, and cancellation are\n                            managed through the Stripe-hosted customer portal\n                            linked from the Munch account portal. Cancellation\n                            normally takes effect at the end of the current paid\n                            period unless Stripe or applicable law provides\n                            otherwise. Canceling Premium does not delete the\n                            Munch account or personal data; the account returns\n                            to applicable Free capabilities.`,
    `                            Payment methods, invoices, and cancellation are\n                            managed through the provider that billed the\n                            subscription: the Stripe-hosted customer portal for\n                            website subscriptions or Google Play subscription\n                            management for Android in-app subscriptions.\n                            Cancellation normally takes effect according to the\n                            provider's current-period rules and applicable law.\n                            Canceling Premium does not delete the Munch account\n                            or personal data; the account returns to applicable\n                            Free capabilities after paid access ends.`,
    "terms provider cancellation",
);
await replaceOnce(
    "public/terms.html",
    `                            enables paid household seats, the owner's Premium\n                            subscription covers the owner and each active\n                            additional member adds the current recurring seat\n                            price shown on the Munch website (currently $2.00\n                            per month per seat), with applicable proration.`,
    `                            enables paid household seats, the owner's\n                            Stripe-backed website Premium subscription covers the\n                            owner and each active additional member adds the\n                            current recurring seat price shown on the Munch\n                            website (currently $2.00 per month per seat), with\n                            applicable proration. Google Play Premium provides\n                            personal Premium capabilities but does not fund or\n                            authorize discounted household seats.`,
    "terms household provider boundary",
);
await replaceOnce(
    "public/terms.html",
    `                            Munch depends on services operated by OpenAI,\n                            Stripe, Railway, Resend, USDA FoodData Central, Open\n                            Food Facts, and other infrastructure providers.`,
    `                            Munch depends on services operated by OpenAI,\n                            Stripe, Google Play, Railway, Resend, USDA FoodData\n                            Central, Open Food Facts, and other infrastructure\n                            providers.`,
    "terms Google Play third party",
);
await replaceOnce(
    "public/terms.html",
    `                            through available controls. Deleting a Munch account\n                            does not automatically cancel an active Stripe\n                            subscription or erase Stripe's legally required\n                            billing records.`,
    `                            through available controls. Deleting a Munch account\n                            does not automatically cancel an active Stripe or\n                            Google Play subscription or erase the applicable\n                            provider's legally required billing records.`,
    "terms deletion provider billing",
);

await rm(".github/workflows/play-release-legal-helper.yml", { force: true });
await rm("scripts/patch-play-release-legal.ts", { force: true });

console.log("Updated Munch legal surfaces for Android/Google Play release.");
