import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";
import {
    withUserDatabase,
    closePlatformDatabase,
} from "../../src/platform/database.js";

// A disposable identity, created only in this explicitly authorized production test.
// Never load credentials for an existing account or write credentials to artifacts.
const targetCook = "09eeb081-d395-4172-937b-3d6a4c25ed5f";
const targetMedia = "2e9e7e0d-3501-4951-b0a9-c6ae8f3f9875";
const prefix = "CERT-COOKS-OWNERSHIP-20260916";
const origin = "https://munch.business";
const url = process.env.DATABASE_URL;
if (!url || new URL(url).hostname.endsWith(".railway.internal")) {
    throw new Error("A public production database connection is required");
}
const pool = new Pool({
    connectionString: url,
    max: 1,
    application_name: "munch-cooks-ownership-cert",
});
const userId = randomUUID();
const email = `cert-cooks-${userId}@example.test`;
const password = randomBytes(32).toString("base64url");
console.log(`::add-mask::${password}`);
let step = "validate target";
let created = false;
let ownCook: string | undefined;
try {
    const target = await pool.query(
        "select id, title from munch.cooks where id = $1",
        [targetCook],
    );
    if (!target.rows[0]?.title.startsWith("CERT-COOKS-PHOTO-20260916"))
        throw new Error("Invalid target");
    step = "create isolated identity";
    await pool.query("BEGIN");
    await pool.query(
        "insert into munch.users (id,email,name,email_verified,email_verified_at,status) values ($1,$2,$3,true,now(),'active')",
        [userId, email, prefix],
    );
    await pool.query(
        "insert into munch.auth_accounts (user_id,account_id,provider_id,password) values ($1,$1,'credential',$2)",
        [userId, await hashPassword(password)],
    );
    await pool.query(
        "insert into munch.account_preferences (user_id,timezone) values ($1,'America/New_York')",
        [userId],
    );
    await pool.query(
        "insert into munch.entitlements (user_id,feature_key,active,expires_at,source) values ($1,'premium_access',true,now()+interval '1 hour','reviewer')",
        [userId],
    );
    await pool.query("COMMIT");
    created = true;
    console.log(
        JSON.stringify({
            created_test_user: userId,
            label: prefix,
            expires: "premium in one hour; identity removed in finally",
        }),
    );
    step = "authenticate separate account through production";
    const login = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
            email,
            password,
            rememberMe: false,
            callbackURL: "/app",
        }),
    });
    if (!login.ok) throw new Error("Login failed");
    const cookies = login.headers
        .getSetCookie()
        .map((v) => v.split(";", 1)[0])
        .join("; ");
    if (!cookies) throw new Error("Session missing");
    console.log(`::add-mask::${cookies}`);
    const headers = {
        cookie: cookies,
        origin,
        "content-type": "application/json",
    };
    const session = await fetch(`${origin}/api/auth/get-session`, { headers });
    const sessionBody = await session.json();
    if (sessionBody?.user?.id !== userId) throw new Error("Identity mismatch");
    console.log("PASS: production login resolves the newly created account");
    step = "positive control: create and read own cook";
    const create = await fetch(`${origin}/api/app/cooks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            title: prefix,
            timezone: "America/New_York",
            dishes: [{ name: prefix }],
            message: `${prefix} note`,
            request_id: prefix + userId,
        }),
    });
    const body = await create.json();
    ownCook = body.cookId ?? body.cook_id ?? body.cook?.cook?.id;
    if (!create.ok || !ownCook) throw new Error("Own cook creation failed");
    const ownRead = await fetch(`${origin}/api/app/cooks/${ownCook}`, {
        headers,
    });
    if (!ownRead.ok) throw new Error("Own cook read failed");
    console.log(
        JSON.stringify({
            positive_control_cook: ownCook,
            status: ownRead.status,
        }),
    );
    step = "deny foreign cook and media over HTTP";
    const foreign = await fetch(`${origin}/api/app/cooks/${targetCook}`, {
        headers,
    });
    const foreignBody = await foreign.text();
    if (
        ![400, 403, 404].includes(foreign.status) ||
        foreignBody.includes("CERT-COOKS-PHOTO") ||
        foreignBody.includes(targetMedia)
    )
        throw new Error("Foreign cook leaked");
    const media = await fetch(`${origin}/media/cooks/${targetMedia}`, {
        headers,
    });
    if (
        ![401, 403, 404].includes(media.status) ||
        (media.headers.get("content-type") ?? "").startsWith("image/")
    )
        throw new Error("Foreign media leaked");
    console.log(
        JSON.stringify({
            foreign_cook_http: foreign.status,
            foreign_media_without_capability_http: media.status,
        }),
    );
    step = "verify database row isolation for cook, events, media";
    const counts = await withUserDatabase(userId, async (tx) => ({
        cooks: (await tx`select id from munch.cooks where id=${targetCook}`)
            .length,
        events: (
            await tx`select id from munch.cook_events where cook_id=${targetCook}`
        ).length,
        media: (
            await tx`select id from munch.cook_media where id=${targetMedia}`
        ).length,
    }));
    if (Object.values(counts).some((n) => n !== 0))
        throw new Error("RLS leaked");
    console.log(JSON.stringify({ rls_visible_foreign_rows: counts }));
    console.log(
        "PASS: production HTTP ownership and database isolation. Signed photo links are bearer capabilities; this test does not claim they require browser sign-in.",
    );
} catch {
    console.error(`FAIL: ${step}; sensitive exception details suppressed`);
    process.exitCode = 1;
} finally {
    await pool.query("ROLLBACK").catch(() => {});
    if (created) {
        // List every newly owned record before deleting this single test identity.
        const inventory: Record<string, unknown> = { userId, email, ownCook };
        for (const table of [
            "cooks",
            "cook_dishes",
            "cook_events",
            "cook_updates",
            "cook_media",
            "cook_outcomes",
        ]) {
            const sql =
                table === "cooks"
                    ? "select id from munch.cooks where personal_owner_user_id=$1"
                    : `select id from munch.${table} where cook_id in (select id from munch.cooks where personal_owner_user_id=$1)`;
            inventory[table] = (await pool.query(sql, [userId])).rows.map(
                (r) => r.id,
            );
        }
        console.log(JSON.stringify({ test_only_cleanup_inventory: inventory }));
        await pool.query(
            "delete from munch.users where id=$1 and email=$2 and name=$3",
            [userId, email, prefix],
        );
        const remaining = await pool.query(
            "select id from munch.users where id=$1",
            [userId],
        );
        if (remaining.rowCount !== 0) {
            process.exitCode = 1;
            console.error("FAIL cleanup");
        } else
            console.log(
                "PASS: test identity and owned records removed; original reviewer untouched",
            );
    }
    await pool.end();
    await closePlatformDatabase();
}
