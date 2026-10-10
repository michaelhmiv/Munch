# Android monetization and Play launch plan

Status: Proposed implementation plan  
Scope: Android first. Keep the app and backend ready for a later iOS StoreKit implementation.

## Product model

The Android product should have three independent parts:

1. **Free app with ads:** all agreed non-AI app capabilities are available without a subscription. Ads support the free experience.
2. **Ad-free subscription:** the same app capabilities, with ads removed. It does not include AI usage.
3. **AI credit packs:** optional consumable purchases for Munch-operated AI features. Credits are charged per task using the measured cost of the selected model, not exposed as raw tokens.

The current website and MCP subscription model is separate: the site has a $4.99/month Stripe Premium offer, and the current free tier limits history and some recipe/planning features. Android must not reuse that Premium SKU as an ad-removal product. Preserve current Stripe customer access during this Android release. Before implementation, write down whether “full features” includes household seats and Pantry, and decide whether the free feature model applies only to Android or later to all Munch surfaces.

ChatGPT or another MCP host may provide its own model usage. Those host-model calls are not Munch-operated AI and must not consume Munch credits. OpenAI account-usage sharing can be explored later if Munch receives access to the limited partner preview; it is not a release dependency.

## Current repository baseline

- Munch already has a Capacitor Android app with package ID business.munch.app and bundled web assets.
- The Android build includes Play Billing Library 9.1.0 and a custom native BillingClient bridge.
- The backend already has Google Play subscription purchase verification, account binding, subscription persistence, and a Real-time Developer Notifications route.
- The current Play purchase flow only covers the Premium subscription. It does not yet support consumable AI credit products or ad entitlements.
- Product configuration currently points to the planned product ID munch_premium_monthly and base plan monthly. Do not repurpose that ID for the new ad-free offer.
- The existing server uses Better Auth and Railway PostgreSQL. Firebase Auth and Firestore are not required for this product architecture.
- The Android workflow currently builds and tests a debug APK. A signed release AAB, store listing, Google service credentials, AdMob integration, and Firebase integration still need setup.
- No AdMob SDK, UMP consent flow, or Firebase Crashlytics SDK is integrated in the Android app.

## Implementation sequence

### 1. Lock the entitlement matrix

Create a small product/entitlement ADR before modifying billing:

- Free Android accounts receive the agreed full non-AI app feature set.
- The new ad-free entitlement only controls whether Android may request/show ads.
- AI credits are an independent balance and do not come with the ad-free subscription.
- Existing Stripe Premium records and web/MCP behavior remain intact for this release.
- Map any existing paid Premium customer to at least the Android ad-free state while preserving their current paid features.
- Define whether household and Pantry capabilities are part of Android’s free feature set.

Add explicit Android capability checks instead of using one Premium boolean for access, ads, and AI. Never trust a client-side “no ads” or credit balance flag.

### 2. Add the AI credit ledger and purchase support

Keep all provider keys and model calls on the Railway backend.

- Add an idempotent purchase ledger keyed by store, app, product, and purchase token, plus an append-only credit ledger for grants, usage, refunds, and adjustments.
- Add a catalog mapping each consumable Play product to a fixed credit amount. Product identifiers and credit amounts become immutable once sold.
- Generalize the native billing bridge to query and purchase one-time products as well as subscriptions.
- Verify one-time purchases server-side with the Google Play Developer API. Grant credits only after Google confirms a completed purchase. Consume the purchase through the backend after the ledger grant succeeds.
- Extend RTDN and voided-purchase handling to reverse credits for refunds or canceled purchases. Replays must never grant credits twice.
- Add reserve/settle/refund handling around every Munch-operated AI call. Reserve before calling the model, settle from measured input/output usage, and restore the reservation when a request fails before producing usable output.
- Start with the website-guided recipe proposal route using the configured OpenRouter model. Audit every other server-operated model route before enabling credits there.
- Keep manual workflows available when a user has no credits or the model is unavailable.

Set pack prices only after measuring representative input/output costs and applying Play fees, refunds, and infrastructure costs. A 10% token-cost markup is too thin for a store-sold pack. Use task-level “AI credits” in the UI; do not market them as an exact number of provider tokens.

### 3. Add AdMob and privacy-aware ad behavior

- Integrate the Google Mobile Ads SDK behind a Capacitor platform adapter. Use Google test ad IDs in debug and internal QA builds; production IDs are supplied only after AdMob setup.
- Start with a limited banner placement on a low-interruption screen. Do not interrupt barcode capture, meal entry, photo review, confirmation, or purchase flows with an interstitial.
- Do not request ads when the server-confirmed ad-free entitlement is active.
- Integrate Google’s UMP SDK and show required consent/privacy choices before eligible ad requests. Add a persistent privacy-options entry point.
- Default to contextual/non-personalized ads where available. Never send meal names, ingredients, calorie/macronutrient values, weight, goals, allergies, or other nutrition data to AdMob for targeting or to analytics event parameters.
- Review sensitive-category blocking for health/weight-loss categories and verify ad behavior in the regions where Munch launches.
- Update the privacy policy and Play Data Safety responses to list the actual ad SDK data collection, consent behavior, and opt-out controls.

### 4. Add the minimum useful Firebase services

Create a Firebase project for Munch Android and register business.munch.app.

