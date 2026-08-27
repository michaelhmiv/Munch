# Munch Google Play release runbook

This runbook is the canonical Google Play setup for the Android app. It separates code-owned configuration from console-owned credentials so future Android features can ship without changing billing, authentication, or signing architecture.

For the shortest operator checklist, use [`HANDOFF.md`](./HANDOFF.md). The other files in this directory are working sources for Play Console declarations and metadata.

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

`mobile/release.json` is the user-visible mobile release source of truth. The manual Play release workflow derives a unique, monotonically increasing Play `versionCode` from the GitHub workflow run number, so internal/closed release retries do not require source edits. `versionName` is intentionally shared with the future iOS target.

## Developer account checkpoint

Google offers Personal and Organization developer accounts. Its account-type guidance says developers providing Health apps such as Medical apps and Human Subjects Research apps should use an Organization account, while its separate Health categories include general consumer Health & Fitness products such as Nutrition and Weight Management.

Munch is a consumer Nutrition and Weight Management app, not a Medical app or Human Subjects Research app. Use the existing Play developer account if Play Console accepts this Health declaration/account combination. Do not create a second Munch package solely for account-type experimentation.

If Play Console explicitly requires Organization verification for Munch, use Google's current personal-to-organization transition and complete the required organization payments profile / D-U-N-S verification before review. This is an account-verification task and does not require any Munch code or package-ID change.

If the existing Personal account was created after November 13, 2023 and is subject to Google's production-access testing rule, run the required closed test (currently at least 12 continuously opted-in testers for 14 days) before applying for production access.

## Create the Play app

1. In Play Console create a new app named **Munch**.
2. Default language: English (United States).
3. Select app (not game) and Free. Munch Premium is an in-app subscription; the Play app itself remains free to install.
4. Use package `business.munch.app` when the first AAB establishes the application identity.
5. Add `support@munch.business` as the store contact email and `https://munch.business` as the website.
6. Accept Play App Signing. Google holds the app-signing key; Munch CI uses a separate upload key.
7. Do not create a second package for internal/closed testing. All tracks share the package/signing lineage.

### First AAB bootstrap

The pinned GitHub Play-upload action requires the package to already exist in Play Console and documents that the first APK/AAB should be uploaded through Play Console manually. Therefore the first release has one deliberate bootstrap step:

1. Configure the real upload-key GitHub secrets.
2. Run **Play release** with `destination=build-only`.
3. Download the signed AAB artifact from that workflow.
4. Create the first Play internal-test release manually with that AAB.
5. After Play knows package `business.munch.app`, future internal/closed/production uploads can use the GitHub workflow directly.

This is the only artifact-upload step that should require a manual file handoff.

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

The repository ignores `*.jks` and `*.keystore`. Ordinary PR CI uses a disposable test key to prove that `bundleRelease` and signature verification work without production credentials.

Back up the real Munch upload key and passwords in the developer's secure credential manager. Do not rely on a GitHub secret as the only copy.

## Play Developer API service account for subscriptions

Munch's backend verifies Google Play subscriptions server-side. Create a Google Cloud project, enable the **Google Play Android Developer API**, create a server-to-server service account, then grant that identity access to Munch in Play Console.

For billing operations, grant the Play permissions currently required for Purchases API / subscription management, including:

- view financial data, orders, and cancellation responses (or the current app-level equivalent that grants Purchases API access)
- manage orders and subscriptions

Use least privilege and scope the account to Munch where Play Console permits it.

Download the runtime billing service-account JSON once and set it directly as this Railway variable:

- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`

Munch also supports the older split variables `GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY`, but the single JSON variable is the preferred operational path.

The Play-upload service account in GitHub and runtime billing service account in Railway may be the same identity if it has the union of required permissions. Separate identities are preferable for least privilege and independent rotation.

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
4. Create a push subscription pointing to `https://munch.business/webhooks/google-play`.
5. Enable authenticated push with an OIDC token.
6. Set the OIDC audience exactly to `https://munch.business/webhooks/google-play`.
7. Set these Railway variables:
   - `GOOGLE_PLAY_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL=<push-auth service-account email>`
   - `GOOGLE_PLAY_PUBSUB_PUSH_AUDIENCE=https://munch.business/webhooks/google-play`
8. Use Play Console's **Send Test Message** after deployment/configuration.

