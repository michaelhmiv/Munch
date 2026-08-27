#!/usr/bin/env bun

import {
    requestJson,
    resetMunchPlatformAdapter,
    setMunchPlatformAdapter,
} from "../public/app-api.js";

const originalFetch = globalThis.fetch;

try {
    let request:
        | { input: string | URL | Request; init: RequestInit | undefined }
        | undefined;
    globalThis.fetch = (async (input, init) => {
        request = { input, init };
        return Response.json({ ok: true });
    }) as typeof fetch;

    resetMunchPlatformAdapter();
    await requestJson("/api/app/example", {
        method: "POST",
        body: JSON.stringify({ value: 1 }),
    });
    if (!request || request.input !== "/api/app/example") {
        throw new Error("Web transport did not keep a root-relative API URL");
    }
    if (request.init?.credentials !== "same-origin") {
        throw new Error("Web transport did not retain same-origin credentials");
    }
    const webHeaders = new Headers(request.init?.headers);
    if (webHeaders.get("authorization")) {
        throw new Error("Web transport unexpectedly attached bearer auth");
    }
    if (webHeaders.get("content-type") !== "application/json") {
        throw new Error("JSON request did not receive application/json");
    }

    let authReason = "";
    setMunchPlatformAdapter({
        kind: "mobile",
        apiBaseUrl: "https://munch.business",
        async getAccessToken() {
            return "mobile-test-token";
        },
        async onAuthenticationRequired(event: { reason?: string }) {
            authReason = event.reason ?? "";
        },
    });
    await requestJson("/api/app/today?date=2026-08-27");
    if (
        !request ||
        request.input !==
            "https://munch.business/api/app/today?date=2026-08-27"
    ) {
        throw new Error("Mobile transport did not resolve the canonical API URL");
    }
    if (request.init?.credentials !== "omit") {
        throw new Error("Mobile transport attempted to use ambient cookies");
    }
    const mobileHeaders = new Headers(request.init?.headers);
    if (mobileHeaders.get("authorization") !== "Bearer mobile-test-token") {
        throw new Error("Mobile transport did not attach its bearer session");
    }

    const form = new FormData();
    form.append("file", new Blob(["image"]), "receipt.txt");
    await requestJson("/api/app/purchases/receipt-preview", {
        method: "POST",
        body: form,
    });
    const formHeaders = new Headers(request?.init?.headers);
    if (formHeaders.has("content-type")) {
        throw new Error("Shared transport overrode multipart FormData boundary");
    }

    globalThis.fetch = (async () =>
        Response.json({ error: "authentication_required" }, { status: 401 })) as typeof fetch;
    let rejected = false;
    try {
        await requestJson("/api/app/bootstrap");
    } catch (error) {
        rejected =
            error instanceof Error && error.message === "Authentication required";
    }
    if (!rejected || authReason !== "unauthorized") {
        throw new Error("Mobile 401 did not invoke the platform auth boundary");
    }

    let fetchedWithoutToken = false;
    globalThis.fetch = (async () => {
        fetchedWithoutToken = true;
        return Response.json({ ok: true });
    }) as typeof fetch;
    authReason = "";
    setMunchPlatformAdapter({
        kind: "mobile",
        apiBaseUrl: "https://munch.business",
        async getAccessToken() {
            return null;
        },
        async onAuthenticationRequired(event: { reason?: string }) {
            authReason = event.reason ?? "";
        },
    });
    try {
        await requestJson("/api/app/bootstrap");
    } catch {
        // Expected: a mobile request must not leave the device without a token.
    }
    if (fetchedWithoutToken || authReason !== "missing_token") {
        throw new Error("Missing mobile token was not stopped before network I/O");
    }

    let insecureRejected = false;
    try {
        setMunchPlatformAdapter({
            kind: "mobile",
            apiBaseUrl: "http://munch.business",
        });
    } catch {
        insecureRejected = true;
    }
    if (!insecureRejected) {
        throw new Error("Mobile transport accepted an insecure remote API URL");
    }

    console.log(
        "Shared Munch API transport passed web cookie, mobile bearer, multipart, auth, and HTTPS boundaries.",
    );
} finally {
    resetMunchPlatformAdapter();
    globalThis.fetch = originalFetch;
}
