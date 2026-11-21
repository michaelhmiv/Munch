import {
    installedReturnRoute,
    isAppleSignInAvailable,
    isGoogleSignInAvailable,
    requestMobileMagicLink,
    signInWithApple,
    signInWithGoogle,
} from "./mobile-runtime.js";

const form = document.getElementById("mobile-login-form");
const emailInput = document.getElementById("email");
const status = document.getElementById("mobile-login-status");
const submit = form?.querySelector("button[type='submit']");
const appleButton = document.getElementById("apple-sign-in");
const googleButton = document.getElementById("google-sign-in");
const socialDivider = document.getElementById("social-divider");
const authButtons = [submit, appleButton, googleButton].filter(Boolean);
const returnRoute = installedReturnRoute(
    new URLSearchParams(location.search).get("return_to"),
);

function setStatus(message, error = false, { invalidEmail = false } = {}) {
    status.setAttribute("role", error ? "alert" : "status");
    status.textContent = message || "";
    status.classList.toggle("error", error);
    if (emailInput) {
        if (invalidEmail) {
            emailInput.setAttribute("aria-invalid", "true");
        } else {
            emailInput.removeAttribute("aria-invalid");
        }
    }
}

function setAuthBusy(busy, activeButton = null) {
    for (const button of authButtons) {
        button.disabled = busy;
        if (busy && button === activeButton) {
            button.setAttribute("aria-busy", "true");
        } else {
            button.removeAttribute("aria-busy");
        }
    }
}

emailInput?.addEventListener("input", () => {
    emailInput.removeAttribute("aria-invalid");
});

// S4: the sign-in page carries the same designed offline state as the
// shell — never a dead form. Sign-in attempts made offline surface the
// runtime's can't-reach message through the normal status line.
const offlineBanner = document.getElementById("offline-banner");
function syncOfflineBanner() {
    if (offlineBanner) offlineBanner.hidden = navigator.onLine !== false;
}
window.addEventListener("online", syncOfflineBanner);
window.addEventListener("offline", syncOfflineBanner);
syncOfflineBanner();

const authError = new URLSearchParams(location.search).get("auth_error");
if (authError) {
    setStatus(
        authError === "expired"
            ? "That sign-in link expired. Request a new one."
            : "Sign-in failed. Request a new link and open it on this device.",
        true,
    );
}

form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    setAuthBusy(true, submit);
    setStatus("Sending your sign-in link…");
    try {
        await requestMobileMagicLink(data.get("email"), returnRoute);
        submit.textContent = "Resend sign-in link";
        setStatus("Check your email, then open the link on this device.");
    } catch (error) {
        setStatus(error?.message || "Could not send the sign-in link", true, {
            invalidEmail: true,
        });
    } finally {
        setAuthBusy(false);
    }
});

googleButton?.addEventListener("click", async () => {
    setAuthBusy(true, googleButton);
    setStatus("Signing in with Google…");
    try {
        await signInWithGoogle();
        location.replace(
            `/index.html?route=${encodeURIComponent(returnRoute)}`,
        );
    } catch (error) {
        setStatus(error?.message || "Google sign-in failed", true);
        setAuthBusy(false);
    }
});

appleButton?.addEventListener("click", async () => {
    setAuthBusy(true, appleButton);
    setStatus("Signing in with Apple…");
    try {
        await signInWithApple();
        location.replace(
            `/index.html?route=${encodeURIComponent(returnRoute)}`,
        );
    } catch (error) {
        setStatus(error?.message || "Apple sign-in failed", true);
        setAuthBusy(false);
    }
});

const [appleAvailable, googleAvailable] = await Promise.all([
    appleButton ? isAppleSignInAvailable() : Promise.resolve(false),
    googleButton ? isGoogleSignInAvailable() : Promise.resolve(false),
]);

if (appleButton) {
    appleButton.hidden = !appleAvailable;
}

if (googleButton) {
    googleButton.hidden = !googleAvailable;
}

if (socialDivider) {
    socialDivider.hidden = !appleAvailable && !googleAvailable;
}
