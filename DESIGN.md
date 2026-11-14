# Munch — Design

## Brand mark (adopted 2026-11-09)

The Munch mark is a plump apple with a leaf, carrying the Nutrition Facts
label's rhythm — one heavy bar over descending rules — knocked out of the
fruit's body. Food reads first, tracking second. The name "Munch" and the
brand green are binding; the letterform M is retired.

Construction: a single apple silhouette (viewBox 0 0 192 192), the label
lines as true transparent knockouts (`fill-rule="evenodd"`), a stroked stem,
and a filled leaf. One geometry serves every variant; only fills change.

| File                                           | Use                                                       |
| ---------------------------------------------- | --------------------------------------------------------- |
| `public/brand/munch-mark.svg`                  | Primary: apple `#0B8F4D`, leaf `#A8D90F` — light surfaces |
| `public/brand/munch-mark-dark.svg`             | Apple `#07502F`, leaf `#A8D90F`                           |
| `public/brand/munch-mark-light.svg`            | Apple `#FFFFFF`, leaf `#D9FF5B` — dark surfaces           |
| `public/brand/munch-mark-white.svg`            | Apple `#FFFFFF`, leaf `#A8D90F`                           |
| `public/brand/munch-mark-192.png` / `-512.png` | Primary glyph, transparent                                |
| `public/apple-touch-icon.png`                  | Primary glyph on `#FCFDF9`                                |
| `public/favicon.ico`                           | Primary glyph, 16–64 px                                   |

Tile treatment (app-icon and directory contexts): the apple in cream
`#F5EFE2` with a `#5DA85F` leaf on a deep green `#0B3D24` field, lines
knocked out to the field color.

Rules:

- The label lines are knockouts, never painted a background color — the
  mark must work on any ground.
- Do not add a letterform, face, or chart furniture to the mark.
- At 16 px the silhouette and leaf carry the mark; do not thicken the
  thin rules to compensate.

Provenance: chosen by Michael on 2026-11-09 through an Impeccable
direction round (Facts Panel direction; contract in
`.impeccable/surfaces/public-brand-munch-mark-svg.md`). The shipping
geometry was drawn as SVG in-repo; the exploratory AI-generated comps in
`.impeccable/mocks/` are decision records, not sources.

Social card: `public/og.png` (1200×630) composes the primary glyph on
`#FCFDF9` beside the headline "Persistent nutrition / for your AI" (dark
`#16221B` over brand green) and three subtext lines in `#55635B` — the
client line ("Works with ChatGPT, Claude, and any MCP app"), the
data line, and the price line — per the 2026-11-09 MCP-wide positioning
ruling. Its source is `public/og.svg`; re-render with
`ffmpeg -y -i public/og.svg public/og.png`.

## Design authority — enforced law (ratified 2026-11-11)

The canonical design spec for every Munch surface. When a rendering, a PR,
or a screen disagrees with this chapter, this chapter wins until it is
amended here — drift happens one unrecorded exception at a time, so
exceptions get recorded here or they don't ship. Color, surfaces, inputs,
type, spacing, indicators, and copy were ratified 2026-11-11; the button
chapter is FINAL — Direction C, picked by Michael on Nov 11, 2026. This
chapter is enforced by automated drift checks (`src/design-authority.test.ts`,
run on every PR by the CI quality lane): the design authority is enforced
law as of this PR, not a style suggestion.

### Color tokens

| Token      | Hex       | Role                                                                 |
| ---------- | --------- | -------------------------------------------------------------------- |
| paper      | `#f6f1e7` | The ground. Every screen sits on it.                                 |
| panel      | `#fffdf8` | The ONE elevated material: cards, dialogs, the recipe strip bar.     |
| ink        | `#2b2620` | Primary text; secondary-button text.                                 |
| ink-soft   | `#4a4237` | Quiet-action text; sub-headings.                                     |
| ink-mute   | `#5d5344` | Secondary text: meta lines, counts, captions.                        |
| hairline   | `#d8cdb6` | Passive rules: panel top rules, row dividers, dialog border.         |
| rule       | `#8a7c63` | The one control-border tan: secondary borders, field borders.        |
| green      | `#176b3a` | THE action color: the one primary per surface; active states.        |
| green-deep | `#0b3d24` | Primary hover/pressed only.                                          |
| green-tint | `#eef4ea` | Pale green wash: selected-day wells, text selection.                 |
| gold       | `#8a6d3b` | RESERVED: active-nav dot, calendar today marker, chart accents only. |
| danger     | `#8c2f22` | RESERVED: shortage and destructive signals only.                     |

Gold never styles a button and never emphasizes text. Danger never styles
anything except shortage/destructive signals.

