#!/usr/bin/env bun
/**
 * Cross-provider sign-in collision smoke (Michael's requirement,
 * 2026-11-12): a provider identity arriving at sign-in time whose
 * verified email belongs to an existing account under a DIFFERENT
 * method must never silently link, never duplicate the account, and
 * never dead-end. The required behavior:
 *
 *   - the colliding sign-in is refused (native id-token: 401
 *     OAUTH_LINK_ERROR; web redirect: the provider callback lands on
 *     /connect/link-conflict?error=account_not_linked, which explains
 *     and records a pending-link cookie);
 *   - the user signs in with their ORIGINAL method and is prompted to
 *     add the new method to the SAME account (Amendment I link);
 *   - confirming lands every later sign-in in that account, Premium
 *     entitlement (account-level) intact;
 *   - declining leaves the account exactly as it was — the colliding
 *     provider stays refused, never a forked account;
 *   - Apple Hide My Email cannot match by email by construction: an
 *     unlinked relay identity creates its own account at sign-in
 *     (documented), while linking the relay identity FIRST (signed in
 *     with the original method) makes later Apple sign-ins land home,
 *     and an identity already owned by another account refuses to
 *     link (409 — no silent merge of two accounts).
 *
 * Everything runs against the real Better Auth instance, the real
 * connect router, and the real sign-in-methods router over a migrated
 * Postgres. The only stubbed edges are the network ones: Resend
 * delivery is captured instead of sent, and each provider object's
 * token verification / profile fetch is armed per flow — the seam a
 * real Google/Apple authorization round-trip would land on. Every
 * layer above that seam (collision detection, session minting, the
 * link machinery, entitlements) is production code.
 */
import { generateKeyPairSync } from "node:crypto";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the account-collision smoke");
}

const fixturePrivateKey = generateKeyPairSync("ec", {
    namedCurve: "P-256",
})
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

process.env.MUNCH_APP_BASE_URL = "https://munch.example";
process.env.MUNCH_GOOGLE_WEB_CLIENT_ID = "collision-google-web-client";
process.env.MUNCH_GOOGLE_CLIENT_SECRET = "collision-google-secret";
// Also register the Android audience: the packaged app's Google
// sign-in presents ID tokens against its own client id, exercising
// the same collision path Michael's scenario names.
process.env.MUNCH_GOOGLE_ANDROID_CLIENT_ID = "collision-google-android";
process.env.MUNCH_APPLE_SERVICES_ID = "business.munch.signin";
process.env.MUNCH_APPLE_KEY_ID = "COLLISION1";
process.env.MUNCH_APPLE_TEAM_ID = "COLLISIONTEAM";
process.env.MUNCH_APPLE_PRIVATE_KEY = fixturePrivateKey;
process.env.RESEND_API_KEY = "re_collision_smoke";
process.env.MUNCH_EMAIL_FROM = "Munch <login@munch.example>";
process.env.BETTER_AUTH_SECRET =
    "collision-smoke-secret-collision-smoke-secret";

