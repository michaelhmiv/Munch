import { signInWithPassword } from "./mobile-runtime.js";

const form = document.getElementById("mobile-login-form");
const status = document.getElementById("mobile-login-status");
const submit = form?.querySelector("button[type='submit']");

function setStatus(message, error = false) {
    status.textContent = message || "";
    status.classList.toggle("error", error);
}

form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    submit.disabled = true;
    setStatus("Signing in…");
    try {
        await signInWithPassword(data.get("identifier"), data.get("password"));
        const requested = new URLSearchParams(location.search).get("return_to");
        const route = requested?.startsWith("/app") ? requested : "/app";
        location.replace(`/index.html?route=${encodeURIComponent(route)}`);
    } catch (error) {
        setStatus(error?.message || "Sign in failed", true);
        submit.disabled = false;
    }
});
