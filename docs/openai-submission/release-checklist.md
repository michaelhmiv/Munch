# Submission release checklist

## Repository and CI

- [ ] `main` contains the intended release commit.
- [ ] Formatting, typecheck, tests, migrations, reviewer smoke tests, submission checks, and container build pass.
- [ ] `chatgpt-app-submission.json` and `tool-inventory.md` are freshly generated.
- [ ] Tool names, descriptions, input schemas, output schemas, and annotations match the intended production catalog.
- [ ] OAuth, MCP, widgets, and connection surfaces contain no pricing, checkout, or upgrade promotion.
- [ ] No secrets or reviewer credentials are committed.

## Production

- [ ] Railway deployed the exact reviewed `main` SHA.
- [ ] `/health/live` and `/health/ready` return 200.
- [ ] OAuth discovery, PKCE S256, dynamic registration, JWKS, token exchange, and the MCP authorization challenge pass certification.
- [ ] Privacy, Terms, Help, Security, and reviewer sign-in pages return 200 on `munch.business`.
- [ ] No production route redirects reviewers to the Railway-generated domain.
- [ ] Widget resources use the exact Munch domain and the committed CSP allowlist.

## Reviewer access

- [ ] A dedicated verified reviewer account is provisioned.
- [ ] Password sign-in works without email access, MFA, SMS, VPN, or a private network.
- [ ] The reviewer override exposes the full intended catalog.
- [ ] Relative personal and household sample data is present.
- [ ] The password remains valid for the review period.
- [ ] A separate disposable account is available for account-deletion testing.

## OpenAI portal

- [ ] The submitting account has Apps Management Write permission.
- [ ] Developer or business identity is verified and matches the public publisher identity and policies.
- [ ] Listing name, subtitle, description, category, URLs, logo, and regional availability are complete.
- [ ] The portal-provided challenge token is configured as `OPENAI_APPS_CHALLENGE`.
- [ ] `/.well-known/openai-apps-challenge` returns the exact token as plain text with no cache.
- [ ] Tool Scan matches `tool-inventory.md`.
- [ ] Exactly five positive and three negative cases are supplied.
- [ ] Reviewer credentials are supplied only through the portal.

## Freeze and submit

- [ ] Run production certification against `https://munch.business` after the final deployment.
- [ ] Record the deployed Git SHA and Railway deployment ID.
- [ ] Freeze tool and authentication metadata during review.
- [ ] Submit the reviewed snapshot.
- [ ] Regenerate, rescan, and submit a new version after any material tool, CSP, auth, policy, or listing change.
