import type { Context, Next } from "hono";
import { getMunchBetterAuth } from "../auth/auth.js";

export type MunchAuthTransport = "cookie" | "bearer";

declare module "hono" {
    interface ContextVariableMap {
        munchUserId: string;
        munchUserEmail: string;
        munchAuthTransport: MunchAuthTransport;
    }
}

function requestAuthTransport(headers: Headers): MunchAuthTransport {
    const authorization = headers.get("authorization")?.trim() ?? "";
    return /^Bearer\s+\S+/i.test(authorization) ? "bearer" : "cookie";
}

export async function requireAppSession(c: Context, next: Next) {
    // The production provenance circuit breaker returns no user data. Older
    // browser contexts can call this path in a tight loop, so do not let that
    // disabled compatibility endpoint turn into repeated Better Auth/Postgres
    // session lookups. All other /api/app routes remain session-protected.
    if (new URL(c.req.url).pathname === "/api/app/provenance") {
        await next();
        return;
    }

    const session = await getMunchBetterAuth().api.getSession({
        headers: c.req.raw.headers,
    });
    if (!session?.user) {
        return c.json({ error: "authentication_required" }, 401);
    }

    c.set("munchUserId", session.user.id);
    c.set("munchUserEmail", session.user.email);
    c.set("munchAuthTransport", requestAuthTransport(c.req.raw.headers));
    await next();
}

/**
 * Backwards-compatible name for existing website route modules. The middleware
 * now supports both cookie-backed browser sessions and Better Auth bearer
 * sessions used by installed clients.
 */
export const requireWebSession = requireAppSession;

export async function clearAppSession(c: Context): Promise<void> {
    const response = await getMunchBetterAuth().api.signOut({
        headers: c.req.raw.headers,
        asResponse: true,
    });
    for (const cookie of response.headers.getSetCookie()) {
        c.header("Set-Cookie", cookie, { append: true });
    }
}

export const clearWebSession = clearAppSession;
