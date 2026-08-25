#!/usr/bin/env bash
set -euo pipefail

mode="${1:-seed}"
if [[ "$mode" != "seed" && "$mode" != "--dry-run" ]]; then
  echo "Usage: $0 [seed|--dry-run]" >&2
  exit 2
fi

for command_name in bun curl unzip find; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done

: "${DATABASE_URL:?DATABASE_URL is required}"

workdir="$(mktemp -d /tmp/munch-usda-seed.XXXXXX)"
trap 'rm -rf "$workdir"' EXIT
mkdir -p "$workdir/foundation" "$workdir/survey" "$workdir/sr_legacy"

foundation_url="https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip"
survey_url="https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip"
sr_legacy_url="https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip"

curl --fail --location --retry 4 --retry-all-errors "$foundation_url" -o "$workdir/foundation.zip"
curl --fail --location --retry 4 --retry-all-errors "$survey_url" -o "$workdir/survey.zip"
curl --fail --location --retry 4 --retry-all-errors "$sr_legacy_url" -o "$workdir/sr_legacy.zip"

unzip -q "$workdir/foundation.zip" -d "$workdir/foundation"
unzip -q "$workdir/survey.zip" -d "$workdir/survey"
unzip -q "$workdir/sr_legacy.zip" -d "$workdir/sr_legacy"

foundation_json="$(find "$workdir/foundation" -type f -name '*.json' | head -n 1)"
survey_json="$(find "$workdir/survey" -type f -name '*.json' | head -n 1)"
sr_legacy_json="$(find "$workdir/sr_legacy" -type f -name '*.json' | head -n 1)"

test -n "$foundation_json"
test -n "$survey_json"
test -n "$sr_legacy_json"

common_args=(--batch-size 500)
if [[ "$mode" == "--dry-run" ]]; then
  common_args=(--max-records 100 --dry-run)
fi

bun scripts/import-usda-food-catalog.ts --file "$foundation_json" --dataset foundation --release 2026-04 "${common_args[@]}"
bun scripts/import-usda-food-catalog.ts --file "$survey_json" --dataset survey --release 2024-10 "${common_args[@]}"
bun scripts/import-usda-food-catalog.ts --file "$sr_legacy_json" --dataset sr_legacy --release 2018-04 "${common_args[@]}"

if [[ "$mode" == "seed" ]]; then
  bun scripts/food-catalog-production-audit.ts
  MUNCH_FOOD_CORPUS_REPORT="$workdir/food-catalog-corpus.json" bun scripts/food-catalog-common-corpus.ts
fi
