# Range UI conformance captures (390px)

Produced by `e2e/today-navigation.e2e.ts` on PR #277 (390×844 CSS
viewport, Pixel 7 device scale). The first set came from CI
(website-e2e run 43143820391, artifact `munch-today-navigation-captures`);
the QC-fix set below was re-shot with the same journeys in a local
run of the same suite (same reviewer-account seeding pattern, goals
2000/120/220/65 as the wider CI suite sets) and personally reviewed:
no overflow or overlap; tile math reconciles by hand. CI regenerates
the same captures as the `munch-today-navigation-captures` artifact
on every push.

- `calendar-range-390.png` — calendar sheet, committed span painted
  as one band (solid endpoints, soft-green middle), note row naming
  the span only. The Range toggle in the sheet header reads ON —
  filled primary #176b3a, white text (QC-gate F1: range mode is
  active, so `aria-pressed="true"`); there is no "Clear range" in
  the note row — clearing lives only in the range bar's ✕ Clear.
  Behind the sheet, the tiles disclose their average basis:
  "avg 533 kcal · −1,467/day · per logged day" (QC-gate F2).
- `range-390.png` — range-mode Today, 4-day span with one unlogged
  day: totals vs period targets, signed avg/day deltas, every macro
  tile's average line ending "· per logged day" (averages divide by
  the 3 logged days, not the 4 calendar days), NO on-target line
  (not fully logged), first day row expanded to its meals.
- `range-on-target-390.png` — fully logged 2-day span: "On target ·
  2 of 2 days" on the ceiling nutrients, "1 of 2 days" on protein
  (floor — the 40 g day misses the 120 g target). Average lines keep
  the undisclosed form here: logged days ARE the calendar days, so
  the basis is identical either way (the stated QC-gate F2 choice).
- `mixed-range-390.png` — mixed past/future range: Logged/Planned
  split row, per-tile Logged · Planned lines, combined tile totals,
  "1 logged · 2 planned" Meals count. (No average line is shown in
  a mixed range, so no average basis arises.)
- `hierarchy-390.png` — 41-day range, frame (a) from the TOP of the
  surface (QC-gate F3): heading, range bar, tiles, Daily details,
  and the collapsed month rows of the nesting.
- `hierarchy-expanded-390.png` — the same 41-day range, frame (b)
  (QC-gate F3): October expanded to its Sunday-start weeks (split
  at the month boundary), the week of Oct 4–8 expanded to its days,
  the seeded day (Thu, Oct 8) expanded to its meals — scrolled so
  the whole expanded detail sits fully above the bottom nav (the
  e2e asserts this geometrically before shooting).
