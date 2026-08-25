-- Accelerate common ingredient lookup before fuzzy trigram fallback.
-- plainto_tsquery('simple', ...) requires every normalized query token while
-- retaining numerals and food-specific vocabulary without English stemming.
create index if not exists food_catalog_lexical_search_idx
    on munch.food_catalog_entries
    using gin (
        to_tsvector(
            'simple',
            normalized_name || ' ' || coalesce(normalized_brand, '')
        )
    )
    where deprecated_at is null;
