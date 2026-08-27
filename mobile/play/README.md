# Munch Google Play release runbook

This runbook is the canonical Google Play setup for the Android app. It separates code-owned configuration from console-owned credentials so future Android features can ship without changing the billing or signing architecture.

## Fixed application identity

| Field | Value |
| --- | --- |
| App name | Munch |
| Package / application ID | `business.munch.app` |
| Default language | English (United States), `en-US` |
| Recommended category | Health & Fitness |
| Website | `https://munch.business` |
| Privacy policy | `https://munch.business/privacy` |
| Account deletion resource | `https://munch.business/delete-account` |
| Terms | `https://munch.business/terms` |
| Support email | `support@munch.business` |
| Play subscription product | `munch_premium_monthly` |
| Base plan | `monthly` |
| RTDN push endpoint / audience | `https://munch.business/webhooks/google-play` |

`mobile/release.json` is the mobile version source of truth. Every Play upload must use a new `androidVersionCode`; `versionName` is the user-visible mobile version and is intentionally shared with the future iOS target.

## Account eligibility checkpoint

Munch is a nutrition and weight-management app and therefore falls under Google Play's Health apps policy. Current Play guidance says developers providing Health apps should use an **Organization** developer account, and the Play Console Requirements policy effective September 30, 2026 makes Organization registration mandatory for Health apps.

If the existing developer account is Personal, use Play Console's current personal-to-organization conversion flow before Munch submission:

1. Obtain or confirm the organization's D-U-N-S record.
2. Create and verify an organization Google Payments profile.
3. In Play Console, open **Developer account > About you** and link the verified organization payments profile.
4. Complete the organization details/identity transition.
5. Google currently recommends allowing at least 72 hours after the transition completes before submitting a new app so account details can propagate.

This account transition is independent of Munch code and does not change the package ID.

## Create the Play app

1. Create a new app named **Munch** with package `business.munch.app`.
2. Select app (not game), Free, and Health & Fitness.
3. Complete required developer/app declarations.
4. Enroll in **Play App Signing**. Google should hold the app-signing key; Munch CI uses a separate upload key.
5. Do not create a second package ID for testing. Internal and closed testing use the same package and signing lineage.

## Upload key and GitHub Actions secrets

Create a Munch-specific upload key locally. Do not commit it and do not paste the private key or passwords into chat.

Example creation command:

```bash
keytool -genkeypair -v \
  -keystore munch-upload.jks \
  -alias munch-upload \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

Encode the keystore locally for GitHub Actions:

```bash
base64 < munch-upload.jks | tr -d '\n'
```

Configure these GitHub repository secrets:

- `ANDROID_KEYSTORE_BASE64` — base64-encoded Munch upload keystore
- `ANDROID_KEYSTORE_PASSWORD` — keystore password
- `ANDROID_KEY_ALIAS` — normally `munch-upload`
- `ANDROID_KEY_PASSWORD` — private-key password
- `PLAY_SERVICE_ACCOUNT_JSON` — Google service-account JSON used by GitHub Actions to upload releases

The repository ignores `*.jks` and `*.keystore`. CI also uses a disposable test key on every PR to prove that `bundleRelease` and signature verification work without requiring production secrets.

## Play Developer API service account for subscriptions

Munch's backend verifies Google Play subscriptions server-side. Create a Google Cloud project and enable the **Google Play Android Developer API**. Create a server-to-server service account, then invite that service-account email in Play Console with access to Munch.

For the billing API, Google's current setup guidance requires these Play permissions:

- **View financial data, orders, and cancellation survey responses** / app-level equivalent that grants Purchases API access
- **Manage orders and subscriptions**

Use least privilege and scope access to Munch where Play Console permits it.

Download the service-account JSON once and set it directly as this Railway variable:

- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`

Munch also supports the older split variables `GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY`, but the single JSON variable is the preferred operational path.

The Play-upload service account in GitHub and the runtime billing service account in Railway may be the same identity if it has the union of required permissions, but separate identities are easier to least-privilege and rotate independently.

## Premium subscription

In **Monetize with Play > Products > Subscriptions** create:

