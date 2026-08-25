from pathlib import Path

path = Path("src/inventory/meal-ideas.ts")
text = path.read_text()
old = '''                model: config.model,\n                temperature: 0.25,\n                max_tokens: 5500,\n                response_format: {'''
new = '''                model: config.model,\n                response_format: {'''
if old not in text:
    raise SystemExit("expected Pantry planning tuning-parameter marker missing")
path.write_text(text.replace(old, new, 1))
print("Removed nonessential Pantry planning tuning parameters from strict provider routing.")
