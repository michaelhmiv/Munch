#!/usr/bin/env bash
set -euo pipefail

seed_mode="${MUNCH_USDA_SEED_MODE:-off}"
case "$seed_mode" in
  off|"")
    ;;
  dry-run)
    echo "[startup] validating USDA generic catalog seed"
    bash scripts/seed-usda-generic-catalog.sh --dry-run
    ;;
  seed)
    echo "[startup] applying idempotent USDA generic catalog seed"
    bash scripts/seed-usda-generic-catalog.sh seed
    ;;
  *)
    echo "Invalid MUNCH_USDA_SEED_MODE=$seed_mode (expected off, dry-run, or seed)" >&2
    exit 2
    ;;
esac

exec bun --smol src/index.ts
