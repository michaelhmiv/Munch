import {
    installedReturnRoute,
    isGoogleSignInAvailable,
    requestMobileMagicLink,
    signInWithGoogle,
} from "./mobile-runtime.js";

const form = document.getElementById("mobile-login-form");
const status = document.getElementById("mobile-login-status");
const submit = form?.querySelector("button[type='submit']");
const googleButton = document.getElementById("google-sign-in");
const returnRoute = installedReturnRoute(
    new URLSearchParams(location.search).get("return_to"),
);

function setStatus(message, error = false) {
    status.textContent = message || "";
    status.classList.toggle("error", error);
}

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
    submit.disabled = true;
    setStatus("Sending your sign-in link…");
    try {
        await requestMobileMagicLink(data.get("email"), returnRoute);
        submit.textContent = "Resend sign-in link";
        setStatus("Check your email, then open the link on this device.");
    } catch (error) {
        setStatus(error?.message || "Could not send the sign-in link", true);
    } finally {
        submit.disabled = false;
    }
});

googleButton?.addEventListener("click", async () => {
    googleButton.disabled = true;
    setStatus("Signing in with Google…");
    try {
        await signInWithGoogle();
        location.replace(
            `/index.html?route=${encodeURIComponent(returnRoute)}`,
        );
    } catch (error) {
        setStatus(error?.message || "Google sign-in failed", true);
        googleButton.disabled = false;
    }
});

if (googleButton) {
    googleButton.hidden = !(await isGoogleSignInAvailable());
}
