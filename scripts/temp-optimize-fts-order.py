from pathlib import Path

path = Path("src/food-providers/catalog-repository.ts")
text = path.read_text()
old = "const retrievalLimit = Math.min(40, Math.max(25, boundedLimit * 4));"
new = "const retrievalLimit = Math.min(50, Math.max(25, boundedLimit * 5));"
if old not in text:
    raise SystemExit("retrieval limit anchor changed")
text = text.replace(old, new, 1)

old_order = '''            order by
                case when normalized_name = ${normalized} then 0 else 1 end,
                length(normalized_name) asc,
                ts_rank_cd(
                    to_tsvector(
                        'simple',
                        normalized_name || ' ' || coalesce(normalized_brand, '')
                    ),
                    to_tsquery('simple', ${lexicalTsquery})
                ) desc,
                greatest(
                    similarity(normalized_name, ${normalized}),
                    similarity(coalesce(normalized_brand, ''), ${normalized})
                ) desc,
                confidence desc,
                length(normalized_name) asc
            limit ${retrievalLimit}'''
new_order = '''            order by
                case when normalized_name = ${normalized} then 0 else 1 end,
                length(normalized_name) asc,
                confidence desc
            limit ${retrievalLimit}'''
if old_order not in text:
    raise SystemExit("lexical order anchor changed")
text = text.replace(old_order, new_order, 1)
path.write_text(text)
