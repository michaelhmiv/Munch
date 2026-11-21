import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dateInTz } from "../src/tz.js";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const repositorySource = readFileSync(
    new URL("../src/app/repository.ts", import.meta.url),
    "utf8",
);

function fn(name: string): string | null {
    const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
    return match ? match[0] : null;
}

/** Evaluate the History breakdown helpers from public/app.js in a fresh
 *  context. `mealLocalDay` only exists after the F6 fix; on unmodified
 *  main it is absent and mealMetricDetail falls back to slicing the UTC
 *  timestamp, which is exactly the bug under test. */
function metricDetail(
    meals: unknown,
    options: Record<string, unknown>,
    profileTimezone = "America/New_York",
): string {
    const script = [
        fn("number"),
        fn("dateInTimezone"),
        fn("formatDate"),
        fn("mealLocalDay"),
        fn("metricDetailRow"),
        fn("mealMetricDetail"),
    ]
        .filter(Boolean)
        .join("\n");
    return runInNewContext(
        `${script}; mealMetricDetail(__meals, "calories", " kcal", __options)`,
        {
            __meals: meals,
            __options: options,
            escapeHtml: (s: unknown) =>
                String(s ?? "").replaceAll('"', "&quot;"),
            state: { bootstrap: { profile: { timezone: profileTimezone } } },
        },
    ) as string;
}

test("mealMetricDetail groups a late-evening America/New_York meal under its local date, not tomorrow UTC", () => {
    // 11:30 PM EST on Nov 19 = 04:30 UTC on Nov 20.
    const meal = { logged_at: "2026-11-20T04:30:00.000Z", calories: 450 };

    // Sub-case A: no server loggedOn; the workspace timezone is passed in.
    const a = metricDetail([meal], {
        groupByDay: true,
        timezone: "America/New_York",
    });
    expect(a).toContain("November 19");
    expect(a).toContain("450 kcal");
    expect(a).not.toContain("November 20");

    // Sub-case B: server-supplied loggedOn wins outright.
    const b = metricDetail([{ ...meal, loggedOn: "2026-11-19" }], {
        groupByDay: true,
    });
    expect(b).toContain("November 19");
    expect(b).toContain("450 kcal");
    expect(b).not.toContain("November 20");
});

test("mealMetricDetail groups an early-morning Asia/Tokyo meal under its local date, not yesterday UTC", () => {
    // 16:30 UTC on Jul 15 = 01:30 JST on Jul 16.
    const meal = { logged_at: "2026-07-15T16:30:00.000Z", calories: 300 };
    const html = metricDetail([meal], {
        groupByDay: true,
        timezone: "Asia/Tokyo",
    });
    expect(html).toContain("July 16");
    expect(html).toContain("300 kcal");
    expect(html).not.toContain("July 15");
});

test("mealMetricDetail combines afternoon and 11:30 PM local meals into one local-day row", () => {
    const meals = [
        { logged_at: "2026-11-19T19:00:00.000Z", calories: 600 }, // 2:00 PM ET
        { logged_at: "2026-11-20T04:30:00.000Z", calories: 400 }, // 11:30 PM ET
    ];
    const html = metricDetail(meals, {
        groupByDay: true,
        timezone: "America/New_York",
    });
    expect(html).toContain("November 19");
    expect(html).toContain("1,000 kcal");
    expect(html).not.toContain("November 20");
});

test("server attaches loggedOn in the profile timezone and renderLog passes the workspace timezone", () => {
    expect(dateInTz("2026-11-20T04:30:00.000Z", "America/New_York")).toBe(
        "2026-11-19",
    );
    expect(dateInTz("2026-07-15T16:30:00.000Z", "Asia/Tokyo")).toBe(
        "2026-07-16",
    );
    expect(repositorySource).toContain(
        "loggedOn: dateInTz(meal.logged_at, timezone)",
    );
    expect(source).toContain("timezone: data.timezone");
});