- Add Firebase Crashlytics for crash diagnostics, without attaching Munch account IDs, meal content, or nutrition records to crash reports.
- Add Firebase Analytics only if a minimal event schema is approved. Events may describe screens and coarse conversion outcomes; they must not contain nutrition details or user-entered content. If Analytics is not needed for launch, leave it disabled.
- Do not add Firebase Auth or Firestore: identity and application data remain in Better Auth and Railway PostgreSQL.
- Add the Firebase client configuration to the Android build with API-key restrictions appropriate for the package and signing certificate. Do not commit service-account keys or backend credentials.

### 5. Finish Play billing and Google Cloud setup

After the product IDs and account choice are confirmed:

- Create the Play Console app for package business.munch.app and enable Play App Signing.
- Create a new subscription product for ad removal, separate from munch_premium_monthly. Start with monthly only unless annual pricing is approved.
- Create three consumable AI credit products after the credit quantities and prices are costed.
- Enable the Google Play Android Developer API and create a narrowly scoped service account for purchase verification/acknowledgement. Grant only the Play Console permissions needed for Munch.
- Create the Pub/Sub topic and authenticated push subscription for the existing Google Play notification endpoint.
- Add Google Play service-account and Pub/Sub verification secrets to the Munch Railway service through its secret-variable interface. Never place private keys in GitHub, the app bundle, logs, or this plan.
- Register Munch in AdMob, create ad units, link the Play listing when available, and complete AdMob privacy messaging.
- Register the Android app in Firebase and configure Crashlytics.
- Set the app’s publisher contact details and store metadata only after confirming the developer account’s public identity/address choice.

### 6. Store listing and policy readiness

Prepare and verify:

- Store listing name, short/full descriptions, icon, feature graphic, screenshots, support URL, support email, privacy-policy URL, and release notes.
- Ads declaration, Data Safety form, content rating, target audience, app-access instructions, account-deletion path, and health-app declaration.
- Munch tracks nutrition and personal health/wellness information, so complete the Google Play Health apps declaration accurately, including on test tracks.
- Verify whether this personal developer account is subject to the 12-tester/14-day closed-test requirement before production access.
- Review the developer profile disclosure before activating paid products. Google displays the legal name, legal address, developer email, and phone for developer accounts; merchant accounts with in-app purchases must display the full address on Google Play.

### 7. Test, certify, and release

Add automated coverage for:

- Free, ad-free, legacy Premium, and AI-credit entitlement combinations.
- Purchase-token ownership, duplicate/replayed tokens, pending purchases, consume failures, refunds, and voided purchases.
- Subscription renewals, cancellation, grace period, account hold, restore on another device, and cross-store account binding.
- Credit reservation/settlement, provider timeout, insufficient credits, repeated requests, and refund behavior.
- Ad requests blocked for ad-free users, UMP consent-required states, non-personalized requests, and test-versus-production ad IDs.
- No nutrition or user-entered content in ad/analytics telemetry.

Build a signed release AAB, then run internal testing with license testers. Verify billing lifecycle using Play Billing Lab, test consent in relevant regions, and exercise the app on real devices. Move to closed testing and complete any account-specific testing requirement before requesting production access. Release only after policy declarations, privacy disclosures, purchase notifications, crash reporting, and a production rollback plan are verified.

## PR breakdown

1. **Entitlements and product contract:** ADR, capability separation, compatibility behavior, schema migration, and tests.
2. **AI credits and consumable Play Billing:** ledger, backend verification/consume/RTDN, native product purchase flow, usage metering, and UI.
3. **AdMob and UMP:** native adapter, safe placements, entitlement-aware ad suppression, consent/settings, and policy tests.
4. **Firebase Crashlytics and disclosures:** Gradle setup, restricted logging, privacy-policy/Data Safety updates, and crash verification.
5. **Play release readiness:** release AAB signing workflow, store assets/metadata, tester guide, policy checklist, and internal/closed testing certification.

## Owner decisions needed before products go live

- Use the current personal Play developer account after reviewing its public legal-address disclosure, or use an organization account with the correct business identity.
- Confirm the exact Android feature set that is free, including Pantry and household collaboration.
- Approve the ad-free price and whether annual billing launches with monthly.
- Approve credit-pack sizes and prices after the real provider-cost/fee model is measured.
- Decide whether Firebase Analytics is worth collecting minimal app telemetry, or launch with Crashlytics only.

## Official references

- [Play Billing backend integration](https://developer.android.com/google/play/billing/backend)
- [Play Billing security recommendations](https://developer.android.com/google/play/billing/security)
- [One-time purchase lifecycle](https://developer.android.com/google/play/billing/lifecycle/one-time)
- [Play Billing testing](https://developer.android.com/google/play/billing/test)
- [AdMob Android quick start](https://developers.google.com/admob/android/quick-start)
- [AdMob UMP consent setup](https://developers.google.com/admob/android/privacy)
- [Firebase Android setup](https://firebase.google.com/docs/android/setup)
- [Firebase Crashlytics Android setup](https://firebase.google.com/docs/crashlytics/android/get-started)
- [Google Play Health apps declaration](https://support.google.com/googleplay/android-developer/answer/14738291)
- [Testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Google Play developer account information and disclosures](https://support.google.com/googleplay/android-developer/answer/13634081)