**Warning family (ratified 2026-11-13, punch-list P5):** warn-line
`#b98a00`, warn-text `#8a6100`. RESERVED: warning signals only (stale or
suspect data, expiring stock) — never decoration, never a button fill.
The near-duplicate `#8a6d00` is retired into warn-text.

**Chart palette (ratified 2026-11-13, punch-list P3):** the pre-authority
Trends chart system is adopted as the named chart palette — series green
`#2e5b34` (the same green as the brain glyph: one learned "insight" green),
chart ink `#22301f`, sage `#6e7462`, sand `#c9bfa3`, wash `#e6eddc`, with
gold `#8a6d3b` accents per the token table. These values are chart-only:
they style chart marks, selected-day wells, and Trends pills — never
buttons, fields, or general surfaces.

### Surface rules

1. Screens sit on **paper**. Nothing else is a screen background.
2. **Panel is the only elevated material.** Cards, dialogs, and the recipe
   strip bar are panel (`#fffdf8`) with a hairline border where a border is
   needed. A dialog reads as the same material as the app's cards — never
   an unrelated white.
3. **Fields invert by surface:** on paper, fields are panel-filled; inside
   a panel dialog, fields are paper wells. The two materials swap; no
   third surface is introduced.
4. The dialog scrim is `rgb(43 38 32 / .48)`.

### Button system — FINAL: Direction C

Direction C — "No fill, outline only" — is the single button spec for
every Munch surface. It is the app's own shipped button language.
Directions A (white fill, green letters) and B (beige tint) were presented
and NOT picked; B's beige `#efe9db` stays retired (see Retired values).

| Tier        | Spec                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Primary     | fill `#176b3a`, border `#176b3a`, white text, hover `#0b3d24`. ONE per surface.                                                       |
| Secondary   | fill transparent, border rule `#8a7c63`, text ink `#2b2620`. Stays transparent on hover.                                              |
| Quiet       | no fill, no border, text ink-soft `#4a4237`. Dismissive/removal actions (Close, Remove).                                              |
| Destructive | fill transparent, border danger `#8c2f22`, text danger. Irreversible actions only; removing a grocery item is quiet, not destructive. |
| Card strip  | transparent bar on paper, rule border, hairline dividers, segments ink text.                                                          |

**Geometry — the 31px drawn anchor.** Controls draw at the Recipes header
door-button anchor: drawn height **31px**, padding **6px 14px**, border
**1px**, radius **10px**, type **.9rem Georgia, weight 600** (quiet: 500).
Search, selects, card-strip buttons, dialog fields, and secondary actions
match the anchor. **Drawn size and hit size are separate:** the drawn box
may be 31px, but the hit area is always **≥44px**, delivered by an
invisible overlay or a 44px row — never by inflating the drawn control.
Checkbox: **22px drawn** inside a **44px tap area**; tapping the item name
also toggles.

Inputs and selects: height 31px (anchor), padding 5px 12px, type 1rem
serif, border 1px rule `#8a7c63`, radius 10px, fill by surface (above).
Focus on all controls: 2px green outline, 1px offset.

