# Reviewer guide

## Access

Provide the OpenAI reviewer with a dedicated production email, optional username, and password through the submission portal. Do not commit those credentials.

Reviewer sign-in page:

`https://munch.business/review/sign-in`

The reviewer account must:

- Be email-verified before review.
- Accept the supplied username/email and password directly without a magic-link inbox, MFA, SMS, VPN, or private network.
- Have a temporary Premium reviewer override so the full intended tool catalog is visible.
- Have no administrative privileges.
- Have access only to its own personal data and the seeded reviewer household.
- Remain active for the complete review period.

## Seeded state

Run `scripts/provision-reviewer.ts` with securely supplied environment variables. The script creates or refreshes:

Set `MUNCH_REVIEWER_USERNAME` when the submission should use a username instead of the reviewer email.

- A verified reviewer user.
- A personal workspace and reviewer household.
- A personal Greek-yogurt recipe scheduled for the following day.
- A shared spaghetti recipe scheduled five days ahead.
- Grocery-list entries linked to the scheduled recipes.
- A time-bounded reviewer entitlement override.

The seed dates are calculated relative to provisioning so the review account does not contain only stale plans.

## Validation

Run `scripts/reviewer-readiness-smoke.ts` against the same credentials. Confirm that:

- Password sign-in succeeds.
- Public password registration remains disabled.
- The full reviewer capability set is available.
- Personal and household fixtures are present.
- OAuth authorization and MCP tool access work from a clean browser session.

## Handling destructive tests

Do not use the primary reviewer account for account deletion. Provision a disposable account for deletion and cascade-cleanup testing. Other destructive tools must require their documented confirmation input.

## Credential lifecycle

Rotate the reviewer password after review, remove the reviewer entitlement override, and disable or delete the account when it is no longer needed. Challenge values and credentials must remain in secure runtime configuration or the OpenAI portal only.
