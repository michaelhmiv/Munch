import {
    getInstalledPlayBillingConfig,
    getInstalledPremiumProduct,
    openInstalledSubscriptionManagement,
    purchaseInstalledPremium,
    restoreInstalledPremium,
} from "./mobile-runtime.js";

let configPromise = null;
let productPromise = null;
let decorating = false;
let decorationQueued = false;

function billingRouteActive() {
    return location.pathname === "/app/settings/billing";
}

function playConfig(refresh = false) {
    if (refresh) configPromise = null;
    configPromise ||= getInstalledPlayBillingConfig();
    return configPromise;
}

function premiumProduct(refresh = false) {
    if (refresh) productPromise = null;
    productPromise ||= getInstalledPremiumProduct();
    return productPromise;
}

function statusElement() {
    let status = document.querySelector("[data-play-billing-status]");
    if (status) return status;
    const actions = document.querySelector(
        ".settings-main .settings-group .settings-actions",
    );
    if (!actions) return null;
    status = document.createElement("span");
    status.dataset.playBillingStatus = "true";
    status.className = "settings-note";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    actions.append(status);
    return status;
}

function setStatus(message) {
    const status = statusElement();
    if (status) status.textContent = message || "";
}

async function decorateBillingPage() {
    if (!billingRouteActive() || decorating) return;
    decorating = true;
    try {
        const config = await playConfig();
        if (!config?.configured || !billingRouteActive()) return;

        const actions = document.querySelector(
            ".settings-main .settings-group .settings-actions",
        );
        if (!actions) return;

        const provider = config.currentSubscription?.provider || null;
        const status = config.currentSubscription?.status || null;
        const active = ["active", "trialing", "past_due"].includes(status);
        const checkout = actions.querySelector(
            '[data-action="billing-checkout"]',
        );

        if (!provider || !active) {
            if (
                !actions.querySelector('[data-action="billing-play-restore"]')
            ) {
                const restore = document.createElement("button");
                restore.type = "button";
                restore.className = "button button-secondary";
                restore.dataset.action = "billing-play-restore";
                restore.textContent = "Restore Google Play purchase";
                actions.append(restore);
            }
            if (checkout) {
                try {
                    const product = await premiumProduct();
                    if (product?.formattedPrice) {
                        checkout.textContent = `Get Premium — ${product.formattedPrice}`;
                    }
                } catch {
                    // The checkout button remains usable; Play will surface any
                    // product availability error if the user chooses to proceed.
                }
            }
        }
    } finally {
        decorating = false;
    }
}

function queueDecoration() {
    if (decorationQueued) return;
    decorationQueued = true;
    queueMicrotask(() => {
        decorationQueued = false;
        void decorateBillingPage();
    });
}

async function handlePurchase(button) {
    button.disabled = true;
    setStatus("Opening Google Play…");
    try {
        const result = await purchaseInstalledPremium();
        if (result?.state === "verified") {
            setStatus("Premium activated.");
            configPromise = null;
            location.reload();
            return;
        }
        if (result?.state === "pending") {
            setStatus(
                "Payment is pending. Premium will activate after Google Play confirms payment.",
            );
            return;
        }
        if (result?.state === "canceled") {
            setStatus("");
            return;
        }
        if (result?.state === "already_subscribed") {
            if (result.provider === "google_play") {
                setStatus("Your Google Play subscription is already active.");
                await openInstalledSubscriptionManagement();
            } else {
                setStatus(
                    "Premium is already active through Munch website billing. No second subscription is needed.",
                );
            }
            return;
        }
        setStatus("Google Play did not complete the purchase.");
    } catch (error) {
        setStatus(error?.message || "Google Play purchase failed.");
    } finally {
        button.disabled = false;
    }
}

async function handleRestore(button, silent = false) {
    button.disabled = true;
    if (!silent) setStatus("Checking Google Play purchases…");
    try {
        const result = await restoreInstalledPremium();
        if (result?.state === "verified") {
            if (!silent) setStatus("Google Play purchase restored.");
            configPromise = null;
            location.reload();
            return;
        }
        if (!silent) {
            setStatus(
                result?.state === "pending"
                    ? "A Google Play payment is still pending."
                    : "No active Google Play Premium purchase was found.",
            );
        }
    } catch (error) {
        if (!silent) {
            setStatus(
                error?.message || "Unable to restore Google Play purchase.",
            );
        }
    } finally {
        button.disabled = false;
    }
}

document.addEventListener(
    "click",
    (event) => {
        const button = event.target.closest?.("[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        if (
            action !== "billing-checkout" &&
            action !== "billing-play-manage" &&
            action !== "billing-play-restore"
        ) {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (action === "billing-checkout") {
            void handlePurchase(button);
        } else if (action === "billing-play-manage") {
            void openInstalledSubscriptionManagement().catch((error) => {
                setStatus(error?.message || "Unable to open Google Play.");
            });
        } else {
            void handleRestore(button);
        }
    },
    true,
);

new MutationObserver(queueDecoration).observe(document.body, {
    childList: true,
    subtree: true,
});
window.addEventListener("popstate", queueDecoration);
queueDecoration();

// Reconcile an interrupted or cross-device Play purchase after startup without
// delaying application rendering. The explicit restore button remains available
// as the user-facing recovery path.
setTimeout(async () => {
    try {
        const config = await playConfig();
        if (
            !config?.configured ||
            config.currentSubscription?.provider === "stripe"
        ) {
            return;
        }
        const result = await restoreInstalledPremium();
        if (
            result?.state === "verified" &&
            config.currentSubscription?.provider !== "google_play"
        ) {
            configPromise = null;
            location.reload();
        }
    } catch {
        // Silent reconciliation must never block or interrupt normal app use.
    }
}, 0);
