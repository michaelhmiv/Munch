# Android signing for internal tests

GitHub Actions uses separate PKCS#12 keys for Firebase debug builds and Play upload bundles. Keep both keystores and their passwords out of the repository and chat.

Add these repository secrets in GitHub Actions before enabling stable signing:

- `MUNCH_ANDROID_DEBUG_KEYSTORE_BASE64`: Base64 contents of `munch-internal-debug.p12`.
- `MUNCH_ANDROID_DEBUG_KEYSTORE_PASSWORD`: Password for the internal debug keystore.
- `MUNCH_ANDROID_UPLOAD_KEYSTORE_BASE64`: Base64 contents of `munch-upload.p12`.
- `MUNCH_ANDROID_UPLOAD_KEYSTORE_PASSWORD`: Password for the upload keystore.

The Android workflow uses the internal debug key when both debug secrets are set. Until then it keeps the existing runner-generated debug key. The `Android internal Play bundle` workflow runs only when manually dispatched from `main`; it requires the upload secrets, builds and signs an AAB with Google's test ad IDs, and stores the artifact in GitHub Actions for 30 days. It does not upload to Play Console or publish a track.

The Firebase Android workflow and the Play bundle workflow each set `MUNCH_ANDROID_VERSION_CODE` from that workflow's run number, so new builds within each distribution flow get a newer build code. Local builds use version code `1` when that variable is unset.

After Play App Signing is enabled, use Google's app-signing certificate for Play-installed App Links and OAuth fingerprints. The upload certificate and app-signing certificate serve different purposes.