const sentEmails: unknown[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.resend.com")) {
        sentEmails.push(init?.body ? JSON.parse(String(init.body)) : null);
        return new Response(JSON.stringify({ id: "collision-email" }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }
    // OAuth token-exchange seam for the web redirect flow: a real
    // browser round-trip would land here with a real authorization
    // code. Return fixture tokens; profile fetch and id-token
    // verification are stubbed on the provider objects below.
    if (
        url.includes("oauth2.googleapis.com/token") ||
        url.includes("appleid.apple.com/auth/token")
    ) {
        return new Response(
            JSON.stringify({
                access_token: "collision-access-token",
                refresh_token: "collision-refresh-token",
                expires_in: 3599,
                scope: "",
                token_type: "Bearer",
                id_token: "collision-fixture",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }
    return realFetch(input as never, init);
}) as typeof fetch;

const { Hono } = await import("hono");
const { SQL } = await import("bun");
const { getMunchBetterAuth } = await import("../src/auth/auth.js");
const { createBetterAuthConnectRouter } =
    await import("../src/auth/connect-routes.js");
const { createSignInMethodsRouter } =
    await import("../src/auth/sign-in-methods-routes.js");
const { grantPremiumOverride } = await import("../src/billing/override.js");
const { resolveMunchCapabilitiesSafe } =
    await import("../src/billing/capabilities.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");

const auth = getMunchBetterAuth();
const app = new Hono();
app.route("/", createSignInMethodsRouter());
app.route("/", createBetterAuthConnectRouter());
app.all("*", (c) => auth.handler(c.req.raw));

type Profile = { id: string; email: string; name: string };
const armed: Record<"google" | "apple", Profile> = {
    google: { id: "unset", email: "unset@example.test", name: "Unset" },
    apple: { id: "unset", email: "unset@example.test", name: "Unset" },
};
// Provider-level seam: Better Auth verifies the presented id token and
// fetches the profile through the provider object; arm both to the
// profile the flow is exercising.
const ctx = await auth.$context;
for (const providerId of ["google", "apple"] as const) {
    const provider = (
        ctx.options.socialProviders as unknown as Record<
            string,
            Record<string, unknown>
        >
    )?.[providerId];
    if (!provider) throw new Error(`provider not registered: ${providerId}`);
    provider.verifyIdToken = async () => true;
    provider.getUserInfo = async () => ({
        user: {
            id: armed[providerId].id,
            email: armed[providerId].email,
            emailVerified: true,
            name: armed[providerId].name,
        },
    });
    provider.getTokens = async () => ({
        accessToken: "collision-access-token",
        refreshToken: "collision-refresh-token",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenExpiresAt: undefined,
        scopes: [],
    });
}

const sql = new SQL(databaseUrl);
const run = crypto.randomUUID().slice(0, 8);
let ipCounter = 0;
const ORIGIN = "https://munch.example";

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

async function call(
    path: string,
    init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("x-real-ip"))
        headers.set("x-real-ip", `198.51.100.${++ipCounter}`);
    let body = init.body;
    if (init.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(init.json);
    }
    return app.request(
        path.startsWith("http") ? path : `https://munch.example${path}`,
        {
            ...init,
            headers,
            body,
        },
    );
}

async function postSocial(
    provider: "google" | "apple",
    profile: Profile,
): Promise<{ status: number; body: Record<string, unknown> }> {
    armed[provider] = profile;
    const response = await call("/api/auth/sign-in/social", {
        method: "POST",
        json: {
            provider,
            idToken: { token: "collision-fixture", nonce: "collision-nonce" },
            callbackURL: "/app",
            errorCallbackURL: "/connect/error",
        },
    });
    const body = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
    >;
    return { status: response.status, body };
}

function sessionHeaders(signInBody: Record<string, unknown>): Headers {
    const headers = new Headers({
        authorization: `Bearer ${String(signInBody.token ?? "")}`,
        origin: ORIGIN,
    });
    return headers;
}

async function userCount(email: string): Promise<number> {
    const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM munch.users WHERE email = ${email}
    `;
    return Number(rows[0]?.count ?? 0);
}

async function accountProviders(userId: string): Promise<string[]> {
    const rows = await sql<{ provider_id: string }[]>`
        SELECT provider_id FROM munch.auth_accounts WHERE user_id = ${userId} ORDER BY provider_id
    `;
    return rows.map((row) => row.provider_id);
}

async function linkViaSession(
    headers: Headers,
    provider: "google" | "apple",
    profile: Profile,
): Promise<Response> {
    armed[provider] = profile;
    return call(`/api/app/sign-in-methods/${provider}/link`, {
        method: "POST",
        headers,
        json: {
            idToken: "collision-fixture",
            callbackURL: "/app",
            errorCallbackURL: "/app",
        },
    });
}

async function methodsViaSession(
    headers: Headers,
): Promise<{ id: string; state: string }[]> {
    const response = await call("/api/app/sign-in-methods", { headers });
    assert(response.status === 200, "sign-in methods list must load");
    const body = (await response.json()) as {
        methods: { id: string; state: string }[];
    };
    return body.methods;
}

function setCookies(response: Response): string[] {
    const headers = response.headers as Headers & {
        getSetCookie?: () => string[];
    };
    if (typeof headers.getSetCookie === "function")
        return headers.getSetCookie();
    const combined = response.headers.get("set-cookie");
    return combined ? [combined] : [];
}

/** Full production magic-link arrival: request -> captured email -> confirm. */
async function magicSession(
    email: string,
): Promise<{ userId: string; cookie: string }> {
    sentEmails.length = 0;
    const form = new URLSearchParams({ email, return_to: "/app" });
    const request = await call("/connect/request", {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ORIGIN,
        },
        body: form.toString(),
    });
    assert(request.status === 200, "magic-link request must succeed");
    const match = JSON.stringify(sentEmails).match(/token=([A-Za-z0-9_-]+)/);
    assert(match, "magic-link email must carry a confirm token");
    const confirmForm = new URLSearchParams({
        token: match[1],
        return_to: "/app",
    });
    const confirm = await call("/connect/confirm", {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ORIGIN,
        },
        body: confirmForm.toString(),
    });
    const cookie = setCookies(confirm).find((value) =>
        value.includes("session_token"),
    );
    assert(cookie, "magic-link confirm must set a session cookie");
    const sessionResponse = await call("/api/auth/get-session", {
        headers: { cookie: cookie.split(";")[0] },
    });
    const session = (await sessionResponse.json()) as {
        user?: { id: string };
    } | null;
    assert(session?.user?.id, "magic-link session must resolve a user");
    return { userId: session.user.id, cookie: cookie.split(";")[0] };
}

async function signInByMagicLink(email: string): Promise<string> {
    return (await magicSession(email)).userId;
}

const createdUserIds: string[] = [];
try {
    // ---- Flow A: Google first, Apple collides, confirm-link, Premium.
    const emailA = `collision-a-${run}@example.test`;
    const googleA = {
        id: `g-sub-a-${run}`,
        email: emailA,
        name: "Flow A",
    };
    const appleA = { id: `a-sub-a-${run}`, email: emailA, name: "Flow A" };
    const a1 = await postSocial("google", googleA);
    assert(a1.status === 200, "flow A: Google sign-in must succeed");
    const userA = String((a1.body.user as { id: string }).id);
    createdUserIds.push(userA);
    await grantPremiumOverride({
        userId: userA,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        source: "support",
        reason: "collision smoke premium fixture",
    });
    const a2 = await postSocial("apple", appleA);
    assert(
        a2.status === 401 && a2.body.code === "OAUTH_LINK_ERROR",
        "flow A: colliding Apple sign-in must be refused, not linked",
    );
    assert(
        (await userCount(emailA)) === 1,
        "flow A: collision must not duplicate the account",
    );
    assert(
        JSON.stringify(await accountProviders(userA)) === '["google"]',
        "flow A: collision must not silently link Apple",
    );
    const a3 = await postSocial("google", googleA);
    assert(
        a3.status === 200 &&
            String((a3.body.user as { id: string }).id) === userA,
        "flow A: original method must still sign in",
    );
    const aHeaders = sessionHeaders(a3.body);
    const aLink = await linkViaSession(aHeaders, "apple", appleA);
    assert(aLink.status === 200, "flow A: confirm-link must succeed");
    const aMethods = await methodsViaSession(aHeaders);
    assert(
        aMethods.find((m) => m.id === "apple")?.state === "linked",
        "flow A: Apple must read linked after confirmation",
    );
    const a4 = await postSocial("apple", appleA);
    assert(
        a4.status === 200 &&
            String((a4.body.user as { id: string }).id) === userA,
        "flow A: Apple sign-in must land in the same account after linking",
    );
    const aCaps = (await resolveMunchCapabilitiesSafe(userA)) as unknown as {
        tier?: string;
        capabilities?: { tier?: string };
    };
    assert(
        (aCaps.tier ?? aCaps.capabilities?.tier) === "premium",
        "flow A: Premium entitlement must carry across the linked sign-in",
    );
    console.log("flow A (google->apple, confirm, premium): ok");

    // ---- Flow B: Apple first, Google collides, web prompt + decline.
    const emailB = `collision-b-${run}@example.test`;
    const appleB = { id: `a-sub-b-${run}`, email: emailB, name: "Flow B" };
    const googleB = {
        id: `g-sub-b-${run}`,
        email: emailB,
        name: "Flow B",
    };
    const b1 = await postSocial("apple", appleB);
    assert(b1.status === 200, "flow B: Apple sign-in must succeed");
    const userB = String((b1.body.user as { id: string }).id);
    createdUserIds.push(userB);
    const b2 = await postSocial("google", googleB);
    assert(
        b2.status === 401 && b2.body.code === "OAUTH_LINK_ERROR",
        "flow B: colliding Google sign-in must be refused, not linked",
    );
    assert(
        JSON.stringify(await accountProviders(userB)) === '["apple"]',
        "flow B: collision must not silently link Google",
    );
    // Web redirect surface: initiation -> provider callback -> the
    // link-conflict page records the pending prompt.
    armed.google = googleB;
    const initiation = await call("/api/auth/sign-in/social", {
        method: "POST",
        json: {
            provider: "google",
            callbackURL: "/app",
            errorCallbackURL: "/connect/link-conflict?provider=google",
        },
    });
    assert(initiation.status === 200, "flow B: web initiation must start");
    const initiationBody = (await initiation.json()) as { url: string };
    const state = new URL(initiationBody.url).searchParams.get("state");
    assert(state, "flow B: initiation must carry OAuth state");
    const stateCookie = setCookies(initiation)
        .map((value) => value.split(";")[0])
        .join("; ");
    const callback = await call(
        `/api/auth/callback/google?code=collision-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: stateCookie }, redirect: "manual" },
    );
    const location = callback.headers.get("location") ?? "";
    assert(
        callback.status === 302 &&
            location.includes("/connect/link-conflict") &&
            location.includes("error=account_not_linked"),
        "flow B: web collision must redirect to the link-conflict page",
    );
    const conflict = await call(location, {});
    const conflictHtml = await conflict.text();
    assert(
        conflict.status === 200 &&
            conflictHtml.includes("You already have a Munch account"),
        "flow B: link-conflict page must explain the collision",
    );
    const promptCookie = setCookies(conflict).find((value) =>
        value.startsWith("munch_link_prompt=google"),
    );
    assert(promptCookie, "flow B: conflict page must set the prompt cookie");
    // Sign in with the original method; the prompt endpoint serves the
    // pending provider; declining clears it and links nothing.
    const b3 = await postSocial("apple", appleB);
    assert(b3.status === 200, "flow B: original method must sign in");
    const bHeaders = sessionHeaders(b3.body);
    bHeaders.set("cookie", promptCookie.split(";")[0]);
    const promptResponse = await call("/api/app/sign-in-methods/link-prompt", {
        headers: bHeaders,
    });
    const promptBody = (await promptResponse.json()) as {
        prompt: { provider: string } | null;
    };
    assert(
        promptBody.prompt?.provider === "google",
        "flow B: signed-in user must be offered the pending Google link",
    );
    const dismiss = await call("/api/app/sign-in-methods/link-prompt/dismiss", {
        method: "POST",
        headers: bHeaders,
        json: {},
    });
    assert(dismiss.status === 200, "flow B: dismiss must succeed");
    const afterDismiss = await call("/api/app/sign-in-methods/link-prompt", {
        headers: sessionHeaders(b3.body),
    });
    const afterDismissBody = (await afterDismiss.json()) as {
        prompt: unknown;
    };
    assert(
        afterDismissBody.prompt === null,
        "flow B: dismissed prompt must not re-offer without the cookie",
    );
    const b4 = await postSocial("google", googleB);
    assert(
        b4.status === 401,
        "flow B: declined provider must stay refused (no silent link)",
    );
    assert(
        (await userCount(emailB)) === 1 &&
            JSON.stringify(await accountProviders(userB)) === '["apple"]',
        "flow B: decline must leave exactly the original account/method",
    );
    console.log("flow B (apple->google, web prompt, decline): ok");

    // ---- Flow C: email-link first, Google collides, then links.
    const emailC = `collision-c-${run}@example.test`;
    const googleC = {
        id: `g-sub-c-${run}`,
        email: emailC,
        name: "Flow C",
    };
    const userC = await signInByMagicLink(emailC);
    createdUserIds.push(userC);
    assert(
        (await accountProviders(userC)).length === 0,
        "flow C: email-link account starts with no provider rows",
    );
    const c1 = await postSocial("google", googleC);
    assert(
        c1.status === 401 && c1.body.code === "OAUTH_LINK_ERROR",
        "flow C: Google sign-in against an email-link account must be refused, not silently linked",
    );
    const userCAgain = await signInByMagicLink(emailC);
    assert(
        userCAgain === userC,
        "flow C: email link must keep landing in the same account",
    );
    const cSession = await magicSession(emailC);
    const cHeaders = new Headers({ origin: ORIGIN });
    cHeaders.set("cookie", cSession.cookie);
    const cLink = await linkViaSession(cHeaders, "google", googleC);
    assert(cLink.status === 200, "flow C: confirm-link must succeed");
    const c2 = await postSocial("google", googleC);
    assert(
        c2.status === 200 &&
            String((c2.body.user as { id: string }).id) === userC,
        "flow C: Google sign-in must land in the email-link account after linking",
    );
    console.log("flow C (email-link->google): ok");

    // ---- Flow D: provider first, email link lands in the same account.
    const emailD = `collision-d-${run}@example.test`;
    const googleD = {
        id: `g-sub-d-${run}`,
        email: emailD,
        name: "Flow D",
    };
    const d1 = await postSocial("google", googleD);
    assert(d1.status === 200, "flow D: Google sign-in must succeed");
    const userD = String((d1.body.user as { id: string }).id);
    createdUserIds.push(userD);
    const userDByMagic = await signInByMagicLink(emailD);
    assert(
        userDByMagic === userD && (await userCount(emailD)) === 1,
        "flow D: email link must land in the provider-created account",
    );
    console.log("flow D (google->email-link): ok");

    // ---- Hide My Email: link-first lands home; sign-in-first forks;
    //      an identity owned by the fork refuses to link (409).
    const emailH = `collision-h-${run}@example.test`;
    const relayH = `collision-relay-${run}@privaterelay.appleid.com`;
    const googleH = {
        id: `g-sub-h-${run}`,
        email: emailH,
        name: "Flow H",
    };
    const h1 = await postSocial("google", googleH);
    assert(h1.status === 200, "HME: Google sign-in must succeed");
    const userH = String((h1.body.user as { id: string }).id);
    createdUserIds.push(userH);
    const hHeaders = sessionHeaders(h1.body);
    const appleRelayLinked = {
        id: `a-sub-hme-linked-${run}`,
        email: relayH,
        name: "Flow H",
    };
    const hLink = await linkViaSession(hHeaders, "apple", appleRelayLinked);
    assert(
        hLink.status === 200,
        "HME: linking the relay identity while signed in must succeed",
    );
    const h2 = await postSocial("apple", appleRelayLinked);
    assert(
        h2.status === 200 &&
            String((h2.body.user as { id: string }).id) === userH,
        "HME: Apple sign-in with a linked relay identity must land in the original account",
    );
    assert(
        (await userCount(relayH)) === 0,
        "HME: link-first must not fork a relay-email account",
    );
    const appleRelayFork = {
        id: `a-sub-hme-fork-${run}`,
        email: `collision-relay-fork-${run}@privaterelay.appleid.com`,
        name: "Flow H Fork",
    };
    const h3 = await postSocial("apple", appleRelayFork);
    assert(
        h3.status === 200 &&
            String((h3.body.user as { id: string }).id) !== userH,
        "HME: an unlinked relay identity cannot match by email and creates its own account (documented)",
    );
    createdUserIds.push(String((h3.body.user as { id: string }).id));
    const h4 = await linkViaSession(hHeaders, "apple", appleRelayFork);
    assert(
        h4.status === 409,
        "HME: an identity owned by another account must refuse to link (no silent merge)",
    );
    console.log("hide-my-email (link-first + fork + conflict): ok");

    console.log("better-auth account-collision smoke: ok");
} finally {
    if (createdUserIds.length) {
        await sql`
            DELETE FROM munch.entitlements WHERE user_id = ANY(${createdUserIds})
        `.catch(() => {});
        await sql`
            DELETE FROM munch.users WHERE id = ANY(${createdUserIds})
        `.catch(() => {});
    }
    await sql`
        DELETE FROM munch.users WHERE email LIKE ${`collision-%-${run}@%`}
    `.catch(() => {});
    await sql.close();
    await closePlatformDatabase();
}
