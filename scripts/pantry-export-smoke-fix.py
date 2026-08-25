from pathlib import Path

path = Path("scripts/account-export-smoke.ts")
text = path.read_text()
old = '''if (\n    !serialized.includes('\"inventory_item_profiles\"') ||\n    !serialized.includes('\"category\":\"dairy\"') ||\n    !serialized.includes('\"protein_g\":12')\n) {\n    throw new Error(\"Account export omitted Pantry planning profiles\");\n}'''
new = '''const inventoryProfiles = document.inventory_item_profiles;\nif (!Array.isArray(inventoryProfiles) || inventoryProfiles.length < 1) {\n    throw new Error(\"Account export omitted Pantry planning profiles\");\n}\nconst cottageProfile = inventoryProfiles.find(\n    (profile: any) => profile?.category === \"dairy\",\n) as Record<string, unknown> | undefined;\nif (!cottageProfile || Number(cottageProfile.protein_g) !== 12) {\n    throw new Error(\"Account export Pantry planning profile was incomplete\");\n}'''
if old not in text:
    raise SystemExit("expected Pantry export assertion marker missing")
path.write_text(text.replace(old, new, 1))
print("Pantry export smoke numeric assertion fixed.")
