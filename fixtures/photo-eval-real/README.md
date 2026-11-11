# Photo-eval fixture set — REAL photographs

Golden fixtures for the photo-logging pipeline (Full Parity App Program
brief, section 3), built 2026-11-10 after the owner ruled that the eval
must use real food. This directory is the photographic-accuracy corpus.
The synthetic set in `fixtures/photo-eval/` still exists and still
serves as the deterministic per-PR regression corpus; it is not
accuracy evidence and nothing in this directory replaces it.

## Provenance

Every photo is a **real photograph of real food**, downloaded
individually from Wikimedia Commons under an open license (CC0,
CC BY, CC BY-SA, or public domain). `manifest.json` records, per
photo: the Commons file page (`source_url`), the original file
(`image_url` and `original_title`), the license and its URL, the
artist credit as given on the source page, and a note describing what
the photo shows and which ground-truth calls were made. No dataset
bulk pulls, no scraped stock sites, no staged fakes: what is in the
frame is what was served.

## Ground-truth rules (the point of this set)

Expectations were written by visually inspecting each photo, under a
conservative rule:

- An item is expected **only when a careful human can clearly
  identify it in the photo**. If it is ambiguous, it is not an
  expected item — distractors that were deliberately left unlisted
  (an unidentifiable mug on a pancake plate, a mostly-obscured side
  salad, the second milky coffee on a cafe table) are named in the
  manifest note for that fixture, so a reviewer can see the call.
- Composite dishes get their dish name plus the components that are
  clearly visible (a chicken curry with visible chicken pieces; a
  Cobb salad's egg, bacon, and cheese). Hidden ingredients are never
  expected.
- **Portions are scored only where the photo honestly supports a
  range**: counts of distinct pieces (eggs, meatballs, sushi pieces)
  and label-printed volumes/weights (the cola can's 330 mL). Every
  other item carries `"portion": null` — unscored — rather than an
  invented gram range. A photograph of a plate does not contain a
  gram weight, and this set does not pretend otherwise.
- Where an identity rests on the source file's title rather than
  purely on pixels (the schnitzel, the granola bar, the glass of
  orange juice), the manifest note says so.

## Layout

| Path                | Contents                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| `photos/`           | 30 real meal photos (JPEG, 800px-wide Commons thumbnails).               |
| `expectations.json` | Per fixture: expected item set; portion range or `null` (unscored); expected grounding provider per item; category tags. |
| `manifest.json`     | Per-photo provenance: source page, original file, license, artist credit, ground-truth note. |

Categories mirror the synthetic set where photographs allow:
single item ×5, mixed plate ×7, sauced/hidden-ingredient ×4,
restaurant portions ×7, packaged food with a readable real label ×2,
drinks ×2, poorly lit ×2, partially eaten ×1.

## Running the bake-off on this set

The Layer 1 identify bake-off (`scripts/photo-model-bakeoff.ts`)
takes the set via `BAKEOFF_FIXTURES_DIR`:

```sh
BAKEOFF_FIXTURES_DIR=fixtures/photo-eval-real bun scripts/photo-model-bakeoff.ts
```

In CI, the `run-bakeoff-real` PR label runs it (see
`.github/workflows/photo-model-bakeoff.yml`). Reports on this set
carry a caveat written for real photographs; portion accuracy is
computed over the portion-scored items only.
