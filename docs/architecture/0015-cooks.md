# Cooks: persistent cooking-session history

## Status

This document describes the Cooks implementation in the review branch. The
feature is not part of the Railway production deployment until the PR is
merged and a new migration has completed successfully.

## Domain boundary

A cook is a durable cooking occasion, not a meal log, recipe, pantry event, or
nutrition estimate. Completing a cook therefore has no implicit side effect on
`munch.meals`, food consumption, groceries, or inventory. The optional
nutrition and pantry actions are separate, explicit follow-ups.

One cook can contain several `cook_dishes`. Each dish stores the actual
ingredients and editable labels independently of recipes. If the cook followed
a recipe, the dish stores both `recipe_id` and the exact immutable
`recipe_revision_id`; later recipe revisions cannot rewrite the cook.

`source_cook_id` is an explicit “based on this attempt” relationship. It is
not used as a fuzzy similarity or search match. `repeatCook` copies setup
context and previous next-time notes into a fresh cook, but never copies prior
events, results, or photos as if they happened again.

## Persistence and media

Migration `0031_cooks.sql` adds:

- `cooks` for owner/scope, title, lifecycle, date/timezone, setup, and source
  attempt;
- `cook_dishes` for multiple dishes, actual ingredients, descriptive labels,
  and exact recipe-revision links;
- `cook_updates` for the original website/MCP message and retry/idempotency
  status;
- `cook_events` for an editable timeline with event time separate from
  submission time, relative-time precision, corrections, setpoints, ambient
  temperatures, and internal food temperatures;
- `cook_outcomes` for user observations, results, next-time notes, preferred
  attempts, and a separate `ai_suggestions` field; and
- `cook_media` for actual JPEG/PNG/WebP bytes, SHA-256 deduplication,
  associations, and OpenAI file provenance.

All tables use the existing `munch_app`/`munch_auth` roles and row-level
security. Household members can read and maintain household cooks. Actor
references are nullable with `ON DELETE SET NULL` so a departing non-owner
does not block deletion or destroy household history. Personal cooks and their
children cascade with the personal owner.

Photo URLs are signed, ownership-scoped, and served by `/media/cooks/:id`.
The source URL or an AI-generated description is never treated as the retained
photo. Failed transfers are returned as explicit failures and do not masquerade
as saved media; retries are content-hash idempotent.

## Shared service flow

Website routes and MCP tools call `src/cooks/repository.ts`. The website
accepts JSON or multipart form uploads. MCP remains host-model driven: the
model resolves conversational references and calls `start_cook` or
`update_cook`; the shared service parses only supported, deterministic timeline
signals and preserves the original message. Advisory questions and
hypotheticals are saved as context without factual events.

The MCP file contract follows the supported ChatGPT file input shape:
`download_url` and `file_id` are required, `mime_type` and `file_name` are
optional, and the top-level `files` field is declared in
`_meta["openai/fileParams"]`. The Cooks widget additionally feature-detects
`window.openai.uploadFile`, `getFileDownloadUrl`, and `callTool` for an inline
photo-plus-update flow; it reports when the connected host does not expose
those helpers.

## Website and MCP capability matrix

| Outcome                             | Website                                                    | MCP / widget                                                               |
| ----------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Create before/during/after cooking  | `POST /api/app/cooks`, Cooks tab                           | `start_cook`, photo file input, cook card                                  |
| Update with text/photo              | multipart `POST /api/app/cooks/:id/updates`                | `update_cook`, top-level `files`, widget upload                            |
| Edit dish labels/actual ingredients | dish editor, `PATCH /api/app/cooks/:cookId/dishes/:dishId` | `update_cook_dish`                                                         |
| Search and recall                   | Cooks search and detail view                               | `search_cooks`, `get_cook`                                                 |
| Edit timeline                       | event correction form / optimistic version                 | explicit event data via `update_cook`; shared correction service           |
| Finish/reopen/delete                | ordinary buttons and API routes                            | `finish_cook`, `reopen_cook`, `delete_cook` with confirmation              |
| Results and iteration               | result editor, compare, repeat, preferred                  | `record_cook_result`, `compare_cooks`, `repeat_cook`, `set_preferred_cook` |
| Recipe creation                     | reviewed draft then existing recipe/nutrition flow         | `prepare_cook_recipe_draft`, `save_cook_as_recipe`                         |
| Optional eaten portion              | linked dish's exact revision through recipe log            | `log_cook_portion` only after explicit user confirmation                   |
| Explicit ingredient usage           | existing Pantry controls / confirmation flow               | `reconcile_pantry` with `source_entity_id` set to the cook                 |
| Export/deletion                     | account export and account deletion                        | shared persistence; no nutrition/pantry side effect                        |

## Verification obligations

The branch must pass unit/contract checks, a fresh PostgreSQL migration/RLS
smoke, website surface checks, MCP registration/file-schema checks, and
authenticated browser and connected-plugin scenarios before being described as
production-complete. A successful PR CI run is not itself a production
deployment.
