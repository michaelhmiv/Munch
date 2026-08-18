import { expect, test } from "bun:test";

test("legacy OAuth connection flow does not gate authorization on billing", async () => {
    const source = await Bun.file(
        new URL("./routes.ts", import.meta.url),
    ).text();
    expect(source).not.toContain("createCheckoutForUser");
    expect(source).not.toContain("decideEntitlement");
    expect(source).not.toContain("getSubscriptionSnapshot");
    expect(source).not.toContain("Subscription required");
    expect(source).toContain("Connected Munch account");
});
