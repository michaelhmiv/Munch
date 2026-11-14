-- Seat A2b (Jev accountability program): the per-revision recipe
-- yield estimate, stored labelled with its provenance
-- ({source: "estimate" | "user", weight_g, volume_ml, anchor,
-- model}). A user-sourced value is a correction that permanently
-- replaces the estimate; the estimate seat never overwrites it.
--
-- Placement fix (2026-11-13): PR #321 filed this migration under
-- db/schema/, which scripts/migrate.ts installs only into EMPTY
-- databases; the baselined production database applies db/updates/
-- only, so this column never reached production and every recipe
-- detail read failed with "column revision.yield_estimate does not
-- exist". This copy is the updates-path application of the same
-- change; the statement was already written defensively, so it is
-- safe to run after the canonical schema on fresh installs.
alter table munch.recipe_revisions
    add column if not exists yield_estimate jsonb;
