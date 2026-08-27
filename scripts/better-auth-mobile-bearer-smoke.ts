#!/usr/bin/env bun

process.env.MUNCH_REVIEWER_SEED_MODE = "true";

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
}

const { Hono } = await import("hono");
const { Pool } = await import("pg");
const { getMunchBetterAuth } = await import("../src/auth/auth.js");
const { requireSameOrigin } = await import("../src/accounts/csrf.js");
const { requireAppSession } = await import("../src/accounts/session.js");
const { closePlatformDatabase } = await import("../src/platform/database.js");

const email = `mobile-bearer-${crypto.randomUUID()}@example.test`;
const password = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
const auth = getMunchBetterAuth();

await auth.api.signUpEmail({
    body: {
        email,
        password,
        name: "Mobile bearer smoke",
        callbackURL: "/app",
    },
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    application_name: "munch-mobile-bearer-smoke",
});
await pool.query(
    `update munch.users
     set status = 'active',
         email_verified = true,
         email_verified_at = coalesce(email_verified_at, now()),
         updated_at = now()
     where email = $1`,
    [email],
);

const signIn = await auth.api.signInEmail({
    body: {
        email,
        password,
        rememberMe: false,
        callbackURL: "/app",
    },
    returnHeaders: true,
});
const bearerToken = signIn.headers.get("set-auth-token");
const cookie = signIn.headers.get("set-cookie");
if (!bearerToken || !cookie) {
    throw new Error("Sign-in did not expose both bearer and cookie sessions");
}

const bearerSession = await auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${bearerToken}` }),
});
if (bearerSession?.user.email !== email) {
    throw new Error("Better Auth bearer token did not resolve the signed-in user");
}

const app = new Hono();
app.use("/mutate", requireAppSession);
app.post("/mutate", requireSameOrigin, (c) =>
    c.json({
        ok: true,
        userId: c.get("munchUserId"),
        transport: c.get("munchAuthTransport"),
    }),
);

const bearerMutation = await app.request("https://munch.example/mutate", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearerToken}` },
});
if (bearerMutation.status !== 200) {
    throw new Error(
        `Authenticated bearer mutation was rejected (${bearerMutation.status})`,
    );
}
const bearerBody = (await bearerMutation.json()) as {
    ok?: boolean;
    transport?: string;
};
if (!bearerBody.ok || bearerBody.transport !== "bearer") {
    throw new Error("Bearer mutation did not retain mobile auth transport");
}

const invalidBearer = await app.request("https://munch.example/mutate", {
    method: "POST",
    headers: { Authorization: "Bearer invalid-mobile-session" },
});
if (invalidBearer.status !== 401) {
    throw new Error("Invalid bearer session was not rejected");
}

const cookieWithoutOrigin = await app.request("https://munch.example/mutate", {
    method: "POST",
    headers: { cookie },
});
if (cookieWithoutOrigin.status !== 403) {
    throw new Error("Browser cookie mutation bypassed same-origin protection");
}

const cookieWithOrigin = await app.request("https://munch.example/mutate", {
    method: "POST",
    headers: {
        cookie,
        origin: "https://munch.example",
    },
});
if (cookieWithOrigin.status !== 200) {
    throw new Error("Valid same-origin browser mutation was rejected");
}
const cookieBody = (await cookieWithOrigin.json()) as {
    ok?: boolean;
    transport?: string;
};
if (!cookieBody.ok || cookieBody.transport !== "cookie") {
    throw new Error("Cookie mutation did not retain browser auth transport");
}

await pool.end();
await closePlatformDatabase();
console.log(
    "Better Auth mobile bearer session, invalid-token rejection, and browser CSRF separation passed.",
);
