import Capacitor
import Foundation
import Security

/// MunchSecureSession — iOS counterpart of
/// mobile/android/MunchSecureSessionPlugin.java.
///
/// Same JS bridge surface as Android (plugin name "MunchSecureSession",
/// called through mobile/runtime.js): getToken() -> { token },
/// setToken({ token }), clearToken(), getPendingAuth() -> { value },
/// setPendingAuth({ value }), clearPendingAuth(). The shared runtime
/// treats a missing plugin as signed-out, so until this plugin shipped,
/// iOS had no native persistent session store and every relaunch of the
/// packaged app looked signed out.
///
/// Storage is the iOS Keychain — the platform counterpart of Android's
/// Keystore-encrypted SharedPreferences: items are OS-encrypted at rest
/// and bound to this device (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
/// — usable after the first unlock following a reboot, which is when a
/// cold app launch restores its session, and never synced to iCloud or
/// migrated to another device).
///
/// Semantics mirror the Android plugin exactly:
/// - Reads resolve with an EMPTY STRING when nothing is stored (never
///   null), so the runtime's `|| ""` handling behaves identically.
/// - A stored value that cannot be read back is deleted and the call
///   rejects, matching Android's delete-on-decrypt-failure behaviour —
///   the user signs in again rather than the app trusting damaged state.
/// - Writes reject blank values and values over the same ceilings as
///   Android (session token 16,384 chars; pending auth 4,096 chars).
@objc(MunchSecureSessionPlugin)
public class MunchSecureSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MunchSecureSessionPlugin"
    public let jsName = "MunchSecureSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPendingAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearPendingAuth", returnType: CAPPluginReturnPromise),
    ]

    private static let service = "business.munch.app.secure-session"
    private static let tokenAccount = "session-token"
    private static let pendingAuthAccount = "pending-auth"
    private static let tokenLimit = 16384
    private static let pendingAuthLimit = 4096

    @objc func getToken(_ call: CAPPluginCall) {
        readValue(account: Self.tokenAccount, call: call, resultKey: "token") {
            "Unable to read the installed Munch session"
        }
    }

    @objc func setToken(_ call: CAPPluginCall) {
        writeValue(
            account: Self.tokenAccount,
            value: call.getString("token"),
            limit: Self.tokenLimit,
            call: call,
            invalidMessage: "A valid Munch session token is required",
            storeMessage: "Unable to store the installed Munch session"
        )
    }

    @objc func clearToken(_ call: CAPPluginCall) {
        deleteValue(account: Self.tokenAccount)
        call.resolve()
    }

    @objc func getPendingAuth(_ call: CAPPluginCall) {
        readValue(account: Self.pendingAuthAccount, call: call, resultKey: "value") {
            "Unable to read the pending Munch sign-in"
        }
    }

    @objc func setPendingAuth(_ call: CAPPluginCall) {
        writeValue(
            account: Self.pendingAuthAccount,
            value: call.getString("value"),
            limit: Self.pendingAuthLimit,
            call: call,
            invalidMessage: "A valid pending Munch sign-in is required",
            storeMessage: "Unable to store the pending Munch sign-in"
        )
    }

    @objc func clearPendingAuth(_ call: CAPPluginCall) {
        deleteValue(account: Self.pendingAuthAccount)
        call.resolve()
    }

    // MARK: - Keychain plumbing

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
        ]
    }

    private func readValue(
        account: String,
        call: CAPPluginCall,
        resultKey: String,
        unreadableMessage: () -> String
    ) {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            if let data = item as? Data,
               let value = String(data: data, encoding: .utf8) {
                call.resolve([resultKey: value])
            } else {
                deleteValue(account: account)
                call.reject(unreadableMessage())
            }
        case errSecItemNotFound:
            call.resolve([resultKey: ""])
        default:
            deleteValue(account: account)
            call.reject(unreadableMessage())
        }
    }

    private func writeValue(
        account: String,
        value: String?,
        limit: Int,
        call: CAPPluginCall,
        invalidMessage: String,
        storeMessage: String
    ) {
        guard let value,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.utf8.count <= limit else {
            call.reject(invalidMessage)
            return
        }
        let data = Data(value.utf8)
        let query = baseQuery(account: account)
        let updateStatus = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess {
            call.resolve()
            return
        }
        if updateStatus == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] =
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            if SecItemAdd(insert as CFDictionary, nil) == errSecSuccess {
                call.resolve()
                return
            }
        }
        call.reject(storeMessage)
    }

    private func deleteValue(account: String) {
        SecItemDelete(baseQuery(account: account) as CFDictionary)
    }
}