Resolved divergence (punch-list P2, PR #329): production chrome
previously shipped 44–48px drawn boxes with a 4px button radius.
The anchor now governs in production — drawn geometry is 31px /
padding 6px 14px / radius 10px, dialog cards take the board's 14px
radius (mobile sheet 24px top unchanged), and the ≥44px hit area is
delivered by invisible overlay or row, never by inflating the drawn
control. The drift checks enforce the anchor geometry, not only the
hit floor.

### Type scale and the 11px floor

Serif throughout (Georgia). Page heading 33px/600; dialog title 25.6px;
panel title 21px/600; body and item names 15px; buttons 14.4px (`.9rem`);
secondary text 13px; fine print 12px. **11px is the FLOOR** — micro-labels
only (uppercase counts, source chips, nav labels). Nothing renders below
11px, ever. The only sanctioned exception is chart annotation (SVG axis,
donut, and heatmap labels inside Trends charts), allow-listed by selector
in the drift checks. Density comes from structure and grouping, never
from shrinking type or targets.

### Indicator rule

Shortages and waiting states are signaled by a **dot or a small badge the
user taps** — the red dot on the Groceries tab, the `!` badge by the title
(danger ink, 23px badge in a 44px hit area). **Never a banner.** The
rundown lives behind the tap, in a dialog, as rows of data.

### Retired values — do not use

| Value     | What it was                              | Evidence                                                                                                                                            |
| --------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#efe9db` | Beige button tint (specimen direction B) | Appears in no production stylesheet; entered through rendering passes; direction B was NOT picked on Nov 11, 2026.                                  |
| `#b8a888` | Mid-tan border                           | Appears in no production stylesheet; rendering-pass invention. The one control-border tan is rule `#8a7c63`.                                        |
| `#b3261e` | Material-design danger red               | Pre-authority danger color in settings/household CSS; replaced by authority danger `#8c2f22` in the enforcement pass.                               |
| `#fffdf7` | Off-by-one panel tint                    | Panel is `#fffdf8`; the one-digit variant appeared as literal fills and var() fallbacks in Trends/Today CSS and was purged in the enforcement pass. |
| `#fffef9` | Off-by-one panel tint                    | Same family as `#fffdf7`; appeared as the macro-micros well background and was purged in the enforcement pass.                                      |
| `#6e241a` | Filled-destructive hover/pressed family  | Retired 2026-11-13 (punch-list P4): destructive is transparent per Direction C; danger `#8c2f22` carries the signal alone.                          |
| `#ded5c0` | `--line` fallback hairline variant       | Retired 2026-11-13 (punch-list P6): the one hairline is `#d8cdb6`.                                                                                  |
| `#8a6d00` | Warning-amber near-duplicate             | Retired 2026-11-13 (punch-list P5): consolidated into warn-text `#8a6100`. (Distinct from gold `#8a6d3b`, which stays reserved as tabled above.)    |

### Copy law — NO FILLER

Copy carries information — data, a rule with consequences, a gate, or real
guidance. Sentences that describe the screen the user is already looking
at, restate the obvious, or narrate the app's own behavior ("we'll check
your pantry…") are defects and are deleted on sight. Labels say what the
thing is; buttons say what happens.

### Enforcement

`src/design-authority.test.ts` parses the production stylesheets and
asserts: retired values are absent from `public/` stylesheets and markup;
the shared button tiers resolve to the Direction C values above (parsed
declarations, CSS variables resolved); gold `#8a6d3b` appears only in the
check's allow-listed nav-indicator, calendar-today, and chart-accent
selectors; every button-like class in `public/` CSS is either spec-verified
or allow-listed with a reason in the check; and no `font-size` below the
11px floor appears outside the allow-listed chart annotations. A change
that needs an exception amends this chapter and the check's allow-list —
with the reason recorded — in the same PR.

### Punch list — audit remainder (2026-11-11), RULED 2026-11-13

Found by the enforcement audit, NOT fixed in the enforcement PR. Ruled
2026-11-13 under Michael's delegation ("you do everything yourself") —
each ruling below is the law for its build pass; builds mark their line
RESOLVED with the landing PR.

- **P1 — `public/styles.css` legacy grammar:** RULED — one grammar. The
  sheet re-skins to this chapter's tokens and Direction C buttons
  (transparent secondary, primary without shadow, radius 10px), keeping
  its roles: app base layer under `app-overrides.css` and the standalone
  reviewer/password pages. The check-(d) allow-list entries for its
  classes retire as the values conform.
- **P2 — Drawn-geometry reconciliation:** RESOLVED (PR #329) — the
  anchor governs (see the geometry chapter note above). Production
  drawn geometry is reconciled to 31px / 6px 14px / 10px radius;
  dialog cards take the board's 14px radius (mobile sheet 24px top
  unchanged); hit areas stay ≥44px via overlay or row. This was the
  geometry pass in `public/app-overrides.css`.
- **P3 — Trends chart palette:** RESOLVED (ruling PR #327, build PR
  #330) — ratified as-is and named in the Color tokens chapter (chart
  palette paragraph). No value changes; the palette is chart-only and
  the drift check treats it as such (check section (g)).
- **P4 — Filled destructive confirms:** RESOLVED (PR #329) —
  Direction C governs: destructive confirms are transparent with
  danger `#8c2f22` border and text, transparent on hover like every
  outline tier. `.meal-draft-abandon-confirm` conforms; the `#6e241a`
  filled/hover family is retired (see Retired values) and the drift
  check's retired list now carries it.
- **P5 — Warning amber family:** RESOLVED (ruling PR #327, build PR
  #330) — the warning family is ratified in the Color tokens chapter
  (warn-line `#b98a00`, warn-text `#8a6100`); `#8a6d00` consolidated
  into warn-text and retired. Sheets reference the tokens; the drift
  check enforces them (check section (h)).
- **P6 — Hairline/tint variants:** RESOLVED (ruling PR #327, build PR
  #330) — the one hairline is `#d8cdb6`; the `#ded5c0` fallback family
  retired to it everywhere and joined the drift check's retired list.
  Paper-adjacent tints: passive surfaces (rules, wells, non-data
  bands) consolidated to the nearest authority token (panel / paper /
  green-tint / hairline); data-bearing tints (chart bands, selected
  wells) kept their values under the chart palette ruling (P3). The
  pass was surface-by-surface with before/after captures (PR #330).
