-- Seat A2b (Jev accountability program): the per-revision recipe
-- yield estimate, stored labelled with its provenance
-- ({source: "estimate" | "user", weight_g, volume_ml, anchor,
-- model}). A user-sourced value is a correction that permanently
-- replaces the estimate; the estimate seat never overwrites it.
alter table munch.recipe_revisions
    add column if not exists yield_estimate jsonb;
