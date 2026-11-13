package business.munch.app;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.ads.mediation.admob.AdMobAdapter;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.MobileAds;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;

@CapacitorPlugin(name = "MunchAds")
public class MunchAdsPlugin extends Plugin {
    // Google's sample banner unit — used only by the ADS DEMO override in
    // debuggable builds, never in a store build.
    private static final String TEST_BANNER_AD_UNIT_ID = "ca-app-pub-3940256099942544/9214589741";

    private ConsentInformation consentInformation;
    private boolean consentRefreshComplete = false;
    private boolean consentFormActive = false;
    private boolean bannerRequested = false;
    private boolean demoActive = false;
    private boolean adsInitialized = false;
    private AdView bannerView;
    // In-flow slot geometry (Amendment D placement law): the web layer
    // measures the Today slot's viewport rect in CSS pixels and forwards
    // it as slotRect with every placement sync. The banner is glued to
    // exactly that rect — it is never bottom-anchored. Until the first
    // rect arrives the banner is held back entirely.
    private boolean slotRectKnown = false;
    private double slotRectX;
    private double slotRectY;
    private double slotRectWidth;
    private double slotRectHeight;

    @Override
    public void load() {
        consentInformation = UserMessagingPlatform.getConsentInformation(getContext());
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            ConsentRequestParameters parameters =
                new ConsentRequestParameters.Builder().build();
            consentInformation.requestConsentInfoUpdate(
                activity,
                parameters,
                () -> {
                    consentRefreshComplete = true;
                    if (bannerRequested) showConsentThenBanner();
                },
                requestError -> {
                    consentRefreshComplete = true;
                    // UMP retains a previous consent decision. If refreshing
                    // fails, only use ads when that stored decision permits it.
                    if (bannerRequested && consentInformation.canRequestAds()) {
                        initializeAndLoadBanner();
                    }
                }
            );
        });
    }

    @PluginMethod
    public void setBannerVisible(PluginCall call) {
        boolean visible = Boolean.TRUE.equals(call.getBoolean("visible", false));
        // Missing entitlement state fails closed: do not request an ad until
        // the signed-in bootstrap explicitly reports adFree=false.
        boolean adFree = Boolean.TRUE.equals(call.getBoolean("adFree", true));
        // ADS-FOUNDATION: the server-driven remote flag (bootstrap
        // ads.enabled, from MUNCH_ADS_ENABLED, DEFAULT OFF) must also
        // arrive as an explicit true. A caller that predates the flag —
        // or a bootstrap that never carried it — makes no ad load
        // attempt at all.
        boolean adsEnabled = Boolean.TRUE.equals(call.getBoolean("adsEnabled", false));
        // ADS DEMO (test builds only, Michael, 2026-11-12): the web layer
        // forwards demoTestAds when the packaged bundle was built with
        // MUNCH_ADS_DEMO_TEST_BUILD=1. It is honored ONLY in debuggable
        // (non-store) builds and only ever loads Google's sample TEST
        // unit below, so a Play release build ignores the flag entirely.
        boolean demoRequested = Boolean.TRUE.equals(call.getBoolean("demoTestAds", false));
        demoActive = demoRequested && isDebuggableBuild();
        String adUnitId = demoActive
            ? TEST_BANNER_AD_UNIT_ID
            : getContext().getString(R.string.munch_admob_banner_unit_id);
        bannerRequested = visible && (demoActive || (adsEnabled && !adFree)) && adUnitId != null && !adUnitId.isBlank();

        // The slot rect rides the same call (CSS pixels, viewport-
        // relative). A rect-less sync never clears a known rect — the
        // web layer syncs once before Today's DOM exists — but a fresh
        // rect repositions a live banner immediately.
        JSObject slotRect = call.getObject("slotRect");
        if (slotRect != null) {
            slotRectX = slotRect.optDouble("x", 0.0);
            slotRectY = slotRect.optDouble("y", 0.0);
            slotRectWidth = slotRect.optDouble("width", 0.0);
            slotRectHeight = slotRect.optDouble("height", 0.0);
            slotRectKnown = true;
        }

        if (!bannerRequested) {
            runOnUiThread(this::hideBanner);
            call.resolve();
            return;
        }

        call.resolve();
        if (bannerView != null) runOnUiThread(this::positionBanner);
        if (consentRefreshComplete) runOnUiThread(this::showConsentThenBanner);
    }

    private boolean isDebuggableBuild() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    @PluginMethod
    public void showPrivacyOptions(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null || consentInformation == null) {
            call.reject("ad_privacy_options_unavailable");
            return;
        }
        activity.runOnUiThread(() ->
            UserMessagingPlatform.showPrivacyOptionsForm(activity, formError -> {
                JSObject result = new JSObject();
                result.put("available", formError == null);
                if (bannerRequested && consentInformation.canRequestAds()) {
                    initializeAndLoadBanner();
                } else if (bannerRequested) {
                    hideBanner();
                }
                call.resolve(result);
            })
        );
    }

    private void showConsentThenBanner() {
        if (!bannerRequested || consentFormActive || consentInformation == null) return;
        consentFormActive = true;
        Activity activity = getActivity();
        if (activity == null) {
            consentFormActive = false;
            return;
        }
        UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity, formError -> {
            consentFormActive = false;
            if (!bannerRequested) return;
            if (consentInformation.canRequestAds()) initializeAndLoadBanner();
            else hideBanner();
        });
    }

    private void initializeAndLoadBanner() {
        runOnUiThread(() -> {
            if (!bannerRequested || consentInformation == null || !consentInformation.canRequestAds()) {
                hideBanner();
                return;
            }
            if (adsInitialized) {
                loadBannerView();
                return;
            }
            adsInitialized = true;
            MobileAds.initialize(getContext(), initializationStatus -> {
                if (bannerRequested && consentInformation.canRequestAds()) loadBannerView();
            });
        });
    }

    private void loadBannerView() {
        Activity activity = getActivity();
        if (activity == null || !bannerRequested) return;
        activity.runOnUiThread(() -> {
            if (!bannerRequested) return;
            if (bannerView != null) {
                positionBanner();
                return;
            }
            // No slot rect yet: the banner is created only once its
            // in-flow home is known — never at a guessed position.
            if (!slotRectKnown) return;
            View root = activity.findViewById(android.R.id.content);
            if (!(root instanceof FrameLayout)) return;
            FrameLayout frame = (FrameLayout) root;
            if (getBridge() == null || getBridge().getWebView() == null) return;

            AdView adView = new AdView(activity);
            adView.setAdSize(AdSize.BANNER);
            adView.setAdUnitId(demoActive
                ? TEST_BANNER_AD_UNIT_ID
                : getContext().getString(R.string.munch_admob_banner_unit_id));
            adView.setBackgroundColor(Color.WHITE);
            FrameLayout.LayoutParams layout = new FrameLayout.LayoutParams(
                AdSize.BANNER.getWidthInPixels(activity),
                AdSize.BANNER.getHeightInPixels(activity),
                Gravity.TOP | Gravity.LEFT
            );
            bannerView = adView;
            frame.addView(adView, layout);
            positionBanner();
            // Privacy ruling (Michael, Nov 11): non-personalized ads
            // ONLY. The "npa" extra tells AdMob to serve contextual
            // ads and never to build the request on the device's
            // advertising/interest profile. Munch accepts the lower
            // revenue deliberately — the public promise is that ads
            // in this app do not track you.
            Bundle nonPersonalizedExtras = new Bundle();
            nonPersonalizedExtras.putString("npa", "1");
            adView.loadAd(
                new AdRequest.Builder()
                    .addNetworkExtrasBundle(AdMobAdapter.class, nonPersonalizedExtras)
                    .build()
            );
        });
    }

    // Glues the banner to the web layer's slot rect: CSS pixels become
    // physical pixels through the display density, the WebView's own
    // offset inside the activity frame (status bar etc.) is added, and
    // the fixed-size banner centers inside the slot. The banner shows
    // only while the slot is FULLY inside the WebView viewport — a
    // partially scrolled slot hides it rather than letting it paint
    // over app chrome (above all the bottom navigation).
    private void positionBanner() {
        Activity activity = getActivity();
        if (activity == null || bannerView == null) return;
        View root = activity.findViewById(android.R.id.content);
        View currentWebView = getBridge() == null ? null : getBridge().getWebView();
        if (!(root instanceof FrameLayout) || currentWebView == null) return;
        if (!slotRectKnown) {
            bannerView.setVisibility(View.GONE);
            return;
        }
        float density = getContext().getResources().getDisplayMetrics().density;
        int slotXPx = Math.round((float) slotRectX * density);
        int slotYPx = Math.round((float) slotRectY * density);
        int slotWidthPx = Math.round((float) slotRectWidth * density);
        int slotHeightPx = Math.round((float) slotRectHeight * density);
        int[] webViewLocation = new int[2];
        currentWebView.getLocationOnScreen(webViewLocation);
        int[] rootLocation = new int[2];
        root.getLocationOnScreen(rootLocation);
        int bannerWidthPx = AdSize.BANNER.getWidthInPixels(activity);
        int bannerHeightPx = AdSize.BANNER.getHeightInPixels(activity);
        FrameLayout.LayoutParams layout =
            (FrameLayout.LayoutParams) bannerView.getLayoutParams();
        layout.leftMargin = webViewLocation[0] - rootLocation[0]
            + slotXPx + Math.max(0, (slotWidthPx - bannerWidthPx) / 2);
        layout.topMargin = webViewLocation[1] - rootLocation[1]
            + slotYPx + Math.max(0, (slotHeightPx - bannerHeightPx) / 2);
        bannerView.setLayoutParams(layout);
        boolean slotFullyVisible = slotXPx >= 0
            && slotYPx >= 0
            && slotXPx + slotWidthPx <= currentWebView.getWidth()
            && slotYPx + slotHeightPx <= currentWebView.getHeight();
        bannerView.setVisibility(slotFullyVisible ? View.VISIBLE : View.GONE);
    }

    private void hideBanner() {
        Activity activity = getActivity();
        if (activity != null && !activity.isFinishing()) {
            ViewGroup parent = bannerView == null ? null : (ViewGroup) bannerView.getParent();
            if (parent != null) parent.removeView(bannerView);
        }
        if (bannerView != null) {
            bannerView.destroy();
            bannerView = null;
        }
    }

    private void runOnUiThread(Runnable action) {
        Activity activity = getActivity();
        if (activity != null && !activity.isFinishing()) activity.runOnUiThread(action);
    }

    @Override
    protected void handleOnPause() {
        if (bannerView != null) bannerView.pause();
    }

    @Override
    protected void handleOnResume() {
        if (bannerView != null) bannerView.resume();
    }

    @Override
    protected void handleOnDestroy() {
        runOnUiThread(this::hideBanner);
        super.handleOnDestroy();
    }
}
