# Android monetization and Play launch plan

Status: Proposed implementation plan  
Scope: Android first. Keep the app and backend ready for a later iOS StoreKit implementation.

## Product model

The Android product has three independent parts:

1. **Free app with ads:** all Android non-AI capabilities, including Pantry and household collaboration, are available without a subscription.
2. **Ad-free subscription:** removes ads only; it does not unlock baseline app features or include AI usage.
3. **AI credit packs:** optional consumable purchases for Munch-operated AI features. Credits are charged per task using measured model cost, not exposed as raw tokens.

The current website and MCP subscription model remains separate: the site has a $4.99/month Stripe Premium offer, and its free tier limits history and some recipe/planning features. Android must not reuse that Premium SKU as an ad-removal product. Preserve current Stripe customer access and web/MCP behavior during this Android release. An existing paid Premium customer should receive ad-free Android access while their current website/MCP entitlements remain intact.

ChatGPT or another MCP host may provide its own model usage. Those host-model calls are not Munch-operated AI and must not consume Munch credits. OpenAI account-usage sharing can be explored later if Munch receives access to the limited partner preview; it is not a release dependency.

## Current repository baseline

- Munch already has a Capacitor Android app with package ID business.munch.app and bundled web assets.
- The Android build includes Play Billing Library 9.1.0 and a custom native BillingClient bridge.
- The backend already has Google Play subscription purchase verification, account binding, subscription persistence, and a Real-time Developer Notifications route.
- The current Play purchase flow only covers the Premium subscription. It does not yet support consumable AI credit products or ad entitlements.
- Product configuration currently points to the planned product ID munch_premium_monthly and base plan monthly. Do not repurpose that ID for the new ad-free offer.
- The existing server uses Better Auth and Railway PostgreSQL. Firebase Auth and Firestore are not required for this product architecture.
- The Android workflow currently builds and tests a debug APK. A signed release AAB, store listing, Play purchase credentials, and AdMob integration still need setup.
- No AdMob SDK or UMP consent flow is integrated in the Android app.
- Firebase Crashlytics Gradle/SDK wiring is in implementation PR #157. The real Firebase app config is still required to build a Munch-connected app and verify crash reporting.
- The AdMob account is approved. A Munch Android app entry and home banner unit exist but are not linked to a Play listing yet: app ID `ca-app-pub-2708638041809482~4540309917`, banner unit `ca-app-pub-2708638041809482/4316948636`. The AdMob console warns the account is nearing its inactivity cutoff, so serving a valid impression soon after launch matters.
- A Firebase Spark project named Munch Android (`munch-android-bf1cd`) and Android app `business.munch.app` have been created. Google Analytics and Gemini are off. Crashlytics is the only approved Firebase SDK; Firebase Auth, Firestore, and Analytics remain out of scope.

## Implementation sequence

### 1. Lock the entitlement matrix

Create a small product/entitlement ADR before modifying billing:

- Free Android accounts receive all non-AI app features, including Pantry and household collaboration.
- The new ad-free entitlement only controls whether Android may request/show ads.
- AI credits are an independent balance and do not come with the ad-free subscription.
- Existing Stripe Premium records and web/MCP behavior remain intact for this release.
- Map any existing paid Premium customer to at least the Android ad-free state while preserving their current paid features.

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
- Default to contextual/non-personalized ads where available. The Google Mobile Ads SDK can collect/share IP address, app interactions, diagnostics, and device/account identifiers for advertising, analytics, and fraud prevention; document the SDK's actual version and configuration in the privacy policy and Data Safety form. Never send meal names, ingredients, calorie/macronutrient values, weight, goals, allergies, or other nutrition data to AdMob or analytics event parameters.
- Review sensitive-category blocking for health/weight-loss categories and verify ad behavior in the regions where Munch launches.
- Update the privacy policy and Play Data Safety responses to list the actual ad SDK data collection, consent behavior, and opt-out controls.

### 4. Add the minimum useful Firebase services

The Firebase project `munch-android-bf1cd` and Android app `business.munch.app` are registered on the Spark plan. Crashlytics is approved and wired in implementation PR #157. Google Analytics and Gemini are disabled; Firebase Auth and Firestore are out of scope. The Android build still needs its real `google-services.json`, followed by an internal crash test.

- Crashlytics reports crash stack traces and related app/device diagnostics to Firebase/Google. Do not attach Munch account IDs, meal content, or nutrition records to reports. Update the privacy policy to describe this before distributing a build with reporting enabled.
- Add Firebase Analytics only if a minimal event schema is approved. Events may describe screens and coarse conversion outcomes; they must not contain nutrition details or user-entered content. If Analytics is not needed for launch, leave it disabled.
- Do not add Firebase Auth or Firestore: identity and application data remain in Better Auth and Railway PostgreSQL.
- Add the Firebase client configuration to the Android build. Firebase documents this client config as public by design; commit it with the app when available, and do not commit service-account keys or backend credentials.

### 5. Finish Play billing and Google Cloud setup

After the product IDs and account choice are confirmed:

- Create the Play Console app for package business.munch.app and enable Play App Signing after the account owner completes the app-policy and U.S. export-law attestations.
- Create a new subscription product for ad removal, separate from munch_premium_monthly. Start with monthly only unless annual pricing is approved.
- Create three consumable AI credit products after the credit quantities and prices are costed.
- Enable the Google Play Android Developer API and create a narrowly scoped service account for purchase verification/acknowledgement. Grant only the Play Console permissions needed for Munch.
- Create the Pub/Sub topic and authenticated push subscription for the existing Google Play notification endpoint.
- Add Google Play service-account and Pub/Sub verification secrets to the Munch Railway service through its secret-variable interface. Never place private keys in GitHub, the app bundle, logs, or this plan.
- Munch is already registered in AdMob with a banner unit; link it to the Play listing when available, integrate UMP, and complete AdMob privacy messaging.
- The Android app is already registered in Firebase; add the real Android config and verify Crashlytics with an internal test build.
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

- Use the existing personal Play developer account, as selected. The account owner must still affirm Play's app-policy and U.S. export-law declarations before creating the app.
- Android feature scope is set: all non-AI features, including Pantry and household collaboration, are free with ads; the subscription removes ads, and AI credits are separate.
- Approve the ad-free price and whether annual billing launches with monthly.
- Approve credit-pack sizes and prices after the real provider-cost/fee model is measured.
- Crash reporting to Firebase via Crashlytics is approved; Firebase Analytics remains disabled.

## Official references

- [Play Billing backend integration](https://developer.android.com/google/play/billing/backend)
- [Play Billing security recommendations](https://developer.android.com/google/play/billing/security)
- [One-time purchase lifecycle](https://developer.android.com/google/play/billing/lifecycle/one-time)
- [Play Billing testing](https://developer.android.com/google/play/billing/test)
- [AdMob Android quick start](https://developers.google.com/admob/android/quick-start)
- [AdMob UMP consent setup](https://developers.google.com/admob/android/privacy)
- [Google Mobile Ads SDK Android Data Safety disclosure](https://developers.google.com/admob/android/privacy/play-data-disclosure)
- [Firebase Android Data Safety disclosure](https://firebase.google.com/docs/android/play-data-disclosure)
- [Google Play Data Safety form requirements](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Firebase Android setup](https://firebase.google.com/docs/android/setup)
- [Firebase Crashlytics Android setup](https://firebase.google.com/docs/crashlytics/android/get-started)
- [Google Play Health apps declaration](https://support.google.com/googleplay/android-developer/answer/14738291)
- [Testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Google Play developer account information and disclosures](https://support.google.com/googleplay/android-developer/answer/13634081)
