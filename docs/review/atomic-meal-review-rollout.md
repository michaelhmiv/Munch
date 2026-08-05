# Atomic meal review rollout

1. Merge only after quality, migration, database smoke, benchmark, and container jobs pass.
2. Allow Railway to deploy `main` and apply migration 0024 through the existing pre-deploy command.
3. Verify health, OAuth/JWKS, MCP discovery, and production logs.
4. Run the same-process production database benchmark with disposable users.
5. Compare operation counts and elapsed-time distributions; do not represent database-path results as image-model latency.
6. Restore any temporary Railway pre-deploy benchmark command immediately after measurement.
7. If production verification fails, revert application preference to the legacy tools. Do not delete confirmed user data or reverse the nullable schema addition.
