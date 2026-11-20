import Capacitor
import Foundation
import GoogleSignIn
import UIKit

/// MunchGoogleSignIn — native Google sign-in for the packaged iOS
/// app, the iOS counterpart of Android's MunchGoogleSignIn plugin
/// (Credential Manager) and the Google sibling of
/// MunchAppleSignInPlugin.
///
/// The contract mirrors Android's plugin as the shared runtime sees
/// it: mobile/runtime.js hands over the client identifiers that
/// GET /mobile/auth/google-config reports for the iOS platform, plus
/// the runtime-generated nonce, and this plugin returns the Google
/// ID token. The runtime then completes sign-in with the same
/// POST /api/auth/sign-in/social `idToken` body every native flow
/// uses, so this plugin's whole job is: configure GIDSignIn, run the
/// interactive flow, hand back the token. No authorization code is
/// returned or exchanged here.
///
/// Identifiers: `clientId` is the iOS OAuth client (Google verifies
/// the app's bundle ID against it before returning a token);
/// `serverClientId` is the web OAuth client, which the SDK needs to
/// mint server-audience ID tokens. The server accepts both audiences
/// (src/auth/social-sign-in.ts `googleProviderClientIds` lists the
/// web, Android, and iOS clients), so no token translation happens
/// here. The nonce rides into the SDK's sign-in call and comes back
/// as the token's `nonce` claim, which the server verifier checks
/// against the raw nonce the runtime sends in the idToken body.
///
/// The OAuth redirect returns on the reversed-client-ID URL scheme
/// declared in Info.plist; AppDelegate and SceneDelegate both give
/// `GIDSignIn.sharedInstance.handle` first claim on incoming URLs.
@objc(MunchGoogleSignInPlugin)
public class MunchGoogleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MunchGoogleSignInPlugin"
    public let jsName = "MunchGoogleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
    ]

    @objc func signIn(_ call: CAPPluginCall) {
        guard let clientId = call.getString("clientId"),
              !clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let serverClientId = call.getString("serverClientId"),
              !serverClientId.trimmingCharacters(
                  in: .whitespacesAndNewlines
              ).isEmpty,
              let nonce = call.getString("nonce"),
              !nonce.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            call.reject("Google sign-in is not configured")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let presenting = self?.bridge?.viewController else {
                call.reject(
                    "Google sign-in was cancelled or could not be completed"
                )
                return
            }
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(
                clientID: clientId,
                serverClientID: serverClientId
            )
            GIDSignIn.sharedInstance.signIn(
                withPresenting: presenting,
                hint: nil,
                additionalScopes: nil,
                nonce: nonce
            ) { result, error in
                if error != nil {
                    // Cancellation and every other failure surface
                    // with the same shape as the Apple plugin's
                    // failure message; the login page prints it
                    // verbatim.
                    call.reject(
                        "Google sign-in was cancelled or could not be completed"
                    )
                    return
                }
                guard let idToken = result?.user.idToken?.tokenString,
                      !idToken.isEmpty else {
                    call.reject("Google did not return an ID token")
                    return
                }
                call.resolve(["idToken": idToken])
            }
        }
    }
}
