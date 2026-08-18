import type { Context, Next } from "hono";
import { getMunchBetterAuth } from "../auth/auth.js";

declare module "hono" {
    interface ContextVariableMap {
        munchUserId: string;
        munchUserEmail: string;
    }
}

export async function requireWebSession(c: Context, next: Next) {
    const session = await getMunchBetterAuth().api.getSession({
        headers: c.req.raw.headers,
    });
    if (!session?.user) {
        return c.json({ error: "authentication_required" }, 401);
    }

    c.set("munchUserId", session.user.id);
    c.set("munchUserEmail", session.user.email);
    await next();
}

export async function clearWebSession(c: Context): Promise<void> {
    const response = await getMunchBetterAuth().api.signOut({
        headers: c.req.raw.headers,
        asResponse: true,
    });
    for (const cookie of response.headers.getSetCookie()) {
        c.header("Set-Cookie", cookie, { append: true });
    }
}
