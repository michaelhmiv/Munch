#!/usr/bin/env bash
set -euo pipefail

echo "[predeploy] applying database migrations"
bun run db:migrate

seed_mode="${MUNCH_USDA_SEED_MODE:-off}"
case "$seed_mode" in
  off|"")
    echo "[predeploy] USDA catalog seed disabled"
    ;;
  dry-run)
    echo "[predeploy] validating USDA generic catalog seed"
    bash scripts/seed-usda-generic-catalog.sh --dry-run
    ;;
  seed)
    echo "[predeploy] applying and certifying USDA generic catalog seed"
    bash scripts/seed-usda-generic-catalog.sh seed
    ;;
  *)
    echo "Invalid MUNCH_USDA_SEED_MODE=$seed_mode (expected off, dry-run, or seed)" >&2
    exit 2
    ;;
esac