Munch rejects unauthenticated notifications. For accepted notifications, the RTDN body is treated only as a change signal; Munch re-queries `purchases.subscriptionsv2.get` before changing entitlement.

Android purchase UI remains fail-closed until Developer API credentials **and** authenticated RTDN configuration are both present.

## Authentication and reviewer access

Ordinary Android users can use Munch's normal passwordless account model. The installed sign-in screen requests an email link; the email opens a scanner-safe HTTPS confirmation page, and the explicit **Open Munch** action hands the still-unused one-time token to the installed app. The app redeems it directly with Better Auth and stores the resulting bearer session using Android Keystore.

Password sign-in remains available as a secondary option and gives Play reviewers deterministic access without needing your email inbox. The repository already contains `scripts/provision-reviewer.ts`, which creates a verified, time-bounded Premium reviewer account with representative sample data. Use [`review-access.md`](./review-access.md) for the exact Play App access text.

Never commit reviewer credentials.

## Health apps declaration

Use [`health-declaration.md`](./health-declaration.md). Munch's applicable category is:

- **Health and fitness > Nutrition and Weight Management**

Munch tracks dietary intake, nutrition, meal planning, weight, water, goals, and related consumer wellness records. Munch does not currently request Health Connect permissions and should not declare Health Connect unless that feature is deliberately added later.

The store listing contains the consumer-health disclaimer. Keep the app positioned as consumer wellness; do not make medical diagnosis/treatment or guaranteed outcome claims.

## Data safety and app content

Use these code-reviewed working sources when completing Play Console:

- [`data-safety.md`](./data-safety.md)
- [`health-declaration.md`](./health-declaration.md)
- [`content-rating.md`](./content-rating.md)
- [`review-access.md`](./review-access.md)
- [`listing/en-US.md`](./listing/en-US.md)
- [`assets.md`](./assets.md)

The public account-deletion resource is:

`https://munch.business/delete-account`

The installed app also exposes authenticated deletion from Munch Settings.

Munch's Pantry meal-idea feature uses generative AI. The Android release therefore includes an in-app **Report AI suggestion** control and an authenticated, privacy-scoped report endpoint/storage path to satisfy the applicable AI-generated-content reporting requirement.

## Store listing and assets

Use `mobile/play/listing/en-US.md` for title/short/full description and `mobile/play/release-notes/whatsnew-en-US` for the first release notes.

Visual assets cannot be honestly completed in source alone. Capture them from a real signed internal/closed Munch build using the demo/reviewer account. The exact dimensions/content/hygiene checklist is in [`assets.md`](./assets.md).

## Internal and closed release workflow

The manual **Play release** GitHub Actions workflow supports:

- `build-only` — signs/verifies an AAB and stores it as an artifact; no Play mutation
- `internal` — uploads a new unique-versionCode bundle to Play's internal track
- `closed` — uploads to the supplied closed-testing track (default `alpha`)
- `production` — requires explicit confirmation text `PUBLISH`

Each workflow run derives a fresh Play `versionCode` from its monotonically increasing workflow run number. Re-running a failed internal/closed release therefore does not require editing `mobile/release.json` just to satisfy Play's versionCode uniqueness rule.

Recommended progression:

1. Configure the GitHub signing secrets.
2. Run `build-only` and manually bootstrap the first AAB in Play Console.
3. Configure `PLAY_SERVICE_ACCOUNT_JSON` and validate an automated `internal` upload.
4. Complete required Play declarations/listing/reviewer access.
5. Configure the Railway Google Play runtime/RTDN variables and send an RTDN test message.
6. Test real Play subscription purchase, restore, cancellation/grace/expiry behavior with Play license testers.
7. Run `closed` and add the tester list/group.
8. If your account is subject to the personal-account rule, maintain at least 12 continuously opted-in testers for the required 14 days, then apply for production access.
9. Ship production only from green `main`, after production access is granted, using `production_confirmation=PUBLISH`.

## What must never be committed

- upload keystore or private keys
- keystore passwords
- Google service-account JSON
- Pub/Sub credentials
- purchase tokens
- reviewer passwords
- user bearer/session credentials

The checked-in release configuration contains identifiers, declarations, and policy only; secrets live in GitHub Actions, Railway, Google Cloud, Play Console, and the developer's credential manager.
