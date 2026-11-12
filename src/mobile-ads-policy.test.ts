import { describe, expect, test } from "bun:test";
import {
    shouldRenderTodayAdSlot,
    shouldShowAndroidBanner,
} from "../public/ads-policy.js";

describe("Android banner placement", () => {
    const eligible = {
        route: "today",
        pathname: "/app",
        dialogOpen: false,
        adFree: false,
        adsEnabled: true,
    };

    test("shows only on Today (home) for a server-confirmed free account with the remote flag on", () => {
        expect(shouldShowAndroidBanner(eligible)).toBe(true);
        // The packaged bundle boots at its root before navigation
        // rewrites the path to /app; route is already "today" there.
        expect(shouldShowAndroidBanner({ ...eligible, pathname: "/" })).toBe(
            true,
        );
    });

    test("hides for an ad-free account or unknown entitlement state", () => {
        expect(shouldShowAndroidBanner({ ...eligible, adFree: true })).toBe(
            false,
        );
        expect(
            shouldShowAndroidBanner({ ...eligible, adFree: undefined }),
        ).toBe(false);
    });

    test("hides on every other surface and while a dialog is open", () => {
        // Amendment D final placement law: exactly ONE slot app-wide —
        // Today under Next up. The retired More-screen
        // placement and every browse/logging surface stay ad-free.
        expect(shouldShowAndroidBanner({ ...eligible, route: "more" })).toBe(
            false,
        );
        expect(
            shouldShowAndroidBanner({ ...eligible, pathname: "/app/more" }),
        ).toBe(false);
        expect(shouldShowAndroidBanner({ ...eligible, route: "log" })).toBe(
            false,
        );
        expect(shouldShowAndroidBanner({ ...eligible, dialogOpen: true })).toBe(
            false,
        );
    });

    test("ADS-FOUNDATION: the remote flag defaults OFF and fails closed", () => {
        // Flag explicitly off (the shipped default: MUNCH_ADS_ENABLED
        // unset on the server) — no banner even for an eligible account.
        expect(
            shouldShowAndroidBanner({ ...eligible, adsEnabled: false }),
        ).toBe(false);
        // Flag missing entirely (a bootstrap that predates ADS-FOUNDATION,
        // or a failed bootstrap) — still no banner.
        const { adsEnabled: _omitted, ...withoutFlag } = eligible;
        expect(shouldShowAndroidBanner(withoutFlag)).toBe(false);
        expect(
            shouldShowAndroidBanner({ ...eligible, adsEnabled: undefined }),
        ).toBe(false);
    });
});

describe("Today in-flow ad slot", () => {
    const eligible = {
        route: "today",
        adsEnabled: true,
        adFree: false,
        nativeAdsAvailable: true,
    };

    test("renders the reserve only for a flagged-on free packaged account on Today", () => {
        expect(shouldRenderTodayAdSlot(eligible)).toBe(true);
    });

    test("renders nothing while the flag is off, for Premium, on the website, or off Today", () => {
        expect(
            shouldRenderTodayAdSlot({ ...eligible, adsEnabled: false }),
        ).toBe(false);
        expect(
            shouldRenderTodayAdSlot({ ...eligible, adsEnabled: undefined }),
        ).toBe(false);
        expect(shouldRenderTodayAdSlot({ ...eligible, adFree: true })).toBe(
            false,
        );
        expect(
            shouldRenderTodayAdSlot({
                ...eligible,
                nativeAdsAvailable: false,
            }),
        ).toBe(false);
        expect(shouldRenderTodayAdSlot({ ...eligible, route: "log" })).toBe(
            false,
        );
    });
});

describe("Android ad request privacy (Michael's Nov 11 ruling)", () => {
    test("the native plugin requests non-personalized ads only", async () => {
        // Non-personalized ads are Munch's public promise: AdMob
        // serves contextual ads and never builds the request on the
        // device's advertising/interest profile. The plugin source
        // is the canonical copy (configure-mobile-android.ts syncs
        // it into android/ at build time).
        const source = await Bun.file(
            new URL("../mobile/android/MunchAdsPlugin.java", import.meta.url),
        ).text();
        expect(source).toContain('putString("npa", "1")');
        expect(source).toContain("addNetworkExtrasBundle(AdMobAdapter.class");
        expect(source).not.toContain("loadAd(new AdRequest.Builder().build())");
    });
});

