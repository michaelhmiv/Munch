# Munch Android closed-testing handoff

This is the remaining operator work after the Android release branch is merged and green. There should be no code changes required to reach closed testing.

## 1. Create/verify the Play app

In Google Play Console:

- App name: **Munch**
- App/game: **App**
- Free/paid: **Free**
- Package established by first AAB: `business.munch.app`
- Category: **Health & Fitness**
- Support email: `support@munch.business`
- Website: `https://munch.business`
- Privacy policy: `https://munch.business/privacy`
- Account deletion URL: `https://munch.business/delete-account`
- Accept/enroll in Play App Signing.

Complete the Health declaration as **Health and fitness > Nutrition and Weight Management**. Use the prepared files in this directory for Data safety, content rating, store listing, reviewer access, and asset capture.

If Play Console itself requires Organization verification for this app/account, complete that verification; it does not require a Munch package or code change.

## 2. Create the persistent Munch upload key

Run locally somewhere you can securely back up the resulting file/passwords:

```bash
keytool -genkeypair -v \
  -keystore munch-upload.jks \
  -alias munch-upload \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

Then create the one-line base64 value:

macOS/Linux:

```bash
base64 < munch-upload.jks | tr -d '\n'
```

PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("munch-upload.jks"))
```

Back up `munch-upload.jks` and its passwords outside GitHub. Never commit it.

## 3. Add five GitHub repository secrets

In the Munch repository Actions secrets, add:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | one-line base64 of `munch-upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | upload-keystore password |
| `ANDROID_KEY_ALIAS` | normally `munch-upload` |
| `ANDROID_KEY_PASSWORD` | private-key password |
| `PLAY_SERVICE_ACCOUNT_JSON` | full Google service-account JSON used for Play publishing |

Do not paste any of these values into issues, PRs, chat, or source files.

## 4. Bootstrap the first AAB once

The pinned Play publishing action requires the package to already exist in Play Console.

1. In GitHub Actions run **Play release** with `destination=build-only`.
2. Download the `munch-android-...` artifact.
3. In Play Console create the first **Internal testing** release and upload `app-release.aab` manually.
4. Complete/roll out that internal release.

After this one bootstrap upload, GitHub Actions can publish future bundles through the Play Developer API.

## 5. Create/configure the Google service account

Enable the **Google Play Android Developer API** for the associated Google Cloud project and grant the service-account identity access to the Munch app in Play Console.

For the simplest setup, one service account may be used for both GitHub publishing and Munch server-side subscription verification. Give it the current permissions needed to:

- publish/manage Munch releases to the required testing track(s)
- view purchases/orders needed by the Purchases API
- manage orders and subscriptions

Use least privilege. If you prefer separate publishing/runtime identities, that is supported; put the publishing JSON in GitHub and the runtime JSON in Railway.

## 6. Create the Play Premium subscription

Play Console subscription:

- Product ID: `munch_premium_monthly`
- Product name: **Munch Premium**
- Base plan ID: `monthly`
- Type: auto-renewing
- Billing period: monthly
- Set the intended US price and review localized prices.

Do not create a separate Play product for household seats. Household seat billing remains a Stripe website feature.

## 7. Configure Railway billing verification

On the Railway **Munch** production service add:

| Railway variable | Value |
| --- | --- |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | full runtime Google service-account JSON (may be the same JSON as the GitHub Play service account) |
| `GOOGLE_PLAY_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL` | email of the dedicated Pub/Sub push-auth service account |
| `GOOGLE_PLAY_PUBSUB_PUSH_AUDIENCE` | `https://munch.business/webhooks/google-play` |

Munch intentionally keeps Play purchase UI disabled until all runtime billing + authenticated RTDN configuration is present.

## 8. Configure authenticated RTDN

In Google Cloud / Play Console:

1. Create a Pub/Sub topic for Google Play billing notifications.
2. Configure that topic in Munch's Play Console Real-time developer notifications settings.
3. Create a dedicated Pub/Sub push-auth service account.
4. Create a push subscription to:
   `https://munch.business/webhooks/google-play`
5. Enable OIDC authentication on the push subscription.
6. Set the push service account to the same email stored in `GOOGLE_PLAY_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL`.
7. Set the OIDC audience exactly to:
   `https://munch.business/webhooks/google-play`
8. Send Play's test notification after Railway has redeployed with the variables.

The endpoint rejects unauthenticated pushes and re-queries Google's SubscriptionPurchaseV2 API before changing Premium entitlement.

## 9. Complete Play app-content/listing fields

Prepared sources:

- `listing/en-US.md` — app name/short/full description
- `data-safety.md` — Data safety working answers
- `health-declaration.md` — Health declaration/disclaimer
- `content-rating.md` — content-rating working answers
- `review-access.md` — deterministic reviewer-account instructions
- `assets.md` — icon/feature-graphic/screenshot capture checklist
- `release-notes/whatsnew-en-US` — release notes

The only material not safely creatable from source alone is the final Play screenshots/feature graphic. Capture those from the actual signed app/reviewer account so the listing represents the real UI.

## 10. Reviewer account

Munch includes `scripts/provision-reviewer.ts`. The production reviewer account should be provisioned once before submitting a track that undergoes Play review. It creates a verified password account, Premium override, and representative sample data without enabling public password sign-up.

Enter that email/password in Play Console **App access** using the text in `review-access.md`. Do not require the reviewer to access an email inbox, ChatGPT, QR code, or a payment method.

## 11. Run automated internal, then closed publishing

Once the first manual AAB bootstrap and service-account access are complete:

### Internal

Run GitHub Actions → **Play release**:

- destination: `internal`
- release status: `completed`

Install from Play and verify at minimum:

- passwordless email sign-in and password reviewer sign-in
- meal logging/search
- recipes/planning/groceries
- Pantry camera/gallery/barcode flow
- AI meal idea + Report AI suggestion
- Google Play purchase and restore
- cancellation/RTDN entitlement reconciliation
- account export/deletion

### Closed

Run GitHub Actions → **Play release**:

- destination: `closed`
- closed track: normally `alpha` (or the exact custom track ID created in Play Console)
- release status: `completed`

Every run receives a new Play `versionCode` automatically; no source edit is needed just to retry publishing.

Add the tester list/Google Group and share Play's opt-in link. If the developer account is subject to the newer personal-account production-access rule, maintain at least 12 continuously opted-in testers for the required 14-day period before applying for production access.

## Definition of handoff-complete

Engineering is considered complete for closed-test entry when:

- `main` CI is green
- Android CI builds/verifies a signed release AAB with a disposable CI key
- Railway production is healthy
- public Privacy/Terms/deletion URLs are live
- the GitHub **Play release** workflow exists on `main`
- ordinary passwordless mobile authentication and reviewer password authentication are implemented
- Play Billing/restore/backend verification/RTDN are implemented fail-closed
- Play app-content/listing drafts are committed

At that point the remaining work is external account configuration, credentials, first Play package bootstrap, listing assets, tester enrollment, and Google's review/testing clock—not application code.
