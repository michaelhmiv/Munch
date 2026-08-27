# Google Play visual asset checklist

Use only real production/closed-test Munch UI. Do not create fake feature screenshots or show controls that are not present in the submitted build.

## App icon

Play Console high-resolution icon:

- 512 × 512 PNG
- use the current Munch green `M` mark
- no transparency if Play rejects the source treatment
- verify the icon visually matches the adaptive launcher icon generated into the Android project

Repository source assets already include `public/brand/munch-mark-512.png`; use that as the starting source unless branding changes before submission.

## Feature graphic

Required Play feature graphic:

- 1024 × 500 JPG or PNG
- Munch brand mark/name, simple nutrition/meal-planning positioning
- no pricing claims unless the exact Play price shown is current for the locale
- no device-frame UI that differs from the submitted build
- no medical or guaranteed weight-loss claims

## Phone screenshots

Capture from a Play-signed internal or closed build on a real Android phone. Recommended minimum set:

1. **Today** — daily nutrition summary and recent meals.
2. **Log** — food search or meal composer with real Munch UI.
3. **Recipes** — saved recipes / recipe detail.
4. **Plan** — meal-planning calendar or schedule.
5. **Groceries** — active grocery list.
6. **Pantry** — current Pantry inventory.
7. **Pantry scan** — real camera/photo review workflow after a user-selected image, without exposing personal receipt/account information.
8. **Insights** — nutrition history/trends.

Capture at least the number Play Console currently requires for phone listings; keeping 6–8 representative screenshots gives the listing enough breadth.

## Screenshot hygiene

Before capture:

- use the dedicated reviewer/demo account, not a real personal account
- use representative non-sensitive sample foods/recipes
- remove email addresses from any visible settings screen
- avoid notification shade, status messages containing tokens, debug overlays, or test credentials
- confirm Android navigation/safe-area presentation is correct
- do not show ChatGPT UI as if it is part of the Android app
- do not show third-party trademarks more prominently than needed for a factual food/product example

## Tablet / Chromebook assets

Do not opt into tablet/Chromebook-specific marketing until the corresponding form factor has been manually verified. If Play requires screenshots because the artifact is available to those devices, test the actual responsive layout and provide genuine captures rather than stretching phone screenshots.

## Review before upload

Every asset must be checked against the current Play metadata and Health policy:

- consumer wellness positioning only
- no diagnosis/treatment claims
- no guaranteed outcomes
- no deceptive representation of AI estimates as verified nutrition facts
- AI meal-idea screenshots should make it clear they are suggestions/estimates where the UI provides that context