async function readRepoFile(relativePath: string): Promise<string> {
    return Bun.file(new URL(`../${relativePath}`, import.meta.url)).text();
}

describe("iOS ads plugin — bridge parity with Android", () => {
    test("the Swift plugin exposes the same MunchAds bridge surface", async () => {
        const source = await readRepoFile("mobile/ios/MunchAdsPlugin.swift");
        expect(source).toContain("@objc(MunchAdsPlugin)");
        expect(source).toContain("CAPPlugin, CAPBridgedPlugin");
        expect(source).toContain('public let jsName = "MunchAds"');
        expect(source).toContain('CAPPluginMethod(name: "setBannerVisible"');
        expect(source).toContain('CAPPluginMethod(name: "showPrivacyOptions"');
        // Same fail-closed argument defaults as the Java plugin.
        expect(source).toContain('call.getBool("visible", false)');
        expect(source).toContain('call.getBool("adFree", true)');
        expect(source).toContain('call.getBool("adsEnabled", false)');
        expect(source).toContain("ad_privacy_options_unavailable");
    });

    test("the committed ios/ copy is the canonical mobile/ios/ source", async () => {
        const canonical = await readRepoFile("mobile/ios/MunchAdsPlugin.swift");
        const committed = await readRepoFile(
            "ios/App/App/MunchAdsPlugin.swift",
        );
        expect(committed).toBe(canonical);
    });
});

describe("iOS ad request privacy (Michael's Nov 11 ruling)", () => {
    test("every iOS ad request carries the non-personalized extra", async () => {
        const source = await readRepoFile("mobile/ios/MunchAdsPlugin.swift");
        expect(source).toContain('extras.additionalParameters = ["npa": "1"]');
        expect(source).toContain("request.register(extras)");
        expect(source).toContain("bannerView?.load(request)");
        // No bare request may ever reach the banner view.
        expect(source).not.toContain(".load(Request())");
    });

    test("UMP consent and the ATT prompt both precede any ad load", async () => {
        const source = await readRepoFile("mobile/ios/MunchAdsPlugin.swift");
        expect(source).toContain("requestConsentInfoUpdate");
        expect(source).toContain("loadAndPresentIfRequired");
        expect(source).toContain("ConsentInformation.shared.canRequestAds");
        expect(source).toContain(
            "ATTrackingManager.requestTrackingAuthorization",
        );
        expect(source).toContain("MobileAds.shared.start");
        // Order guard: consent machinery and the ATT request are wired
        // ahead of SDK initialization in the source flow.
        expect(source.indexOf("requestConsentInfoUpdate")).toBeLessThan(
            source.indexOf("MobileAds.shared.start"),
        );
        expect(source.indexOf("requestTrackingAuthorization")).toBeLessThan(
            source.indexOf("MobileAds.shared.start"),
        );
    });
});

