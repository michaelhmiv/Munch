# Negative fixture set — Jev front-door probe

Non-food companion to `fixtures/photo-eval-real/` (the 30 real food
photos), built 2026-11-11 for the Jev-1.14 front-door probe
(`scripts/photo-jev-probe.ts`). All 12 photos are real photographs
from Wikimedia Commons under open licences (CC0 / CC BY / CC BY-SA /
public domain); provenance, licence, artist, and the size transform
are recorded per photo in `manifest.json`.

## Why this set exists

The front-door gate question is only interesting if it can also say
"no". The positive set proves the gate does not reject real meals;
this set proves it rejects things that are not meals — including the
food-adjacent cases a real upload stream produces (a receipt, a menu,
a label close-up, a supermarket shelf, an emptied plate, a person
eating).

## Labelling rules

- `expected.gate_food` answers the gate question exactly as the probe
  asks it: does the photo show food or drink someone would log as a
  meal? Labels were assigned by visual inspection of the actual
  pixels, not by filename or Commons category.
- `expected.borderline` marks the judgement calls (person eating,
  empty plate, grocery shelf, nutrition label). Borderline fixtures
  are EXCLUDED from the headline negative-set rates and reported
  individually in the probe report, each with its rationale in
  `manifest.json`, so the headline numbers never rest on a coin flip.
- `expected.expected_route` is the best fit among the probe's five
  route options (plated meal / drink / packaged product / receipt /
  something else). Two honest ambiguities are recorded in the
  manifest: a menu page has no matching option ("something else" is
  the only fit), and the grocery shelf / nutrition label could
  defensibly route as "something else" instead of "packaged product".

## Size normalization

Jev's image input accepts 280–1568 px per side and rejects (does not
resize) out-of-range images. The positive set already sits inside
that range as committed (960 px on the short side). These negatives
were normalized ONCE at build time: the 1024 px-wide Commons
derivative (or the original when smaller) was downloaded, EXIF
orientation baked in, converted to RGB, Lanczos-downscaled so both
sides fall inside 280–1568 px, and saved as baseline JPEG (q88).
Original and saved dimensions are in `manifest.json`; the probe
script re-verifies dimensions at run time and records them.

## Fixture swaps during assembly (disclosed)

- Receipt: the first candidate (an OPay money-transfer receipt
  screenshot, CC0) was replaced by a classic itemized paper
  restaurant receipt (`ReceiptSwiss.jpg`, CC BY-SA 3.0) — the paper
  archetype is the harder and more representative routing test.
- Person eating: the first candidate (a "1724Ants" photo) turned out
  on inspection to be a hand holding ant-covered bread, not a person
  eating; replaced by `Gyros by ic3.jpg` (public domain) — a person
  mid-bite into a gyro, tray with plated food and a Coke can in
  frame.
