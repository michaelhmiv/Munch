# OpenAI submission package

This directory contains the version-controlled review material for the Munch Plugins Directory submission. The root `chatgpt-app-submission.json` file is generated from the exposed MCP tool registrations.

Before each submission or resubmission:

1. Run `bun run submission:generate`.
2. Run `bun run submission:check` and the full test suite.
3. Deploy the exact reviewed commit to `https://munch.business`.
4. Provision or refresh the production reviewer account with a temporary Premium override and relative sample data.
5. Set the portal-provided `OPENAI_APPS_CHALLENGE` value in Railway and confirm the exact plain-text response.
6. Run `bun scripts/certification/public.ts https://munch.business`.
7. Scan tools in the OpenAI portal and compare them with `tool-inventory.md`.
8. Do not change tool names, descriptions, annotations, schemas, widget CSP, or authentication behavior after the scan without regenerating and rescanning.

Never commit the OpenAI challenge token, reviewer password, Stripe secrets, Resend secrets, database credentials, or OAuth tokens.
