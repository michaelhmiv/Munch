# Free, Premium, and household product contract

## Product boundary

Munch is the factual food and macro data layer used by ChatGPT and compatible MCP clients. Munch stores food-source facts, serving data, nutrition arithmetic, confirmed meal history, recipes, planned meals, grocery items, and access relationships. The client model performs conversational reasoning and may infer descriptions such as frequently used, high protein, or likely favorite from the stored facts.

Munch does not determine ideal calorie intake, protein requirements, weight-loss targets, medical diets, or whether a food is healthy. It does not persist model-generated recipe tags or recommendation scores.

## Permanent Free tier

Every active account can connect and permanently use core nutrition capabilities:

- food and barcode search;
- food details, serving data, nutrition facts, and provenance;
- meal drafting, confirmation, logging, editing, and deletion;
- hydration, weight, and user-entered goal records;
- daily summaries;
- the most recent 30 days of conversational history;
- up to 25 saved foods;
- export, account deletion, connection review, and revocation.

Older records remain stored and exportable. The history window limits conversational retrieval; it does not delete records or restrict data rights.

## Premium tier

A direct Premium subscription adds:

- unlimited searchable personal history;
- unlimited saved foods;
- a structured personal recipe book;
- deterministic recipe nutrition calculation;
- immutable recipe revisions and scaling;
- a personal meal calendar;
- a personal grocery list;
- creation and management of one shared household workspace.

The current website price is $4.99 per month with a 30-day first-subscription trial. Stripe Checkout and subscription promotion exist only on the independent Munch website and account portal.

## Household workspace

A Premium household owner may share one workspace with up to six connected Munch accounts. Shared resources are:

- household recipes;
- household planned meals;
- household grocery lists.

Owners and members may edit while the owner's qualifying subscription is active. Viewers are read-only. If the owner's entitlement ends, shared records remain readable and exportable but new shared writes are disabled. Personal nutrition records never become household records merely because a user joins a household.

Household membership does not grant unlimited personal history or a personal recipe workspace to non-subscribing members. It grants only the shared capabilities covered by the household owner.

## Plugin billing separation

OAuth, consent, MCP authentication, tool discovery, tool results, and tool errors are billing-neutral. They do not:

- show plans or prices;
- initiate Checkout;
- advertise unavailable Premium tools;
- return upgrade links;
- require payment to connect or use the permanent Free tier.

Existing subscribers receive the capabilities already included with their Munch account through server-side entitlement-aware tool registration.

## Canonical data principle

Munch persists facts and events rather than conclusions:

- ingredients, quantities, servings, nutrients, timing, and source provenance;
- recipes and immutable revisions;
- planned dates and meal slots;
- explicit grocery needs and purchase state;
- saved, scheduled, logged, and modified timestamps;
- personal ownership and household membership.

Munch intentionally does not persist fields such as `favorite`, `healthy`, `high_protein`, `quick`, `weeknight`, `recommended`, assigned cook, or pantry ownership. The language model may derive relevant descriptions from the canonical data for the current request.
