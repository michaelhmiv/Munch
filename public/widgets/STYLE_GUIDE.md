# Munch ChatGPT Widget Style Guide

Munch widgets are conversational interfaces, not miniature web pages. An inline
result should answer one question or support one decision without forcing the
user to navigate a dashboard inside the conversation.

## Surface hierarchy

- Use the host background for the outer document. Do not create a second page
  background inside ChatGPT.
- Munch owns exactly one visible bordered surface for an inline result. Widget
  resources therefore advertise `ui.prefersBorder: false` (and the ChatGPT
  compatibility alias) and the inline `.wrap` has no outer padding. Do not add a
  host border around another inset Munch card.
- Avoid cards nested inside cards. Use dividers, restrained surface fills, and
  progressive disclosure inside the single outer surface instead.
- Shadows are intentionally omitted. Separation comes from host-compatible
  borders, spacing, and restrained surface fills.
- The green Munch accent identifies primary actions, selected controls, and a
  small amount of brand emphasis. Nutrient colors are reserved for data.

## Inline versus fullscreen

Inline is for receipts, confirmation, compact status, and a small preview.
Fullscreen is for range controls, daily tables, import mapping, or any workflow
with more than one view.

Inline constraints:

- One primary action and at most one secondary action.
- No tablists, nested navigation, or internal vertical scrolling.
- Do not duplicate the ChatGPT composer with another freeform text box.
- Transform successful mutations into a durable receipt instead of leaving
  disabled controls on screen.
- Put the object the user acted on first. A one-food receipt says the food name
  and serving, not a generic label such as `1 food`.

Fullscreen-capable widgets declare both `inline` and `fullscreen` in
`appCapabilities.availableDisplayModes` through `initWidget`. The shared bridge
uses `ui/request-display-mode` and responds to host-context changes. Hosts that do
not support the mode request retain a functional expanded fallback.

## Typography and spacing

- Use the host font when supplied, otherwise the system font stack.
- Body text is 14px. Inline titles are generally 18px.
- Use no more than three typographic levels in one card.
- Numeric values use tabular numerals.
- Every interactive touch target, including compact buttons and disclosure
  summaries, is at least 44px high.

## Feedback and state

Every write surface must provide all of the following states:

1. Ready
2. Busy
3. Success receipt
4. Actionable failure

Do not render an empty frame after a successful tool call. When optional goals or
secondary data are absent, show the primary receipt and omit only the unavailable
supplementary section.

## Accessibility

- Every action is a native button or control with a visible focus indicator.
- Progress includes an accessible label and textual value.
- Charts include a text summary; color is never the sole carrier of meaning.
- `prefers-reduced-motion` disables transitions and animation.
- Fullscreen tables retain semantic headers and can scroll horizontally on small
  screens; inline cards do not contain scrolling tables.

## Resource identity and releases

A `ui://` resource URI is a host cache identity, not merely a label. Breaking
widget HTML, JavaScript, CSS, or host-contract changes must never replace bytes
behind the same URI.

- `src/widget-release.ts` is the source of truth for `MUNCH_APP_VERSION` and
  `MUNCH_WIDGET_RESOURCE_VERSION`.
- Every canonical `ui://widget/<name>.html` registration is published through
  `withVersionedWidgetResources` as
  `ui://widget/<name>/<MUNCH_WIDGET_RESOURCE_VERSION>.html`.
- Increment `MUNCH_WIDGET_RESOURCE_VERSION` whenever a deployed widget change is
  not safe to serve from an existing host cache key.
- Increment `MUNCH_APP_VERSION` for a user-visible app release. The MCP server and
  every widget `ui/initialize` handshake must report that same version.
- Never reintroduce an independent hard-coded widget version in `bridge.js`.

## Shared source layout

Templates live in `public/widgets/src/templates/`. Shared runtime and styling live
in `public/widgets/src/shared/` and are inlined at server startup:

- `tokens.css` — host-compatible color, radius, spacing, and nutrient tokens
- `base.css` — layout, controls, receipts, metrics, progress, and accessibility
- `bridge.js` — MCP Apps handshake, tool calls, model context, messages, display mode
- `ui.js` — escaping, formatting, progress, metrics, and sparkline helpers

The resulting widget remains one self-contained HTML document with no external
CSS, scripts, fonts, or network dependencies. OpenAI's Apps SDK UI component
library is optional; Munch intentionally keeps these portable MCP Apps surfaces
self-contained unless a future migration provides a concrete UX or maintenance
benefit.

## Development boundary

`component-gallery` is a development-only template. `src/widgets.ts` excludes it
when `NODE_ENV=production`, and tests enforce that boundary. The local strict host
is available through `bun run harness`.

`scripts/widget-contract-smoke.ts` is the release guard for the production widget
inventory. It verifies assembled resources, release identity, cache-key
versioning, border ownership, touch targets, the structured single-food receipt,
and the two-action meal-review contract. Any intentional change to those
invariants must update the smoke test in the same pull request.
