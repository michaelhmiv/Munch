from pathlib import Path

path = Path(__file__).resolve().parents[1] / "src/oauth-platform/repository.ts"
text = path.read_text()
replacements = {
    "            redirect_uris,\n": "            array_to_json(redirect_uris) as redirect_uris,\n",
    "                client.redirect_uris,\n": "                array_to_json(client.redirect_uris) as redirect_uris,\n",
}
for old, new in replacements.items():
    if new in text and old not in text:
        continue
    if old not in text:
        raise RuntimeError(f"Expected OAuth array selection not found: {old!r}")
    text = text.replace(old, new)
path.write_text(text)
