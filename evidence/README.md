# Range UI conformance captures (390px)

Produced by `e2e/today-navigation.e2e.ts` on PR #277's CI
(website-e2e run 43143820391, artifact `munch-today-navigation-captures`;
390×844 CSS viewport, Pixel 7 device scale). Personally reviewed:
no overflow or overlap; tile math reconciles by hand.

- `calendar-range-390.png` — calendar sheet, committed span painted
  as one band (solid endpoints, soft-green middle), note row naming
  the span; the Range toggle sits in the sheet header.
- `range-390.png` — range-mode Today, 4-day span with one unlogged
  day: totals vs period targets, signed avg/day deltas, NO on-target
  line (not fully logged), first day row expanded to its meals.
- `range-on-target-390.png` — fully logged 2-day span: "On target ·
  2 of 2 days" on the ceiling nutrients, "1 of 2 days" on protein
  (floor — the 40 g day misses the 120 g target).
- `mixed-range-390.png` — mixed past/future range: Logged/Planned
  split row, per-tile Logged · Planned lines, combined tile totals,
  "4 logged · 2 planned" Meals count.
- `hierarchy-390.png` — 41-day range: October expanded to its
  Sunday-start weeks (split at the month boundary), the week of
  Oct 4–8 expanded to its days, the seeded day expanded to meals.
