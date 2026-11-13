import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import UIKit

/// MunchAppleSignIn — native Sign in with Apple for the packaged iOS
/// app, the Apple counterpart of Android's MunchGoogleSignIn plugin.
///
/// The server half (IOS-AUTH, src/auth/) dictates this shape: the
/// Better Auth Apple provider verifies ID tokens against BOTH
/// audiences — the Services ID for web tokens and the app bundle ID
/// (`business.munch.app`) for native ones — and the packaged app
/// completes sign-in with the same POST /api/auth/sign-in/social
/// `idToken` body the Google flow uses. So this plugin's whole job is:
/// run ASAuthorization, hand the resulting ID token to
/// mobile/runtime.js, and let the shared runtime establish the session
/// (set-auth-token header -> MunchSecureSession). No authorization
/// code is returned or exchanged here.
///
/// Nonce handling mirrors the server verifier: the runtime generates
/// the raw nonce and sends it in the `idToken` body; this plugin puts
/// the SHA-256 hex of that nonce on the authorization request (Apple
/// copies the request nonce verbatim into the ID token's `nonce`
/// claim). Better Auth's Apple verifier accepts the claim when it
/// equals the raw nonce OR its SHA-256 hex, so the raw nonce itself
/// never has to appear in the authorization request.
///
/// Scopes: email + fullName are requested so a first sign-in can carry
/// the user's name and email to Apple. Apple returns them on the
/// credential only — never inside the ID token — and only on the very
/// first authorization; the server derives the account identity from
/// the verified token, and Amendment I governs everything after that
/// (linking happens from Settings, never silently here).
@objc(MunchAppleSignInPlugin)
public class MunchAppleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MunchAppleSignInPlugin"
    public let jsName = "MunchAppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
    ]

    private var pendingCall: CAPPluginCall?
    private var authorizationController: ASAuthorizationController?

    @objc func signIn(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"),
              !nonce.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("A sign-in nonce is required")
            return
        }
        if pendingCall != nil {
            call.reject("Sign in with Apple is already in progress")
            return
        }
        pendingCall = call

        let hashedNonce = SHA256.hash(data: Data(nonce.utf8))
            .map { String(format: "%02x", $0) }
            .joined()

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            request.nonce = hashedNonce
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.authorizationController = controller
            controller.performRequests()
        }
    }

    private func finish(with result: (CAPPluginCall) -> Void) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        authorizationController = nil
        result(call)
    }
}

extension MunchAppleSignInPlugin: ASAuthorizationControllerDelegate {
    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let credential = authorization.credential
                as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let idToken = String(data: tokenData, encoding: .utf8),
              !idToken.isEmpty else {
            finish { $0.reject("Apple did not return an ID token") }
            return
        }
        finish { $0.resolve(["idToken": idToken]) }
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        // Cancellation and every other failure surface with the same
        // shape as the Android Google plugin's failure message; the
        // login page prints it verbatim.
        finish {
            $0.reject("Sign in with Apple was cancelled or could not be completed")
        }
    }
}

extension MunchAppleSignInPlugin: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(
        for controller: ASAuthorizationController
    ) -> ASPresentationAnchor {
        if let window = bridge?.viewController?.view.window {
            return window
        }
        let keyWindow = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
        return keyWindow ?? ASPresentationAnchor()
    }
}
