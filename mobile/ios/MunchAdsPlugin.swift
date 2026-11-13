import AppTrackingTransparency
import Capacitor
import GoogleMobileAds
import UIKit
import UserMessagingPlatform

/// MunchAds — iOS counterpart of mobile/android/MunchAdsPlugin.java.
///
/// Same JS bridge surface as Android (plugin name "MunchAds", called through
/// mobile/runtime.js): setBannerVisible({visible, adFree, adsEnabled,
/// demoTestAds, slotRect}) and showPrivacyOptions().
/// MUNCH_ADS_ENABLED stays the only product switch (see src/ads-config.ts);
/// this plugin only decides whether a banner may be loaded for the state
/// the web layer forwards.
///
/// Ads are NON-PERSONALIZED ONLY (Michael's ruling, PR #255): every request
/// carries the "npa" = "1" extra, guarded by src/mobile-ads-policy.test.ts.
///
/// Distribution decides the ad unit: DEBUG builds and TestFlight
/// (sandbox) receipts always use Google's official TEST banner unit, so
/// real ads can never serve in TestFlight; only a production App Store
/// receipt selects the real munch_ios_home_banner unit, and even then the
/// server flag (off in production) gates every load.
@objc(MunchAdsPlugin)
public class MunchAdsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MunchAdsPlugin"
    public let jsName = "MunchAds"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setBannerVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showPrivacyOptions", returnType: CAPPluginReturnPromise),
    ]

    /// Real unit (munch_ios_home_banner) — store distribution only.
    private static let storeBannerAdUnitID = "ca-app-pub-2708638041809482/7154253550"
    /// Google's official iOS test banner unit — dev and TestFlight builds.
    private static let testBannerAdUnitID = "ca-app-pub-3940256099942544/2934735716"

    private var bannerView: BannerView?
    /// In-flow slot geometry (Amendment D placement law): the web layer
    /// measures the Today slot's viewport rect in CSS pixels — points,
    /// in WKWebView terms — and forwards it as slotRect with every
    /// placement sync. The banner is glued to exactly that rect; it is
    /// never bottom-anchored. Until the first rect arrives the banner
    /// is held back entirely.
    private var slotRect: CGRect?
    private var bannerRequested = false
    private var consentRefreshComplete = false
    private var consentFormActive = false
    private var adsInitialized = false

    /// TestFlight installs carry a sandbox receipt; App Store installs
    /// carry a production receipt ("receipt"). DEBUG covers dev/simulator.
    private var isNonStoreDistribution: Bool {
        #if DEBUG
            return true
        #else
            guard let receiptURL = Bundle.main.appStoreReceiptURL else {
                return false
            }
            return receiptURL.lastPathComponent == "sandboxReceipt"
        #endif
    }

    private var bannerAdUnitID: String {
        return isNonStoreDistribution
            ? MunchAdsPlugin.testBannerAdUnitID
            : MunchAdsPlugin.storeBannerAdUnitID
    }

    override public func load() {
        // Start the UMP consent refresh immediately, mirroring Android's
        // plugin load(). No ad loads until a banner is actually requested.
        let parameters = RequestParameters()
        ConsentInformation.shared.requestConsentInfoUpdate(with: parameters) {
            [weak self] error in
            guard let self = self else { return }
            self.consentRefreshComplete = true
            guard self.bannerRequested else { return }
            if error == nil {
                DispatchQueue.main.async { self.showConsentThenBanner() }
            } else if ConsentInformation.shared.canRequestAds {
                self.requestTrackingThenInitialize()
            }
        }
    }

    @objc func setBannerVisible(_ call: CAPPluginCall) {
        let visible = call.getBool("visible", false)
        // Fail closed when entitlement state is absent, exactly as Android.
        let adFree = call.getBool("adFree", true)
        let adsEnabled = call.getBool("adsEnabled", false)
        let demoTestAds = call.getBool("demoTestAds", false)
        // The slot rect rides the same call. A rect-less sync never
        // clears a known rect — the web layer syncs once before
        // Today's DOM exists — but a fresh rect repositions a live
        // banner immediately (see layoutBanner).
        let rectObject = call.getObject("slotRect")
        if let rectObject = rectObject,
            let x = (rectObject["x"] as? NSNumber)?.doubleValue,
            let y = (rectObject["y"] as? NSNumber)?.doubleValue,
            let width = (rectObject["width"] as? NSNumber)?.doubleValue,
            let height = (rectObject["height"] as? NSNumber)?.doubleValue
        {
            slotRect = CGRect(x: x, y: y, width: width, height: height)
        }
        // Demo override (Michael, 2026-11-12): a test build may show the
        // TEST banner even for a Premium (adFree) account so he can judge
        // the slot. Honored only in non-store distributions — a production
        // App Store receipt closes this gate even if a marked bundle were
        // ever promoted to the store, and the unit stays the test unit.
        let demoActive = demoTestAds && isNonStoreDistribution
        bannerRequested = visible && (demoActive || (adsEnabled && !adFree))
        if !bannerRequested {
            DispatchQueue.main.async { self.hideBanner() }
            call.resolve()
            return
        }
        call.resolve()
        if bannerView != nil {
            DispatchQueue.main.async { self.layoutBanner() }
        }
        if consentRefreshComplete {
            DispatchQueue.main.async { self.showConsentThenBanner() }
        }
    }

    @objc func showPrivacyOptions(_ call: CAPPluginCall) {
        guard ConsentInformation.shared.privacyOptionsRequirementStatus == .required,
            let viewController = bridge?.viewController
        else {
            call.reject("ad_privacy_options_unavailable")
            return
        }
        DispatchQueue.main.async {
            // UMP 3.x: the privacy options form is presented by ConsentForm
            // (it was an instance method on ConsentInformation in 2.x).
            ConsentForm.presentPrivacyOptionsForm(from: viewController) {
                [weak self] error in
                guard let self = self else {
                    call.resolve(["available": error == nil])
                    return
                }
                if self.bannerRequested && ConsentInformation.shared.canRequestAds {
                    self.requestTrackingThenInitialize()
                } else if self.bannerRequested {
                    DispatchQueue.main.async { self.hideBanner() }
                }
                call.resolve(["available": error == nil])
            }
        }
    }

    /// UMP form first (when required), then — before any ad load — the
    /// AppTrackingTransparency prompt. Order matches Google's own
    /// consent-manager guidance: gather UMP consent, then ATT, then ads.
    private func showConsentThenBanner() {
        guard bannerRequested, !consentFormActive,
            let viewController = bridge?.viewController
        else { return }
        consentFormActive = true
        ConsentForm.loadAndPresentIfRequired(from: viewController) { [weak self] _ in
            guard let self = self else { return }
            self.consentFormActive = false
            guard self.bannerRequested else { return }
            if ConsentInformation.shared.canRequestAds {
                self.requestTrackingThenInitialize()
            } else {
                DispatchQueue.main.async { self.hideBanner() }
            }
        }
    }

    private func requestTrackingThenInitialize() {
        DispatchQueue.main.async {
            if ATTrackingManager.trackingAuthorizationStatus == .notDetermined {
                ATTrackingManager.requestTrackingAuthorization { [weak self] _ in
                    DispatchQueue.main.async { self?.initializeAndLoadBanner() }
                }
            } else {
                self.initializeAndLoadBanner()
            }
        }
    }

    private func initializeAndLoadBanner() {
        DispatchQueue.main.async {
            guard self.bannerRequested, ConsentInformation.shared.canRequestAds else {
                self.hideBanner()
                return
            }
            if self.adsInitialized {
                self.loadBannerView()
                return
            }
            self.adsInitialized = true
            MobileAds.shared.start { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self = self, self.bannerRequested,
                        ConsentInformation.shared.canRequestAds
                    else { return }
                    self.loadBannerView()
                }
            }
        }
    }

    /// Must run on the main queue.
    private func loadBannerView() {
        guard let viewController = bridge?.viewController,
            bridge?.webView != nil
        else { return }
        // No slot rect yet: the banner is created only once its
        // in-flow home is known — never at a guessed position. A later
        // sync carrying the rect re-enters through setBannerVisible.
        guard slotRect != nil else {
            bannerView?.isHidden = true
            return
        }
        if bannerView == nil {
            let banner = BannerView(adSize: AdSizeBanner)
            banner.adUnitID = bannerAdUnitID
            banner.rootViewController = viewController
            banner.backgroundColor = .white
            bannerView = banner
            viewController.view.addSubview(banner)
        }
        layoutBanner()
        // Non-personalized ONLY: the "npa" = "1" extra rides every request,
        // the iOS form of Android's AdMobAdapter network extra (PR #255).
        let request = Request()
        let extras = Extras()
        extras.additionalParameters = ["npa": "1"]
        request.register(extras)
        bannerView?.load(request)
    }

    /// Glues the banner to the web layer's slot rect: the fixed-size
    /// banner centers inside the slot, offset by the WebView's own
    /// origin in the host view. The banner shows only while the slot
    /// is FULLY inside the WebView viewport — a partially scrolled
    /// slot hides it rather than letting it paint over app chrome
    /// (above all the bottom navigation).
    private func layoutBanner() {
        guard let bannerView = bannerView,
            let webView = bridge?.webView
        else { return }
        guard let rect = slotRect else {
            bannerView.isHidden = true
            return
        }
        let size = AdSizeBanner.size
        bannerView.frame = CGRect(
            x: webView.frame.minX + rect.minX
                + max(0, (rect.width - size.width) / 2),
            y: webView.frame.minY + rect.minY
                + max(0, (rect.height - size.height) / 2),
            width: size.width,
            height: size.height
        )
        let slotFullyVisible =
            rect.minX >= 0 && rect.minY >= 0
            && rect.maxX <= webView.bounds.width
            && rect.maxY <= webView.bounds.height
        bannerView.isHidden = !slotFullyVisible
    }

    /// Must run on the main queue.
    private func hideBanner() {
        bannerView?.removeFromSuperview()
        bannerView = nil
    }
}
