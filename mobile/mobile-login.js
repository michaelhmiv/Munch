import {
    installedReturnRoute,
    requestInstalledMagicLink,
    signInWithPassword,
} from "./mobile-runtime.js";

const magicForm = document.getElementById("mobile-magic-link-form");
const passwordForm = document.getElementById("mobile-password-form");
const status = document.getElementById("mobile-login-status");

function setStatus(message, error = false) {
    status.textContent = message || "";
    status.classList.toggle("error", error);
}

function requestedRoute() {
    return installedReturnRoute(
        new URLSearchParams(location.search).get("return_to"),
    );
}

magicForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(magicForm);
    const submit = magicForm.querySelector("button[type='submit']");
    submit.disabled = true;
    setStatus("Sending a secure sign-in link…");
    try {
        await requestInstalledMagicLink(data.get("email"), requestedRoute());
        setStatus(
            "Check your email on this device. Open the Munch link, then tap ‘Open Munch’ to finish signing in.",
        );
    } catch (error) {
        setStatus(error?.message || "Unable to send sign-in link", true);
    } finally {
        submit.disabled = false;
    }
});

passwordForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(passwordForm);
    const submit = passwordForm.querySelector("button[type='submit']");
    submit.disabled = true;
    setStatus("Signing in…");
    try {
        await signInWithPassword(data.get("identifier"), data.get("password"));
        const route = requestedRoute();
        location.replace(`/index.html?route=${encodeURIComponent(route)}`);
    } catch (error) {
        setStatus(error?.message || "Sign in failed", true);
        submit.disabled = false;
    }
});

window.addEventListener("munch:magic-link-error", (event) => {
    setStatus(
        event?.detail?.message ||
            "This Munch sign-in link is invalid or expired. Request a new link.",
        true,
    );
});
