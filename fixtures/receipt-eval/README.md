# Receipt eval fixtures

Three real grocery receipt photographs used by
`scripts/receipt-extractions-eval.ts` to score receipt line extraction
(head-to-head: the production Ember call shape from
`src/inventory/vision.ts` vs extraction models on OpenRouter's
Extractions API).

## Provenance

All three photos are own-work uploads by **Donald Trung** to Wikimedia
Commons, retrieved 2026-11-11. Each Commons file page carries the
author's self-published license statement (the author's standard
**CC BY-SA 4.0** self-license template). No other license family is used
in this set.

| Fixture                      | Commons file                                             | Store                       | sha256 (first 12) |
| ---------------------------- | -------------------------------------------------------- | --------------------------- | ----------------- |
| receipt-01-aldi-winschoten   | File:ALDI receipt, Winschoten (2019) 01.jpg              | ALDI Winschoten, 23.02.2019 | 959eb6b32216      |
| receipt-02-coop-bellingwolde | File:Coop Bellingwolde receipt, Winschoten (2019) 05.jpg | Coop Bellingwolde, 2019     | 49b85c71d2c7      |
| receipt-03-lidl-winschoten   | File:Lidl receipt, Winschoten (2019) 05.jpg              | Lidl Winschoten, 29.04.2019 | cfa6b1d51190      |

Full source-page URLs, sha256 values, and per-fixture notes live in
`expectations.json` next to this file. The expectations were
hand-labelled from the photos under the conservative rule stated in
`expectations.json` (`labelling_rule`): only legibly printed purchased
lines are items; totals/tax/payment/loyalty/discount lines are traps
that count as spurious when returned.

Two framing facts worth knowing before reading scores: the Coop photo
crops the receipt below the discount line (totals out of frame), and
the Lidl photo shows a mid-receipt segment with the receipt rotated
90 degrees. Models receive the photos exactly as stored.

## Eval inputs

The harness sends the `photos-1568/` copies — the originals downscaled
to a 1568px longest side (JPEG q85), byte-for-byte the form
production's client produces before upload (PR #237's capture
downscale). The first receipt run sent the 3.3–3.6 MB originals: the
incumbent chat call accepted them, but the Extractions route returned
HTTP 500 for every receipt task from both extraction providers, so the
lane standardized on the production-faithful input size. The originals
under `photos/` remain the provenance record (hashes above).
