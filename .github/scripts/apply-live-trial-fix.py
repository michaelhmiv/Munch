from pathlib import Path


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    actual = text.count(old)
    if actual != expected:
        raise SystemExit(
            f"{path}: expected {expected} occurrence(s), found {actual}: {old!r}"
        )
    file.write_text(text.replace(old, new))


def insert_before_final_describe(path: str, addition: str) -> None:
    file = Path(path)
    text = file.read_text()
    marker = "\n});\n"
    position = text.rfind(marker)
    if position < 0:
        raise SystemExit(f"{path}: final describe terminator not found")
    file.write_text(text[:position] + addition + text[position:])


replace(
    "src/billing/stripe-client.ts",
    'const MUNCH_TRIAL_DAYS = 7;',
    'const MUNCH_TRIAL_DAYS = 30;',
)
replace(
    "src/billing/stripe-client.ts",
    '    pendingOAuthSessionId?: string | null;\n}',
    '    pendingOAuthSessionId?: string | null;\n    trialDays?: number | null;\n}',
)
replace(
    "src/billing/stripe-client.ts",
    '        "subscription_data[metadata][munch_user_id]": input.userId,\n'
    '        "subscription_data[trial_period_days]": String(MUNCH_TRIAL_DAYS),\n'
    '        allow_promotion_codes: "true",\n'
    '    });',
    '        "subscription_data[metadata][munch_user_id]": input.userId,\n'
    '        payment_method_collection: "always",\n'
    '        allow_promotion_codes: "true",\n'
    '    });\n\n'
    '    const trialDays =\n'
    '        input.trialDays === undefined ? MUNCH_TRIAL_DAYS : input.trialDays;\n'
    '    if (trialDays !== null) {\n'
    '        if (!Number.isInteger(trialDays) || trialDays < 1) {\n'
    '            throw new Error("Checkout trial days must be a positive integer");\n'
    '        }\n'
    '        body.set("subscription_data[trial_period_days]", String(trialDays));\n'
    '    }',
)

replace(
    "src/billing/account-query.ts",
    '    stripeCustomerId: string | null;\n}',
    '    stripeCustomerId: string | null;\n    hasPriorSubscription: boolean;\n}',
)
replace(
    "src/billing/account-query.ts",
    '                stripe_customer_id: string | null;\n            }>',
    '                stripe_customer_id: string | null;\n'
    '                has_prior_subscription: boolean;\n'
    '            }>',
)
replace(
    "src/billing/account-query.ts",
    '                users.email,\n'
    '                customers.stripe_customer_id\n'
    '            from munch.users users',
    '                users.email,\n'
    '                customers.stripe_customer_id,\n'
    '                exists (\n'
    '                    select 1\n'
    '                    from munch.subscriptions subscriptions\n'
    '                    where subscriptions.user_id = users.id\n'
    '                ) as has_prior_subscription\n'
    '            from munch.users users',
)
replace(
    "src/billing/account-query.ts",
    '                  stripeCustomerId: row.stripe_customer_id,\n              }',
    '                  stripeCustomerId: row.stripe_customer_id,\n'
    '                  hasPriorSubscription: row.has_prior_subscription,\n'
    '              }',
)

replace(
    "src/billing/checkout-service.ts",
    '        pendingOAuthSessionId: input.pendingOAuthSessionId,\n    });',
    '        pendingOAuthSessionId: input.pendingOAuthSessionId,\n'
    '        trialDays: account.hasPriorSubscription ? null : undefined,\n'
    '    });',
)

stripe_test = Path("src/billing/stripe-client.test.ts")
text = stripe_test.read_text()
text = text.replace(
    'test("creates one recurring subscription with a seven-day trial"',
    'test("creates one recurring subscription with a 30-day trial"',
)
text = text.replace(
    'expect(params.get("subscription_data[trial_period_days]")).toBe("7");',
    'expect(params.get("subscription_data[trial_period_days]")).toBe("30");\n'
    '        expect(params.get("payment_method_collection")).toBe("always");',
)
stripe_test.write_text(text)
insert_before_final_describe(
    "src/billing/stripe-client.test.ts",
    r'''

    test("omits a repeat trial for an account that subscribed before", async () => {
        process.env.STRIPE_SECRET_KEY = "sk_test_munch";
        let encoded = "";
        globalThis.fetch = mock(async (_url, init) => {
            encoded = String(init?.body ?? "");
            return new Response(
                JSON.stringify({
                    id: "cs_test_returning",
                    url: "https://checkout.stripe.test/returning",
                    customer: "cus_returning",
                    subscription: null,
                    payment_status: "unpaid",
                    status: "open",
                    client_reference_id: "user-2",
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        }) as unknown as typeof fetch;

        await createStripeCheckoutSession({
            userId: "user-2",
            customerId: "cus_returning",
            priceId: "price_munch_monthly",
            successUrl: "https://munch.test/success",
            cancelUrl: "https://munch.test/cancel",
            trialDays: null,
        });
        const params = new URLSearchParams(encoded);
        expect(params.has("subscription_data[trial_period_days]")).toBe(false);
        expect(params.get("payment_method_collection")).toBe("always");
    });
''',
)

insert_before_final_describe(
    "src/billing/entitlements.test.ts",
    r'''

    test("denies protected access for non-entitled Stripe states", () => {
        for (const status of [
            "incomplete",
            "incomplete_expired",
            "paused",
            "canceled",
            "unpaid",
        ] as const) {
            const decision = decideEntitlement({ status }, now);
            expect(decision.allowMcp).toBe(false);
            expect(decision.canUseProtectedTools).toBe(false);
            expect(decision.canWriteNutritionData).toBe(false);
        }
    });
''',
)

for path, pairs in {
    "public/index.html": [
        ("Start 7-day free trial", "Start 30-day free trial"),
        ("<p>7-day free trial</p>", "<p>30-day free trial</p>"),
        ("https://munch-production-de3a.up.railway.app", "https://munch.business"),
    ],
    "src/portal/routes.ts": [
        (
            "One plan: $4.99/month after the seven-day trial.",
            "One plan: 30-day free trial, then $4.99/month.",
        ),
    ],
    ".env.example": [
        (
            "includes the configured seven-day trial and Customer Portal manages billing.",
            "includes a 30-day free trial for first-time subscribers and Customer Portal manages billing.",
        ),
    ],
}.items():
    file = Path(path)
    text = file.read_text()
    for old, new in pairs:
        if old not in text:
            raise SystemExit(f"{path}: missing expected text {old!r}")
        text = text.replace(old, new)
    file.write_text(text)

stale_patterns = (
    "MUNCH_TRIAL_DAYS = 7",
    'toBe("7")',
    "seven-day trial",
    "7-day free trial",
)
stale = []
for path in Path(".").rglob("*"):
    if not path.is_file() or ".git" in path.parts:
        continue
    if path.name in {"bun.lock", "package-lock.json"}:
        continue
    try:
        text = path.read_text()
    except UnicodeDecodeError:
        continue
    for pattern in stale_patterns:
        if pattern in text:
            stale.append(f"{path}: {pattern}")
if stale:
    raise SystemExit("Stale seven-day trial references remain:\n" + "\n".join(stale))
