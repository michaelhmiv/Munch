# ADR-0012: Mobile product surfaces

Status: Accepted

## Context

Munch currently ships a browser application and an MCP surface backed by shared domain services. Android and iOS distribution are planned. A thin remote WebView would be fast to create but would couple the installed application to the hosted browser shell, preserve browser-only authentication assumptions, and make platform-specific functionality difficult to test and evolve.

The existing outcome capability contracts are the correct abstraction for parity, but mobile must become a first-class surface before native implementation starts.

## Decision

Munch will treat Web, MCP, Android, and iOS as delivery surfaces of one product rather than independent applications.

1. Customer outcomes remain the unit of parity. `src/capability-manifest.ts` and `src/inventory/capabilities.ts` remain the canonical MCP/Web contracts.
2. `src/mobile/capabilities.ts` is the canonical Android/iOS coverage declaration. CI fails when a canonical capability is added without a mobile declaration.
3. Android and iOS use the same Munch domain APIs as the browser. Mobile-specific duplicate business endpoints are prohibited unless an ADR documents why a platform boundary genuinely requires one.
4. Browser cookie sessions and same-origin/CSRF protections remain intact. Installed clients authenticate through a mobile-safe credential transport at the authentication boundary rather than weakening browser controls.
5. Shared feature code must depend on platform interfaces for camera, barcode scanning, secure storage, billing, deep links, sharing, notifications, and connectivity. Feature modules must not contain ad-hoc Android/iOS branching.
6. Mobile web assets are bundled with the installed application. Production Android/iOS builds must not be remote wrappers around `https://munch.business/app`.
7. Billing is entitlement-driven. Stripe, Google Play, and Apple App Store purchases normalize into canonical Munch entitlements before capability resolution.
8. A mobile capability may move from `planned` to `partial` or `complete` only when the corresponding certification coverage exists.

## Target repository shape

```text
apps/
  web/
  mobile/
packages/
  app-ui/
  client/
  contracts/
  platform/
src/
  # existing server/domain implementation
```

The migration to this shape is incremental. Existing browser behavior remains production-supported while modules are extracted.

## Consequences

- A new product feature cannot silently omit Android/iOS planning.
- Server/domain logic remains single-source-of-truth.
- Mobile platform APIs can evolve without forking feature logic.
- Browser security is not weakened to accommodate installed clients.
- Android can ship first without creating Android-only architecture that later blocks iOS.
