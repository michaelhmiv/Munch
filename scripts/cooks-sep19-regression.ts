#!/usr/bin/env bun
/**
 * Isolated real-PostgreSQL replay of the September 19 smoking session.
 * NEVER uses the real production Cook ID or a production database URL.
 */
import { createSmokeIdentity } from "./support/smoke-user.js";
import { COOK_EVENT_TYPES } from "../src/cooks/event-contract.js";
import {
    addCookUpdate,
    correctCookEvent,
    createCook,
    getCook,
    parseNaturalCookUpdate,
} from "../src/cooks/repository.js";
import {
    closePlatformDatabase,
    withUserDatabase,
} from "../src/platform/database.js";

if (
    !process.env.DATABASE_URL ||
    !/munch_test|localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
) {
    throw new Error(
        "September 19 regression requires an isolated CI PostgreSQL database",
    );
}
const owner = await createSmokeIdentity("cooks-sep19-regression");
const zone = "America/New_York";
const started = await createCook(owner.userId, {
    title: "September 19 ribs and loin – isolated regression",
    cookDate: "2026-09-19",
    timezone: zone,
    dishes: [
        { name: "Baby back ribs (2 racks)", equipment: "Pit Boss Austin XL" },
        {
            name: "Pork loin (5 lb, not tenderloin)",
            equipment: "Pit Boss Austin XL",
        },
    ],
    source: "mcp",
    idempotencyKey: "sep19-isolated-start",
});
const created = await getCook(owner.userId, started.cookId);
if (!created || created.dishes.length !== 2)
    throw new Error("Two dishes were not created");
const [ribs, loin] = created.dishes;
if (!ribs || !loin) throw new Error("Both dish IDs are required");

