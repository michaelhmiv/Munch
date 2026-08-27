# Google Play reviewer access

Google Play reviewers must be able to reach all reviewable functionality without needing access to a developer inbox, private invitation, QR code, or ChatGPT account.

Munch already has a dedicated reviewer-account provisioning path (`scripts/provision-reviewer.ts`) that creates a verified password account, grants a time-bounded Premium override, and seeds representative personal/household recipe and planning data. The account uses the same normal Android password sign-in endpoint as other password-enabled accounts; no reviewer-only authorization bypass exists in the app.

## Play Console App access entry

When the production reviewer account has been provisioned, enter these values in **Policy > App content > App access**:

- Access restriction: **All or some functionality is restricted**
- Instruction name: `Munch reviewer account`
- Username/email: use the configured reviewer email
- Password: use the configured reviewer password
- Additional instructions:

> Install and open Munch. On the sign-in screen expand **Use a password instead**. Enter the reviewer email and password supplied here. The account is pre-verified and includes Premium access plus representative recipe, meal-planning, grocery, household, and Pantry-capable state. No email OTP, magic link, QR code, ChatGPT account, payment method, or Google Play purchase is required for review. Account deletion is under Settings > Account. Privacy/export controls are under Settings > Data & privacy. Pantry is available from the main navigation; enable it in Pantry settings if it is not already enabled.

## Reviewer account requirements

The reviewer account must:

- use a dedicated non-personal email address
- use a unique password of at least 16 characters
- be `active` and email-verified
- have a non-expired reviewer Premium override
- contain no real customer or developer personal nutrition information
- remain valid for the entire review period
- be removed or rotated after review when no longer needed

Never commit reviewer credentials to git or put them in store listing text.

## Provisioning command

The repository-supported command is:

```bash
MUNCH_REVIEWER_EMAIL="<reviewer email>" \
MUNCH_REVIEWER_PASSWORD="<unique password>" \
MUNCH_REVIEWER_NAME="Google Play reviewer" \
bun scripts/provision-reviewer.ts
```

It must execute in the Railway production environment (or another environment with production-equivalent database access). The script enables its own tightly scoped reviewer seed mode only inside that process; public password sign-up does not need to be enabled.

The release handoff should provision this account before the first closed-testing upload that requires Play review and then copy only the resulting email/password into the Play Console App access form.

## What reviewers should test

Recommended review path:

1. Password sign in.
2. Today / nutrition summary.
3. Food search and meal logging.
4. Barcode lookup.
5. Recipes and recipe planning.
6. Grocery list.
7. Pantry manual entry and photo/barcode controls.
8. Pantry AI meal ideas and **Report AI suggestion** control.
9. Settings > Plan & billing (reviewer Premium is already granted; no purchase is required).
10. Settings > Data & privacy.
11. Settings > Account > Delete account (do not delete the shared reviewer account until review is complete).

## Ordinary-user authentication is separate

The production Android app also supports the normal passwordless Munch flow. A user enters an email, receives a scanner-safe HTTPS confirmation link, taps **Open Munch**, and the installed app redeems the still-unused one-time Better Auth token before storing its session with Android Keystore. Password access remains available for reviewer accounts and users who already have password credentials.