- Product ID: `munch_premium_monthly`
- Product name: Munch Premium
- Base plan ID: `monthly`
- Renewal type: Auto-renewing monthly
- Price: set the intended US base price, then review Google's localized prices

The Android app never grants Premium from a device callback alone. The purchase token is sent to Munch, verified through the Android Publisher API, associated with the opaque Munch account ID, persisted server-side, and acknowledged by the backend.

Google Play Premium grants personal Munch Premium features. Discounted household seats remain a Stripe website product and are not purchased through Google Play.

## Real-time developer notifications (RTDN)

Use authenticated Google Cloud Pub/Sub push delivery so cancellations, renewals, grace periods, account holds, pauses, expirations, refunds/voids, and purchases made outside the currently open app are reconciled promptly.

1. Create a Pub/Sub topic for Munch Play billing notifications.
2. Configure that topic in Play Console's real-time developer notifications settings.
3. Create a dedicated Pub/Sub push-auth service account.
4. Create a push subscription pointing to:
   `https://munch.business/webhooks/google-play`
5. Enable authenticated push with an OIDC token.
6. Set the OIDC audience exactly to:
   `https://munch.business/webhooks/google-play`
7. Set these Railway variables:
   - `GOOGLE_PLAY_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL=<push-auth service-account email>`
   - `GOOGLE_PLAY_PUBSUB_PUSH_AUDIENCE=https://munch.business/webhooks/google-play`
8. Use Play Console's **Send Test Message** function after deployment.

Munch rejects unauthenticated notifications. For accepted notifications, the payload is treated only as a change signal; Munch re-queries `purchases.subscriptionsv2.get` before changing entitlement.

Android purchase UI remains fail-closed until Developer API credentials **and** authenticated RTDN configuration are both present.

## Health apps declaration

Complete the Health apps declaration for closed testing and later tracks. Select:

- **Health and fitness > Nutrition and weight management**

Munch tracks dietary intake, nutrition, meal planning, weight, water, goals, and related consumer wellness records. Munch does not currently request Health Connect permissions and should not declare Health Connect access unless that feature is deliberately added later.

The store listing includes the required consumer-health disclaimer and the public Privacy Policy comprehensively describes nutrition/weight data, image processing, providers, billing, export, and deletion.

## Data safety

Use `mobile/play/data-safety.md` as the reviewed working draft. Complete the Play Console form from the actual release behavior and merged manifest/SDK set, not from assumptions. Closed/open/production tracks require the form; internal-only testing is exempt until the app moves beyond internal testing.

The public account-deletion URL for the Data safety form is:

`https://munch.business/delete-account`

The installed app also exposes authenticated account deletion from Munch Settings.

## Store listing and review

Use:

- `mobile/play/listing/en-US.md` for title/short/full description
- `mobile/play/release-notes/en-US.txt` for the first release notes
- `mobile/play/review-access.md` for reviewer-access preparation

Before submission, add Play screenshots and a 512×512 high-resolution icon / 1024×500 feature graphic that match the production UI. Do not use mock functionality in screenshots.

## Internal and closed release workflow

The manual **Play release** GitHub Actions workflow supports:

- `build-only` — builds/signs/verifies an AAB and stores it as an artifact; no Play mutation
- `internal` — uploads to Play's internal track
- `closed` — uploads to the supplied closed-testing track (default `alpha`)
- `production` — requires the explicit confirmation text `PUBLISH`

Recommended progression:

1. Run `build-only` after the real upload-key secrets are configured.
2. Upload to `internal` and verify install/sign-in/billing/device behavior.
3. Upload the same or newer version to `closed`.
4. Add at least 12 testers and keep at least 12 continuously opted in for 14 days if the account is subject to the new-personal-account testing rule.
5. Apply for production access when Play Console unlocks it.
6. Ship production only from a green `main` commit and a new versionCode.

## What must never be committed

- Upload keystore or private keys
- Keystore passwords
- Google service-account JSON
- Pub/Sub credentials
- Purchase tokens
- User bearer/session credentials

The checked-in release configuration contains identifiers and policy only; secrets live in GitHub Actions, Railway, Google Cloud, and Play Console.
