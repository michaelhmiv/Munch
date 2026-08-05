from pathlib import Path

connect_path = Path("src/auth/connect-routes.ts")
connect = connect_path.read_text()

anchor = '''function connectionError(c: Context, stage: string, error?: unknown) {
    console.error("Better Auth connection stage failed", {
        stage,
        errorName: error instanceof Error ? error.name : "unknown",
    });
    return c.redirect("/connect/error", 303);
}
'''
helper = anchor + '''
async function betterAuthJsonPost(
    c: Context,
    path: string,
    body: Record<string, unknown>,
): Promise<Response> {
    const headers = new Headers(c.req.raw.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");

    return getMunchBetterAuth().handler(
        new Request(new URL(path, c.req.url), {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        }),
    );
}
'''
if anchor not in connect:
    raise SystemExit("connectionError anchor not found")
connect = connect.replace(anchor, helper, 1)

old_magic = '''        try {
            await getMunchBetterAuth().api.signInMagicLink({
                headers: c.req.raw.headers,
                body: {
                    email,
                    name: "Munch user",
                    callbackURL: returnTo,
                    newUserCallbackURL: returnTo,
                    errorCallbackURL: "/connect/error",
                    ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
                },
            });
        } catch (error) {
'''
new_magic = '''        try {
            const response = await betterAuthJsonPost(
                c,
                "/api/auth/sign-in/magic-link",
                {
                    email,
                    name: "Munch user",
                    callbackURL: returnTo,
                    newUserCallbackURL: returnTo,
                    errorCallbackURL: "/connect/error",
                    ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
                },
            );
            if (!response.ok) {
                throw new Error(`magic_link_request_failed_${response.status}`);
            }
        } catch (error) {
'''
if old_magic not in connect:
    raise SystemExit("magic-link block not found")
connect = connect.replace(old_magic, new_magic, 1)

old_consent = '''        try {
            return await auth.api.oauth2Consent({
                headers: c.req.raw.headers,
                body: {
                    accept,
                    scope,
                    oauth_query: oauthQuery,
                },
                asResponse: true,
            });
        } catch (error) {
            return connectionError(c, "oauth2_consent", error);
        }
'''
new_consent = '''        try {
            return await betterAuthJsonPost(
                c,
                "/api/auth/oauth2/consent",
                {
                    accept,
                    scope,
                    oauth_query: oauthQuery,
                },
            );
        } catch (error) {
            return connectionError(c, "oauth2_consent", error);
        }
'''
if old_consent not in connect:
    raise SystemExit("consent block not found")
connect_path.write_text(connect.replace(old_consent, new_consent, 1))

ci_path = Path(".github/workflows/ci.yml")
ci = ci_path.read_text()
anchor = '''      - name: Exercise Better Auth dynamic client registration
        env:
          NODE_ENV: test
          MUNCH_AUTH_BACKEND: better_auth
          BETTER_AUTH_SECRET: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
          RESEND_API_KEY: re_test_schema
          MUNCH_EMAIL_FROM: Munch <support@munch.example>
        run: bun scripts/better-auth-oauth-http-smoke.ts
'''
addition = anchor + '''
      - name: Exercise Better Auth browser authorization flow
        env:
          NODE_ENV: test
          MUNCH_AUTH_BACKEND: better_auth
          BETTER_AUTH_SECRET: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
          RESEND_API_KEY: re_test_schema
          MUNCH_EMAIL_FROM: Munch <support@munch.example>
        run: bun scripts/better-auth-browser-oauth-smoke.ts
'''
if anchor not in ci:
    raise SystemExit("CI Better Auth registration step not found")
ci_path.write_text(ci.replace(anchor, addition, 1))
