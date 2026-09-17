import { expect, test } from "bun:test";
import { Hono } from "hono";
import { cookRequest, resolveCookUpdateTimezone } from "./routes.js";

const app = new Hono().post("/cook", async (c) => c.json(await cookRequest(c)));

test("an unselected browser file input is not an upload failure", async () => {
    const form = new FormData();
    form.set("message", "Starting wings");
    form.append(
        "photos",
        new File([], "", { type: "application/octet-stream" }),
    );
    const res = await app.request("/cook", { method: "POST", body: form });
    const data = await res.json();
    expect(data.body.message).toBe("Starting wings");
    expect(data.photos).toEqual([]);
    expect(data.mediaFailures).toEqual([]);
});

test("an explicitly selected empty or invalid image still fails without losing the note", async () => {
    for (const bytes of [[], [1, 2, 3]]) {
        const form = new FormData();
        form.set("message", "Keep this observation");
        form.append(
            "photos",
            new File([new Uint8Array(bytes)], "wings.jpg", {
                type: "image/jpeg",
            }),
        );
        const res = await app.request("/cook", { method: "POST", body: form });
        const data = await res.json();
        expect(data.body.message).toBe("Keep this observation");
        expect(data.photos).toEqual([]);
        expect(data.mediaFailures).toHaveLength(1);
    }
});

test("cook updates fall back to the stored cook timezone when the form value is empty or invalid", () => {
    expect(resolveCookUpdateTimezone("", "America/New_York")).toBe(
        "America/New_York",
    );
    expect(
        resolveCookUpdateTimezone("not-a-timezone", "America/New_York"),
    ).toBe("America/New_York");
    expect(resolveCookUpdateTimezone(undefined, "America/New_York")).toBe(
        "America/New_York",
    );
    expect(
        resolveCookUpdateTimezone("America/Chicago", "America/New_York"),
    ).toBe("America/Chicago");
});
