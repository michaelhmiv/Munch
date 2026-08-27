import {
    currentInstalledAppRoute,
    hasStoredSession,
    installedLoginUrl,
    restoreInstalledEntryRoute,
} from "./mobile-runtime.js";

const explicitRoute = new URLSearchParams(location.search).get("route");
await restoreInstalledEntryRoute(explicitRoute);

if (!(await hasStoredSession())) {
    location.replace(installedLoginUrl(currentInstalledAppRoute()));
} else {
    await import("./app-integrity.js");
    await import("./app.js");
    await import("./app-patches.js");
}
