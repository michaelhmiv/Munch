from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Bind the validated redirect URI list using Bun SQL's PostgreSQL array helper.
path = ROOT / "src/oauth-platform/repository.ts"
text = path.read_text()
text = text.replace("    const redirectUrisJson = JSON.stringify(redirectUris);\n", "")
old = '''                (
                    select array_agg(value)
                    from jsonb_array_elements_text(${redirectUrisJson}::jsonb)
                ),'''
new = '''                ${tx.array(redirectUris)},'''
if new not in text:
    if old not in text:
        raise RuntimeError("OAuth redirect URI array binding block not found")
    text = text.replace(old, new, 1)
path.write_text(text)
