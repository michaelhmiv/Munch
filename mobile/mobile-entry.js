import { hasStoredSession } from "./mobile-runtime.js";

const route = new URLSearchParams(location.search).get("route");
if (route?.startsWith("/app")) {
    history.replaceState({}, "", route);
}

if (!(await hasStoredSession())) {
    const returnTo = location.pathname.startsWith("/app")
        ? location.pathname
        : "/app";
    location.replace(
        `/mobile-login.html?return_to=${encodeURIComponent(returnTo)}`,
    );
} else {
    await import("./app-integrity.js");
    await import("./app.js");
    await import("./app-patches.js");
}
