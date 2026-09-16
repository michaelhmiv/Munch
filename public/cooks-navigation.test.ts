import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { handleAccountAction } from "./app-account.js";

test("Pantry leaves the SPA; Cooks remains an SPA route", () => {
    const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    const fn = source.match(/function navigate\(href\) \{[\s\S]*?\n\}/)![0];
    let renders = 0;
    const pushed: string[] = [];
    const context = {
        URL,
        location: { origin: "https://munch.business", href: "" },
        history: {
            pushState: (_a: unknown, _b: unknown, p: string) => pushed.push(p),
        },
        renderRoute: () => renders++,
    };
    runInNewContext(fn + '; navigate("/app/pantry");', context);
    expect(context.location.href).toBe("/app/pantry");
    expect(pushed).toHaveLength(0);
    expect(renders).toBe(0);
    runInNewContext(fn + '; navigate("/app/cooks");', context);
    expect(pushed).toEqual(["/app/cooks"]);
    expect(renders).toBe(1);
});

test("account export calls the authenticated canonical endpoint", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
    const destination = { href: "" };
    Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: destination,
    });
    try {
        const calls: unknown[] = [];
        const result = await handleAccountAction(
            { dataset: { action: "export-account" } },
            {
                api: async (path: string, options: unknown) => {
                    calls.push({ path, options });
                    return {
                        url: "https://munch.example/exports/download?token=test-fixture",
                    };
                },
            },
        );
        expect(result).toBe(true);
        expect(calls).toEqual([
            {
                path: "/api/app/export",
                options: { method: "POST", body: "{}", keepPrevious: true },
            },
        ]);
        expect(destination.href).toBe(
            "https://munch.example/exports/download?token=test-fixture",
        );
    } finally {
        if (previous) Object.defineProperty(globalThis, "location", previous);
        else Reflect.deleteProperty(globalThis, "location");
    }
});
