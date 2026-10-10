# Android sign-in setup

The Android app uses the existing Munch Better Auth user database. It supports
passwordless email magic links and native Sign in with Google. It does not use
Firebase Authentication as a second identity store.

## Email magic links

The backend already sends scanner-safe Better Auth magic links through Resend.
The Android app requests a link for the user's email. After the user confirms it
in the email flow, the browser redirects to the app with a short-lived,
single-use handoff code through a verified Android App Link. The app exchanges
that code with a PKCE verifier stored under Android Keystore encryption, then
stores the resulting Munch session in Android Keystore. The long-lived session
token is never placed in the deep-link URL.

## Google Sign-In

Use the existing Firebase Google Cloud project `munch-android-bf1cd` and create
the following OAuth clients in the same project:

1. A **Web application** OAuth client. Munch uses its client ID as the ID-token
   audience and its client secret only on the backend.
2. An **Android** OAuth client for package `business.munch.app` and the SHA-1
   fingerprint of the key that signs the Android APK.

Set these Railway service variables on the Munch API:

| Variable                                     | Value                                                    |
| -------------------------------------------- | -------------------------------------------------------- |
| `MUNCH_GOOGLE_WEB_CLIENT_ID`                 | Web application client ID                                |
| `MUNCH_GOOGLE_CLIENT_SECRET`                 | Web application client secret                            |
| `MUNCH_GOOGLE_ANDROID_CLIENT_ID`             | Android client ID                                        |
| `MUNCH_ANDROID_APP_LINK_SHA256_FINGERPRINTS` | Comma-separated SHA-256 signing certificate fingerprints |

The Android app uses Credential Manager to obtain a Google ID token and sends
it to Better Auth, which validates it on Munch's backend. Google accounts with
verified email addresses can link to an existing Munch account with the same
email. The user's Google password never reaches Munch. The app does not persist
the Google ID token locally; it stores the Munch session in Android Keystore.
Better Auth stores the linked Google provider identity in the Munch account
record, whose schema also has optional provider-token fields.

The app link association endpoint is `https://munch.business/.well-known/assetlinks.json`.
It returns the Android statement only after the signing SHA-256 fingerprint
variable is configured. Android will keep opening the link in the browser until
the package name and signing fingerprint match the installed app.

### Signing fingerprint requirement

The current Firebase App Distribution workflow builds `assembleDebug` on a
fresh GitHub-hosted runner. Its default debug signing key is not a stable
release identity. Before testing sign-in from Firebase App Distribution,
configure one stable distribution signing key for CI. Add its SHA-1 fingerprint
as an Android OAuth client and its SHA-256 fingerprint to
`MUNCH_ANDROID_APP_LINK_SHA256_FINGERPRINTS`. Add the Play App Signing
fingerprints separately when Play Console is configured.

The service-account JSON used by Firebase App Distribution is not an OAuth
client secret and is not used for Munch user sign-in.

## Password storage scope

The Android login screen no longer asks for a Munch password. Existing website
email/username password sign-in remains enabled for compatibility. Better Auth
stores password hashes (scrypt), not clear-text passwords. Disabling website
password sign-in or removing existing credential hashes is a separate account
migration.
