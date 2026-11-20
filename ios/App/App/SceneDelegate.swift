import UIKit
import Capacitor
import GoogleSignIn

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // MunchBridgeViewController registers the first-party plugins
        // (MunchSecureSession, MunchAppleSignIn) with the bridge; a
        // plain CAPBridgeViewController would never discover them.
        window?.rootViewController = MunchBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // Google Sign-In's OAuth redirect returns on the
        // reversed-client-ID scheme declared in Info.plist; GIDSignIn
        // gets first claim on each URL, and only the URLs it does not
        // handle continue to the Capacitor scene proxy.
        let unhandled = URLContexts.filter {
            !GIDSignIn.sharedInstance.handle($0.url)
        }
        if !unhandled.isEmpty {
            SceneDelegateProxy.shared.scene(
                scene,
                openURLContexts: Set(unhandled)
            )
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