const submissions = [
    {
        key: "sep19-prep",
        message:
            "Thursday-night marinating reported; Friday 5 PM dry rub separately clarified.",
        events: [
            {
                eventType: "marinate" as const,
                dishId: loin.id,
                timePrecision: "unknown" as const,
                relativePhrase: "Thursday night, September 17",
                note: "Marinating reported; exact time and ingredients unknown.",
            },
            {
                eventType: "season" as const,
                dishId: loin.id,
                eventAt: "2026-09-18T21:00:00.000Z",
                timePrecision: "approximate" as const,
                relativePhrase: "Friday around 5 PM",
                note: "Dry rub applied, ingredients unknown.",
            },
            {
                eventType: "season" as const,
                dishId: ribs.id,
                eventAt: "2026-09-19T18:00:00.000Z",
                timePrecision: "approximate" as const,
                note: "Seasoning began around 2 PM.",
            },
            {
                eventType: "rest" as const,
                dishId: ribs.id,
                eventAt: "2026-09-19T18:00:00.000Z",
                timePrecision: "approximate" as const,
                note: "Pre-smoker seasoning rest approximately 90 minutes; not a post-cook rest.",
            },
        ],
    },
    {
        key: "sep19-food-on",
        message:
            "Both racks went on at 3:30 at 250°F. Loin went on shortly after, precise time unknown.",
        events: [
            {
                eventType: "food_on" as const,
                dishId: ribs.id,
                eventAt: "2026-09-19T19:30:00.000Z",
                timePrecision: "exact" as const,
                setpointTemperature: 250,
                setpointUnit: "F" as const,
            },
            {
                eventType: "food_on" as const,
                dishId: loin.id,
                timePrecision: "unknown" as const,
                relativePhrase: "shortly after 3:30 PM",
                note: "Exact smoker-placement time not confirmed.",
            },
        ],
    },
    {
        key: "sep19-first-temps",
        message: "Loin 85°F and ribs 110°F around 4:18 PM.",
        events: [
            {
                eventType: "temperature_change" as const,
                dishId: loin.id,
                eventAt: "2026-09-19T20:18:00.000Z",
                timePrecision: "approximate" as const,
                internalTemperature: 85,
                internalUnit: "F" as const,
            },
            {
                eventType: "temperature_change" as const,
                dishId: ribs.id,
                eventAt: "2026-09-19T20:18:00.000Z",
                timePrecision: "approximate" as const,
                internalTemperature: 110,
                internalUnit: "F" as const,
            },
        ],
    },
    {
        key: "sep19-spritz",
        message: "I just sprayed both with Bragg honey apple cider vinegar.",
        events: [
            {
                eventType: "spritz" as const,
                dishIds: [ribs.id, loin.id],
                eventAt: "2026-09-19T21:00:00.000Z",
                timePrecision: "approximate" as const,
                note: "Bragg honey apple cider vinegar applied to both dishes.",
            },
        ],
    },
    {
        key: "sep19-later-temps",
        message: "Loin 122°F with little bark; ribs 134°F around 5:15 PM.",
        events: [
            {
                eventType: "temperature_change" as const,
                dishId: loin.id,
                eventAt: "2026-09-19T21:15:00.000Z",
                timePrecision: "approximate" as const,
                internalTemperature: 122,
                internalUnit: "F" as const,
            },
            {
                eventType: "temperature_change" as const,
                dishId: ribs.id,
                eventAt: "2026-09-19T21:15:00.000Z",
                timePrecision: "approximate" as const,
                internalTemperature: 134,
                internalUnit: "F" as const,
            },
            {
                eventType: "note" as const,
                dishId: loin.id,
                eventAt: "2026-09-19T21:15:00.000Z",
                timePrecision: "approximate" as const,
                note: "Little visible bark.",
            },
        ],
    },
    {
        key: "sep19-finish",
        message:
            "Ribs 172°F later; loin removed around 6:22 PM. Thin end later reported in the 160s.",
        events: [
            {
                eventType: "temperature_change" as const,
                dishId: ribs.id,
                timePrecision: "unknown" as const,
                internalTemperature: 172,
                internalUnit: "F" as const,
                note: "Measurement occurred later; exact time unconfirmed.",
            },
            {
                eventType: "remove" as const,
                dishId: loin.id,
                eventAt: "2026-09-19T22:22:00.000Z",
                timePrecision: "approximate" as const,
            },
            {
                eventType: "note" as const,
                dishId: loin.id,
                timePrecision: "unknown" as const,
                note: "One end reported in the 160s; no exact reading or thick-center temperature supplied.",
            },
        ],
    },
];
for (const submission of submissions) {
    const update = await addCookUpdate(owner.userId, started.cookId, {
        source: "mcp",
        message: submission.message,
        timezone: zone,
        submittedAt: "2026-09-19T22:36:16.000Z",
        events: submission.events,
        idempotencyKey: submission.key,
    });
    if (update.eventIds.length !== submission.events.length)
        throw new Error(`Failed to persist ${submission.key}`);
    const retry = await addCookUpdate(owner.userId, started.cookId, {
        source: "mcp",
        message: submission.message,
        timezone: zone,
        submittedAt: "2026-09-19T22:36:16.000Z",
        events: submission.events,
        idempotencyKey: submission.key,
    });
    if (JSON.stringify([...retry.eventIds].sort()) !== JSON.stringify([...update.eventIds].sort()))
        throw new Error("Retry duplicated a structured observation");
}
const actual = await getCook(owner.userId, started.cookId);
if (!actual) throw new Error("Read-back lost the Cook");
const expectedCount = submissions.reduce(
    (sum, item) => sum + item.events.length,
    0,
);
if (
    actual.events.length !== expectedCount ||
    actual.updates.length !== submissions.length
)
    throw new Error("Original history or event count changed after retries");
const shared = actual.events.find((event) => event.event_type === "spritz");
if (
    !shared ||
    shared.dish_id !== null ||
    JSON.stringify([...shared.dish_ids].sort()) !==
        JSON.stringify([ribs.id, loin.id].sort())
)
    throw new Error("One shared spritz must retain both dish associations");
