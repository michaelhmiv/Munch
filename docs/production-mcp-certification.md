# Production MCP corpus certification

`MUNCH_PRODUCTION_MCP_CERT_MODE=run` enables an explicit pre-deploy certification pass against the already-serving production HTTPS MCP endpoint. The default is `off`.

The certification creates short-lived Better Auth users and OAuth clients in Railway PostgreSQL, gives each test user a one-day synthetic active subscription, exercises authenticated MCP calls over the public production URL, and deletes the test identities and OAuth clients in `finally` blocks. Access tokens and generated passwords are never logged.

The corpus is split across separate users to remain below the production 60-request-per-minute authenticated MCP rate limit without changing or bypassing that limit. It covers the common-food search corpus, repeated barcode lookups, 20+ live recipe URLs, atomic meal-review reconciliation, meal confirmation, and idempotent `save_meal_as_recipe` conversion.

This mode is operationally opt-in. Normal deploys must leave `MUNCH_PRODUCTION_MCP_CERT_MODE=off`.