describe("iOS ad units — test in non-store builds, real only behind the flag in store builds", () => {
    test("unit selection keys off the App Store receipt", async () => {
        const source = await readRepoFile("mobile/ios/MunchAdsPlugin.swift");
        // Real unit (munch_ios_home_banner) — declared exactly once and
        // selected only for a production receipt.
        expect(
            source.split("ca-app-pub-2708638041809482/7154253550"),
        ).toHaveLength(2);
        expect(source).toContain("storeBannerAdUnitID");
        // Google's official iOS test banner unit for dev/TestFlight.
        expect(source).toContain("ca-app-pub-3940256099942544/2934735716");
        expect(source).toContain("testBannerAdUnitID");
        expect(source).toContain("#if DEBUG");
        expect(source).toContain("appStoreReceiptURL");
        expect(source).toContain('"sandboxReceipt"');
        expect(source).toContain("? MunchAdsPlugin.testBannerAdUnitID");
    });

    test("Info.plist carries the real AdMob app ID, the ATT string, and SKAdNetwork items", async () => {
        const plist = await readRepoFile("ios/App/App/Info.plist");
        expect(plist).toContain(
            "<string>ca-app-pub-2708638041809482~8470224712</string>",
        );
        expect(plist).toContain("<key>NSUserTrackingUsageDescription</key>");
        expect(plist).toContain("<key>SKAdNetworkItems</key>");
        expect(plist).toContain("cstr6suwn9.skadnetwork");
        expect(plist.split(".skadnetwork").length - 1).toBeGreaterThanOrEqual(
            50,
        );
    });

    test("the Xcode project links Google Mobile Ads + UMP via SPM and compiles the plugin", async () => {
        const project = await readRepoFile(
            "ios/App/App.xcodeproj/project.pbxproj",
        );
        expect(project).toContain("MunchAdsPlugin.swift");
        expect(project).toContain(
            "https://github.com/googleads/swift-package-manager-google-mobile-ads.git",
        );
        expect(project).toContain(
            "https://github.com/googleads/swift-package-manager-google-user-messaging-platform.git",
        );
        expect(project).toContain("productName = GoogleMobileAds;");
        expect(project).toContain("productName = GoogleUserMessagingPlatform;");
        expect(project).toContain("version = 13.11.0;");
    });

    test("the iOS lanes run the configure step that syncs and verifies the ads wiring", async () => {
        const configure = await readRepoFile("scripts/configure-mobile-ios.ts");
        expect(configure).toContain('"mobile/ios/MunchAdsPlugin.swift"');
        expect(configure).toContain('"ios/App/App/MunchAdsPlugin.swift"');
        const workflow = await readRepoFile(".github/workflows/mobile-ios.yml");
        expect(
            workflow.split("bun scripts/configure-mobile-ios.ts").length - 1,
        ).toBe(3);
    });
});

describe("ADS DEMO override (Michael, 2026-11-12) — test builds only", () => {
    test("the marker is baked into the packaged runtime only under the build-time env flag", async () => {
        const buildScript = await readRepoFile("scripts/build-mobile-web.ts");
        expect(buildScript).toContain(
            'process.env.MUNCH_ADS_DEMO_TEST_BUILD === "1"',
        );
        expect(buildScript).toContain(
            "window.__MUNCH_ADS_DEMO_TEST_BUILD__ = true;",
        );
    });

    test("the web layer forwards the demo state to the native plugins", async () => {
        const app = await readRepoFile("public/app.js");
        expect(app).toContain("window.__MUNCH_ADS_DEMO_TEST_BUILD__");
        expect(app).toContain("demoTestAds: demoTestBuild");
    });

    test("iOS honors the demo only in non-store distributions and only with the test unit", async () => {
        const source = await readRepoFile("mobile/ios/MunchAdsPlugin.swift");
        expect(source).toContain('call.getBool("demoTestAds", false)');
        expect(source).toContain(
            "let demoActive = demoTestAds && isNonStoreDistribution",
        );
        // The demo can never widen unit selection: non-store always
        // resolves to the test unit (see the receipt test above), so a
        // demo build physically cannot request the real unit.
        expect(source).not.toContain("demoActive ? MunchAdsPlugin.store");
    });

    test("Android honors the demo only in debuggable builds and only with the sample unit", async () => {
        const source = await readRepoFile("mobile/android/MunchAdsPlugin.java");
        expect(source).toContain('call.getBoolean("demoTestAds", false)');
        expect(source).toContain(
            "demoActive = demoRequested && isDebuggableBuild()",
        );
        expect(source).toContain("ApplicationInfo.FLAG_DEBUGGABLE");
        expect(source).toContain("ca-app-pub-3940256099942544/9214589741");
    });

    test("both distribution workflows default the demo off and set it only from the dispatch input", async () => {
        const iosWorkflow = await readRepoFile(
            ".github/workflows/mobile-ios.yml",
        );
        expect(iosWorkflow).toContain("ads_demo_test_build:");
        expect(iosWorkflow).toContain(
            "MUNCH_ADS_DEMO_TEST_BUILD: ${{ inputs.ads_demo_test_build && '1' || '' }}",
        );
        const androidWorkflow = await readRepoFile(
            ".github/workflows/mobile-android.yml",
        );
        expect(androidWorkflow).toContain("ads_demo_test_build:");
        expect(androidWorkflow).toContain(
            "MUNCH_ADS_DEMO_TEST_BUILD: ${{ inputs.ads_demo_test_build && '1' || '' }}",
        );
    });
});
