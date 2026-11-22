-- Search Intent seat pin cache (approved brief 2026-11-22; eval
-- evidence in the search-intent-eval-2026-11-22 package, REPORT.md).
-- One row per normalized search query: the Decisions seat's pick
-- (candidate + natural portion) so repeat web/app searches apply the
-- pin without a model call. A row with candidate_id NULL is a
-- recorded abstention ("none") — the deterministic ranked list
-- stands for that query. The seat fails open on any store error, so
-- this table is an accelerator, never a dependency of search.
-- Defensive per house law: `create table if not exists` makes this
-- safe on a fresh database (where it also runs right after the
-- baseline), on production, and on re-run.

create table if not exists munch.food_search_intent_pins (
    query_hash text primary key,
    normalized_query text not null,
    candidate_id text,
    portion_id text,
    model text,
    decided_at timestamptz not null default now()
);

grant select, insert, update, delete on munch.food_search_intent_pins to munch_app, munch_auth;
