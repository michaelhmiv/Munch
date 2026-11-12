-- Goals intake (2026-11-11, goals intake brief): the context layer
-- around the numeric targets — the user's stated goal in their own
-- words plus five skippable intake answers — stored on the
-- account-preferences row next to the feature-module flags (0039).
-- Every column is nullable/empty by default: nothing here is required
-- to use the app, and an account that never opens the Goals page
-- reads as a completely empty intake. The contract lives in
-- src/goals-context.ts; reads and writes go through
-- src/goals-context-repository.ts, and every AI surface consumes the
-- assembled context from that module (goals law rule 6) — never its
-- own ad-hoc read of these columns.
alter table munch.account_preferences
    add column if not exists goals_stated text,
    add column if not exists goals_activity_band text,
    add column if not exists goals_eating_pattern text,
    add column if not exists goals_hardest_meal text,
    add column if not exists goals_never_suggest text[] not null default '{}',
    add column if not exists goals_allergies text[] not null default '{}';
