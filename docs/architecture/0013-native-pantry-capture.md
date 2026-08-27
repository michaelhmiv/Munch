# Native Pantry capture

Munch's installed mobile client uses native device capture without creating a second Pantry implementation.

## Image capture

The installed Pantry surface adds native camera and photo-library actions. `@capacitor/camera` returns a local media result, the installed bridge converts that result to an in-memory `File`, and the file is handed to the existing Pantry/receipt file inputs. The existing web logic continues to own the 8 MB validation, transient preview endpoints, user review, and final reconciliation.

Android camera activity results are also consumed through Capacitor App's `appRestoredResult` event so a low-memory activity restart can return the captured image to the pending Pantry or receipt review.

No captured image is intentionally saved to the user's gallery by Munch.

## Barcode capture

The native barcode scanner returns a barcode string only. Munch does not treat that string as product identity. The installed client sends it to the existing `/api/app/food-barcode` endpoint, which resolves the barcode through the canonical food provider service.

A resolved product is displayed for explicit confirmation. Only after confirmation does the installed client send an `acquire` operation to `/api/app/pantry/reconcile`, preserving the canonical provider, provider food ID, and barcode on the inventory item. Unresolved barcodes are not written automatically and fall back to Pantry Quick add.

## Shared product contract

Native device access is intentionally limited to capture. Food resolution, Pantry authorization, household scope, idempotency, canonical identity, inventory writes, receipt review, image analysis, and reconciliation remain server/shared-product responsibilities. This keeps website, ChatGPT, Android, and later iOS behavior on the same data and entitlement model.
