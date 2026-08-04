from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# One-use compatibility migration executed by GitHub Actions.
def update(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if new in text:
        return
    if old not in text:
        raise RuntimeError(f"Expected text not found in {path}: {old!r}")
    target.write_text(text.replace(old, new, 1))


update(
    "src/billing/stripe-client.test.ts",
    "        }) as typeof fetch;",
    "        }) as unknown as typeof fetch;",
)

update(
    "src/oauth-platform/repository.ts",
    "function createTokenPair(familyId = randomUUID()): InternalTokenPair {",
    "function createTokenPair(familyId: string = randomUUID()): InternalTokenPair {",
)

update(
    "src/portal/routes.ts",
    '<option value="uk"${input.drinkUnit === "uk" ? " selected" : ""}>UK</option><option value="metric"${input.drinkUnit === "metric" ? " selected" : ""}>Metric</option>',
    '<option value="uk"${input.drinkUnit === "uk" ? " selected" : ""}>UK</option>',
)

update(
    "src/portal/routes.ts",
    '                drinkUnit !== "uk" &&\n                drinkUnit !== "metric"',
    '                drinkUnit !== "uk"',
)
