# Android Crashlytics setup

Munch's Firebase project display name is `Munch Android` and its project ID is `munch-android-bf1cd`. The Android app is registered as `business.munch.app`.

## Configuration

Firebase's Android setup uses `google-services.json` at the app module root. The Google Services Gradle plugin reads that file and generates values consumed by Firebase SDKs.

Munch keeps the real configuration out of the public repository:

- **Local builds:** Download the Android config from Firebase Console and place it at `android/app/google-services.json`. This path is gitignored.
- **Trusted GitHub Actions builds:** Add a repository Actions secret named `FIREBASE_ANDROID_CONFIG_BASE64` containing a base64 encoding of the complete JSON file. The workflow decodes and validates it on pushes to `main`.
- **Pull request CI:** PR builds use the fake fixture at `android/app/src/test/fixtures/google-services.json`. It verifies Gradle integration but does not connect crash reports to Munch's Firebase project. The production config secret is not passed to PR jobs.

To create the Actions secret, open the repository's **Settings → Secrets and variables → Actions → New repository secret**. Encode the file as one line; on macOS/Linux, `base64 < android/app/google-services.json | tr -d '\\n'` works.

Firebase describes Firebase-provisioned API keys as client identifiers, not secrets, and permits them in app configuration when they are used only for Firebase services. The key is still included in the built Android app and can be extracted by users; putting the JSON in an Actions secret protects it from source control, not from the app binary. Keep the key limited to Firebase APIs. Use separate restricted keys for any other Google APIs. Never put Firebase Admin service-account keys, Gemini Developer API keys, or backend credentials in the Android app.

Release builds fail early without `android/app/google-services.json`, so a release workflow must materialize the real configuration from the Actions secret before running Gradle.

## Crash report data

Crashlytics is included without Firebase Analytics. The SDK reports crashes and related app/device diagnostics to Firebase. Munch does not set a Crashlytics user ID or attach meal, nutrition, or account data.

After using the real configuration, build and install an internal-test app and verify that a test crash appears in the Crashlytics dashboard. Use a test-only crash trigger or a disposable QA build; do not leave a crash trigger in the production UI. CI unit tests do not launch the app or send crash events.

## References

- [Set up Firebase Crashlytics for Android](https://firebase.google.com/docs/crashlytics/android/get-started)
- [Add Firebase to an Android project](https://firebase.google.com/docs/android/setup)