const rub = actual.events.find(
    (event) => event.event_type === "season" && event.dish_id === loin.id,
);
const marinade = actual.events.find((event) => event.event_type === "marinate");
if (
    !rub ||
    rub.event_at !== "2026-09-18T21:00:00.000Z" ||
    !marinade ||
    marinade.event_at !== null ||
    marinade.relative_phrase !== "Thursday night, September 17"
)
    throw new Error(
        "Historical occurrence times or uncertainty were corrupted",
    );
if (
    actual.events.some(
        (event) =>
            event.event_type === "wrap" ||
            event.event_type === "equipment_adjustment" ||
            (event.event_type === "rest" && event.dish_id === loin.id),
    )
)
    throw new Error("Proposed steps were saved as completed");
const temp = actual.events.find(
    (event) => event.dish_id === loin.id && event.internal_temperature === 122,
);
if (!temp) throw new Error("Loin temperature is missing");
const corrected = await correctCookEvent(
    owner.userId,
    started.cookId,
    temp.id,
    {
        eventType: "temperature_change",
        timePrecision: "approximate",
        eventAt: "2026-09-19T21:16:00.000Z",
    },
    temp.version,
);
if (corrected.dish_id !== loin.id || corrected.internal_temperature !== 122)
    throw new Error(
        "Time-only correction erased the dish or measured temperature",
    );
const audit = await withUserDatabase(
    owner.userId,
    async (tx) =>
        tx<
            Array<{
                prior_version: number;
                snapshot: { event_at: string; dish_id: string };
            }>
        >`
        select prior_version, snapshot from munch.cook_event_revisions
        where event_id = ${temp.id}
    `,
);
if (
    audit.length !== 1 ||
    audit[0]?.snapshot.event_at !== temp.event_at ||
    audit[0]?.snapshot.dish_id !== loin.id
)
    throw new Error("Correction failed to preserve its original revision");
const second = await createCook(owner.userId, {
    title: "Cross-Cook association probe",
    cookDate: "2026-09-19",
    dishes: [{ name: "Other dish" }],
    source: "mcp",
    idempotencyKey: "sep19-cross-cook",
});
let rejected = false;
try {
    await addCookUpdate(owner.userId, second.cookId, {
        source: "mcp",
        message: "Invalid link probe",
        events: [{ eventType: "spritz", dishIds: [ribs.id] }],
        idempotencyKey: "sep19-invalid-link",
    });
} catch {
    rejected = true;
}
const probe = await getCook(owner.userId, second.cookId);
if (
    !rejected ||
    !probe ||
    probe.updates.length !== 0 ||
    probe.events.length !== 0
)
    throw new Error("Cross-Cook event write must be rejected atomically");

const allTypes = await addCookUpdate(owner.userId, second.cookId, {
    source: "mcp",
    message: "Exercise the real database event constraint",
    events: COOK_EVENT_TYPES.map((eventType, i) => ({
        eventType,
        eventAt: new Date(Date.UTC(2026, 8, 19, 12, i)).toISOString(),
        note: "Canonical event-type persistence probe.",
    })),
    idempotencyKey: "sep19-event-contract",
});
const typesBack = await getCook(owner.userId, second.cookId);
if (
    allTypes.eventIds.length !== COOK_EVENT_TYPES.length ||
    typesBack?.events.length !== COOK_EVENT_TYPES.length
)
    throw new Error(
        "MCP-advertised event types and PostgreSQL constraint disagree",
    );
for (const phrase of [
    "I haven't wrapped it yet.",
    "I might spray it later.",
    "Should I raise the temperature?",
    "No post-cook rest has been confirmed.",
    "The exact time it was put on smoker is NOT confirmed.",
]) {
    if (
        parseNaturalCookUpdate(phrase).events.some(
            (event) => event.eventType !== "note",
        )
    )
        throw new Error(`False completed action inferred from: ${phrase}`);
}
await closePlatformDatabase();
console.log(
    "September 19 isolated PostgreSQL regression passed: real event contract, replay, read-back, shared dishes, retries, corrections, audit, and cross-Cook rollback.",
);
