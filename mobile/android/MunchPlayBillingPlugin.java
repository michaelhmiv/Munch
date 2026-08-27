package business.munch.app;

import android.content.Intent;
import android.net.Uri;

import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryProductDetailsResult;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Collections;
import java.util.List;

@CapacitorPlugin(name = "MunchPlayBilling")
public class MunchPlayBillingPlugin extends Plugin implements PurchasesUpdatedListener {
    private BillingClient billingClient;
    private PluginCall pendingPurchaseCall;
    private String pendingProductId;

    @Override
    public void load() {
        billingClient = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder().enableOneTimeProducts().build()
            )
            .enableAutoServiceReconnection()
            .build();
        connect(null, null);
    }

    private interface ReadyAction {
        void run();
    }

    private void connect(PluginCall call, ReadyAction action) {
        if (billingClient.isReady()) {
            if (action != null) action.run();
            return;
        }
        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult result) {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    if (action != null) action.run();
                    return;
                }
                if (call != null) rejectBilling(call, "billing_setup_failed", result);
            }

            @Override
            public void onBillingServiceDisconnected() {
                // enableAutoServiceReconnection() reconnects on the next API call.
            }
        });
    }

    private void rejectBilling(PluginCall call, String code, BillingResult result) {
        call.reject(
            code + ":" + result.getResponseCode() + ":" + result.getDebugMessage()
        );
    }

    private ProductDetails.SubscriptionOfferDetails basePlanOffer(
        ProductDetails productDetails,
        String basePlanId
    ) {
        List<ProductDetails.SubscriptionOfferDetails> offers =
            productDetails.getSubscriptionOfferDetails();
        if (offers == null) return null;
        for (ProductDetails.SubscriptionOfferDetails offer : offers) {
            if (basePlanId.equals(offer.getBasePlanId()) && offer.getOfferId() == null) {
                return offer;
            }
        }
        return null;
    }

    private void queryPremiumProduct(
        PluginCall call,
        String productId,
        String basePlanId,
        ProductHandler handler
    ) {
        QueryProductDetailsParams.Product product =
            QueryProductDetailsParams.Product.newBuilder()
                .setProductId(productId)
                .setProductType(BillingClient.ProductType.SUBS)
                .build();
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
            .setProductList(Collections.singletonList(product))
            .build();
        billingClient.queryProductDetailsAsync(params, (billingResult, result) -> {
            if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                rejectBilling(call, "product_query_failed", billingResult);
                return;
            }
            ProductDetails details = findProduct(result, productId);
            if (details == null) {
                call.reject("premium_product_unavailable");
                return;
            }
            ProductDetails.SubscriptionOfferDetails offer = basePlanOffer(details, basePlanId);
            if (offer == null) {
                call.reject("premium_base_plan_unavailable");
                return;
            }
            handler.handle(details, offer);
        });
    }

    private interface ProductHandler {
        void handle(
            ProductDetails details,
            ProductDetails.SubscriptionOfferDetails offer
        );
    }

    private ProductDetails findProduct(QueryProductDetailsResult result, String productId) {
        for (ProductDetails details : result.getProductDetailsList()) {
            if (productId.equals(details.getProductId())) return details;
        }
        return null;
    }

    @PluginMethod
    public void getPremiumProduct(PluginCall call) {
        String productId = call.getString("productId");
        String basePlanId = call.getString("basePlanId");
        if (productId == null || productId.isBlank() || basePlanId == null || basePlanId.isBlank()) {
            call.reject("productId and basePlanId are required");
            return;
        }
        connect(call, () -> queryPremiumProduct(call, productId, basePlanId, (details, offer) -> {
            JSObject result = new JSObject();
            result.put("productId", details.getProductId());
            result.put("name", details.getName());
            result.put("description", details.getDescription());
            result.put("basePlanId", offer.getBasePlanId());
            if (!offer.getPricingPhases().getPricingPhaseList().isEmpty()) {
                ProductDetails.PricingPhase price = offer
                    .getPricingPhases()
                    .getPricingPhaseList()
                    .get(offer.getPricingPhases().getPricingPhaseList().size() - 1);
                result.put("formattedPrice", price.getFormattedPrice());
                result.put("billingPeriod", price.getBillingPeriod());
            }
            call.resolve(result);
        }));
    }

    @PluginMethod
    public void purchasePremium(PluginCall call) {
        String productId = call.getString("productId");
        String basePlanId = call.getString("basePlanId");
        String obfuscatedAccountId = call.getString("obfuscatedAccountId");
        if (
            productId == null || productId.isBlank() ||
            basePlanId == null || basePlanId.isBlank() ||
            obfuscatedAccountId == null || obfuscatedAccountId.length() != 64
        ) {
            call.reject("Valid product, base plan, and account identifiers are required");
            return;
        }
        if (pendingPurchaseCall != null) {
            call.reject("purchase_already_in_progress");
            return;
        }

        connect(call, () -> queryPremiumProduct(call, productId, basePlanId, (details, offer) -> {
            BillingFlowParams.ProductDetailsParams productParams =
                BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details)
                    .setOfferToken(offer.getOfferToken())
                    .build();
            BillingFlowParams flowParams = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(productParams))
                .setObfuscatedAccountId(obfuscatedAccountId)
                .setIsOfferPersonalized(false)
                .build();
            pendingPurchaseCall = call;
            pendingProductId = productId;
            BillingResult result = billingClient.launchBillingFlow(getActivity(), flowParams);
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                pendingPurchaseCall = null;
                pendingProductId = null;
                rejectBilling(call, "purchase_launch_failed", result);
            }
        }));
    }

    @PluginMethod
    public void restorePremium(PluginCall call) {
        String productId = call.getString("productId");
        if (productId == null || productId.isBlank()) {
            call.reject("productId is required");
            return;
        }
        connect(call, () -> {
            QueryPurchasesParams params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS)
                .build();
            billingClient.queryPurchasesAsync(params, (billingResult, purchases) -> {
                if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    rejectBilling(call, "purchase_restore_failed", billingResult);
                    return;
                }
                Purchase purchase = matchingPurchase(purchases, productId);
                if (purchase == null) {
                    JSObject result = new JSObject();
                    result.put("state", "none");
                    call.resolve(result);
                    return;
                }
                call.resolve(purchaseResult(purchase));
            });
        });
    }

    private Purchase matchingPurchase(List<Purchase> purchases, String productId) {
        for (Purchase purchase : purchases) {
            if (purchase.getProducts().contains(productId)) return purchase;
        }
        return null;
    }

    private JSObject purchaseResult(Purchase purchase) {
        JSObject result = new JSObject();
        if (purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
            result.put("state", "purchased");
            result.put("purchaseToken", purchase.getPurchaseToken());
        } else if (purchase.getPurchaseState() == Purchase.PurchaseState.PENDING) {
            result.put("state", "pending");
        } else {
            result.put("state", "unknown");
        }
        return result;
    }

    @Override
    public void onPurchasesUpdated(BillingResult billingResult, List<Purchase> purchases) {
        PluginCall call = pendingPurchaseCall;
        String productId = pendingProductId;
        if (call == null) return;

        if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            pendingPurchaseCall = null;
            pendingProductId = null;
            JSObject result = new JSObject();
            result.put("state", "canceled");
            call.resolve(result);
            return;
        }
        if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
            pendingPurchaseCall = null;
            pendingProductId = null;
            rejectBilling(call, "purchase_failed", billingResult);
            return;
        }
        Purchase purchase = purchases == null ? null : matchingPurchase(purchases, productId);
        if (purchase == null) {
            pendingPurchaseCall = null;
            pendingProductId = null;
            call.reject("purchase_result_missing");
            return;
        }
        pendingPurchaseCall = null;
        pendingProductId = null;
        call.resolve(purchaseResult(purchase));
    }

    @PluginMethod
    public void openSubscriptionManagement(PluginCall call) {
        String productId = call.getString("productId");
        String packageName = call.getString("packageName");
        if (productId == null || packageName == null) {
            call.reject("productId and packageName are required");
            return;
        }
        Uri uri = Uri.parse(
            "https://play.google.com/store/account/subscriptions?sku=" +
            Uri.encode(productId) + "&package=" + Uri.encode(packageName)
        );
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
