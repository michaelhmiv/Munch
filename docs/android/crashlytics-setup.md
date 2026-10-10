# Android Crashlytics setup

Munch's Firebase project is `munch-android-bf1cd`, with the Android app registered as `business.munch.app`.

## Configuration

Download the Android configuration file for the registered Munch Android app from Firebase Console and add it at `android/app/google-services.json`. Firebase documents this client config and its Firebase API key as public by design, so it can be checked into the app repository. Keep its API restrictions limited to Firebase services. Never commit service-account private keys, Gemini Developer API keys, or backend credentials. Do not add Firebase user identifiers or nutrition data to crash reports.

GitHub Actions uses the real configuration file when present. Until it is added, CI uses the clearly fake test fixture solely to verify the Firebase Gradle integration compiles; the debug artifact built with that fixture cannot report to Munch's Firebase project.

Gradle enables Google Services and Crashlytics when a valid app configuration is present. Release builds fail early without the local config file so Munch cannot ship a release that silently omits the approved crash reporting.

## Data and verification

Crashlytics is included without Firebase Analytics. The SDK reports crashes and related app/device diagnostics to Firebase. Munch does not set a Crashlytics user ID or attach meal, nutrition, or account data.

After the real configuration is available, build and install an internal-test build, then verify a test crash appears in the Crashlytics dashboard. Use a test-only crash trigger or a disposable QA build; do not leave a crash trigger in the production UI. CI unit tests do not launch the app or send crash events.

## References

- [Set up Firebase Crashlytics for Android](https://firebase.google.com/docs/crashlytics/android/get-started)
- [Add Firebase to an Android project](https://firebase.google.com/docs/android/setup)
