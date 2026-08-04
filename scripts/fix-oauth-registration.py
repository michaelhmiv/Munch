from pathlib import Path

path = Path(__file__).resolve().parents[1] / "src/oauth-platform/repository.ts"
text = path.read_text()

# Keep array_to_json only in SELECT projections, never in the INSERT column list.
malformed_columns = '''                client_name,
                array_to_json(redirect_uris) as redirect_uris,
                token_endpoint_auth_method'''
correct_columns = '''                client_name,
                redirect_uris,
                token_endpoint_auth_method'''
if malformed_columns in text:
    text = text.replace(malformed_columns, correct_columns, 1)
elif correct_columns not in text:
    raise RuntimeError("OAuth insert column list not found")

# Bind the JSON text explicitly as text before PostgreSQL parses it into text[].
if "const redirectUrisJson = JSON.stringify(redirectUris);" not in text:
    marker = "    const secret =\n        authMethod === \"client_secret_post\" ? issueOpaqueToken(32) : null;\n"
    if marker not in text:
        raise RuntimeError("OAuth registration setup marker not found")
    text = text.replace(
        marker,
        marker + "    const redirectUrisJson = JSON.stringify(redirectUris);\n",
        1,
    )

old_value = "                ${tx.array(redirectUris)},"
new_value = '''                (
                    select array_agg(item.value order by item.ordinality)
                    from jsonb_array_elements_text(
                        (${redirectUrisJson}::text)::jsonb
                    ) with ordinality as item(value, ordinality)
                ),'''
if new_value not in text:
    if old_value not in text:
        raise RuntimeError("OAuth redirect URI insert value not found")
    text = text.replace(old_value, new_value, 1)

path.write_text(text)
