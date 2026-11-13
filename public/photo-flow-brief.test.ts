import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { defaultMealType as slotDefaultMealType } from "./meal-slot.js";

// Photo-flow brief (2026-11-12 evening voice call): meal-type
// time-of-day default, camera-first Log by photo, and visible
// working states across the draft review's buttons — exercised on
// the real functions lifted out of app.js, plus wiring assertions
// on the handlers themselves.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const captureNativeSource = readFileSync(
    new URL("../mobile/capture-native.js", import.meta.url),
    "utf8",
);

function extract(name: string): string {
    const match = source.match(
        new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`),
    );
    if (!match) throw new Error(`app.js function not found: ${name}`);
    return match[0];
}

function sliceBetween(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0)
        throw new Error(`markers not found: ${startMarker} / ${endMarker}`);
    return source.slice(start, end);
}

const optionsConst = source.match(
    /const MEAL_TYPE_OPTIONS = \[[\s\S]*?\];/,
)?.[0];
if (!optionsConst) throw new Error("MEAL_TYPE_OPTIONS not found in app.js");

const context: Record<string, unknown> = {
    state: { bootstrap: { profile: {} } },
};
runInNewContext(
    [
        optionsConst,
        extract("mealTypeOptionsHtml"),
        extract("setButtonBusy"),
    ].join("\n"),
    context,
);

// Reconciliation note (stack landing, 2026-11-12): the brief's
// inline defaultMealType was dropped in favor of the single
// surviving implementation in meal-slot.js (shipped by #286, bands
// corrected to the owner's ruling) — the band assertions below run
// against that real module, unchanged.
const defaultMealType = slotDefaultMealType as (
    date?: Date,
    timezone?: string,
) => string;
const mealTypeOptionsHtml = context.mealTypeOptionsHtml as (
    selected: string,
) => string;
const setButtonBusy = context.setButtonBusy as (
    button: unknown,
    busy: boolean,
    busyLabel?: string,
) => void;

describe("defaultMealType — owner time bands (America/New_York)", () => {
    const at = (iso: string) =>
        defaultMealType(new Date(iso), "America/New_York");
    test("midnight to 10:00 is breakfast", () => {
        expect(at("2026-11-12T05:00:00Z")).toBe("breakfast"); // 00:00 EST
        expect(at("2026-11-12T14:59:00Z")).toBe("breakfast"); // 09:59 EST
    });
    test("10:00 to 15:00 is lunch", () => {
        expect(at("2026-11-12T15:00:00Z")).toBe("lunch"); // 10:00 EST
        expect(at("2026-11-12T19:59:00Z")).toBe("lunch"); // 14:59 EST
    });
    test("15:00 to midnight is dinner — the owner's 18:46 case", () => {
        expect(at("2026-11-12T20:00:00Z")).toBe("dinner"); // 15:00 EST
        expect(at("2026-11-12T23:46:00Z")).toBe("dinner"); // 18:46 EST
        expect(at("2026-11-13T04:59:00Z")).toBe("dinner"); // 23:59 EST
    });
});

describe("mealTypeOptionsHtml", () => {
    test("marks exactly the requested type selected", () => {
        const html = mealTypeOptionsHtml("dinner");
        expect(html).toContain(
            '<option value="dinner" selected>Dinner</option>',
        );
        expect(html).not.toContain('<option value="lunch" selected>');
        expect(html).not.toContain('<option value="breakfast" selected>');
    });
    test("carries all four types", () => {
        const html = mealTypeOptionsHtml("breakfast");
        for (const value of ["breakfast", "lunch", "dinner", "snack"]) {
            expect(html).toContain(`value="${value}"`);
        }
    });
});

describe("meal-type pre-fill wiring", () => {
    test("no hardcoded lunch pre-fill survives anywhere in app.js", () => {
        expect(source).not.toContain('<option value="lunch" selected>');
        expect(source).not.toContain(
            '<option value="lunch" selected>Lunch</option>',
        );
    });
    test("the photo flow stamps the time-of-day default at submit", () => {
        // The capture dialog carries no meal-type select (camera-first
        // shape, #286): the slot is computed from the local time of
        // day when the photo is submitted.
        const submit = sliceBetween(
            "async function submitMealPhoto",
            "function foodTitle",
        );
        expect(submit).toContain(
            "defaultMealType(new Date(), state.bootstrap?.profile?.timezone)",
        );
        expect(submit).toContain('"meal_type"');
    });
    test("meal pre-fill selects across app.js use the time-of-day default", () => {
        // Recipe log/plan, guided planner, meal composer, draft
        // composer — every pre-fill routes through the one
        // implementation with the profile timezone.
        const calls =
            source.match(
                /defaultMealType\(new Date\(\), state\.bootstrap\?\.profile\?\.timezone\)/g,
            ) ?? [];
        expect(calls.length).toBeGreaterThanOrEqual(5);
    });
});

describe("Log by photo opens the camera", () => {
    test("the entry handler invokes the pre-mounted capture control synchronously, with no dialog first", () => {
        const action = sliceBetween(
            'if (action === "log-by-photo")',
            'if (action === "meal-photo-manual")',
        );
        expect(action).toContain("startMealPhotoCapture()");
        expect(action).not.toContain("openMealPhotoDialog");

        const start = sliceBetween(
            "function startMealPhotoCapture",
            "function openMealPhotoProcessingDialog",
        );
        expect(start).toContain('data-capture-action="camera"');
        expect(start).toContain("cameraButton.click()");
        expect(start).not.toContain("openDialog");
        expect(start).not.toContain("requestAnimationFrame");
    });

    test("the permanent entry control is hidden, delivers files to submit, and cancellation opens only the fallback sheet", () => {
        const install = sliceBetween(
            "function installMealPhotoEntryCapture",
            "function startMealPhotoCapture",
        );
        expect(install).toContain("host.hidden = true");
        expect(install).toContain('inputId: "meal-photo-entry-file"');
        expect(install).toContain("submitMealPhoto(files)");
        expect(install).toContain('"photo-capture:cancel"');
        expect(install).toContain("autoOpenCamera: false");
        expect(source).toContain(
            "installMealPhotoEntryCapture();\nrenderRoute();",
        );

        const submit = sliceBetween(
            "async function submitMealPhoto",
            "async function reestimateDraftPhotos",
        );
        expect(submit).toContain("sourceFiles");
        expect(submit).toContain("openMealPhotoProcessingDialog()");
    });

    test("the native enhancer reports a cancelled capture to the entry control", () => {
        expect(captureNativeSource).toContain(
            'PHOTO_CAPTURE_CANCEL_EVENT = "photo-capture:cancel"',
        );
        expect(captureNativeSource).toContain(
            "notifyCaptureCancelled(control)",
        );
    });

    test("the fallback sheet does not auto-open the camera unless a caller asks", () => {
        const dialog = sliceBetween(
            "async function openMealPhotoDialog",
            "async function submitMealPhoto",
        );
        expect(dialog).toContain("autoOpenCamera = true");
        expect(dialog).toContain("if (!autoOpenCamera) return;");
        expect(dialog).toContain('data-capture-action="camera"');
        expect(dialog).toContain("requestAnimationFrame");
        expect(dialog).toContain(".click()");
    });
});

describe("setButtonBusy", () => {
    function stubButton(label: string) {
        return {
            textContent: label,
            disabled: false,
            dataset: {} as Record<string, string>,
            attrs: {} as Record<string, string>,
            setAttribute(name: string, value: string) {
                this.attrs[name] = value;
            },
            removeAttribute(name: string) {
                delete this.attrs[name];
            },
        };
    }
    test("busy disables, swaps the label, and marks aria-busy", () => {
        const button = stubButton("Add to draft");
        setButtonBusy(button, true, "Adding…");
        expect(button.disabled).toBe(true);
        expect(button.textContent).toBe("Adding…");
        expect(button.attrs["aria-busy"]).toBe("true");
    });
    test("restore re-enables and brings the original label back", () => {
        const button = stubButton("Save changes");
        setButtonBusy(button, true, "Saving…");
        setButtonBusy(button, false);
        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe("Save changes");
        expect(button.attrs["aria-busy"]).toBeUndefined();
    });
    test("double-busy keeps the ORIGINAL label for the restore", () => {
        const button = stubButton("Confirm and log meal");
        setButtonBusy(button, true, "Logging meal…");
        setButtonBusy(button, true, "Logging meal…");
        setButtonBusy(button, false);
        expect(button.textContent).toBe("Confirm and log meal");
    });
});

describe("draft button-flow wiring (audit fixes)", () => {
    const handlers = sliceBetween(
        'if (action === "add-draft-text")',
        'if (action === "add-draft-manual")',
    );
    test("add-text enters the re-analyzing state before the request and clears it after", () => {
        // Simplified review (2026-11-12 approval): the working state
        // is the review's own re-analyzing render, driven by
        // mealDraftReview.addTextBusy — set before the api call and
        // cleared on both the success and error paths.
        expect(handlers).toContain("mealDraftReview.addTextBusy = text;");
        expect(handlers).toContain("mealDraftReview.addTextBusy = null;");
        expect(handlers).not.toContain("setAddTextStatus");
    });
    test("answer shows a working state", () => {
        const answer = sliceBetween(
            'if (action === "answer-meal-draft-question")',
            'if (action === "confirm-meal-draft")',
        );
        expect(answer).toContain('setButtonBusy(button, true, "Saving…")');
        expect(answer).toContain("setButtonBusy(button, false)");
    });
    test("confirm shows its saving state and the click accepts open questions as shown", () => {
        const confirm = sliceBetween(
            'if (action === "confirm-meal-draft")',
            'if (action === "cancel-meal-draft")',
        );
        expect(confirm).toContain("meal-draft-spinner-wht");
        expect(confirm).toContain("Logging…");
        // The dead-click gate is gone: no checkbox demand, no early
        // return — acceptance rides the click itself.
        expect(confirm).not.toContain("data-draft-accept-assumptions");
        expect(confirm).not.toContain(
            "Answer the open questions or accept the remaining assumptions.",
        );
        expect(confirm).toContain(
            "accept_remaining_assumptions: hasOpenQuestions",
        );
    });
    test("save-draft-all restores its button on failure", () => {
        const save = sliceBetween(
            'if (action === "save-draft-all")',
            'if (action === "remove-draft-item")',
        );
        expect(save).toContain('setButtonBusy(button, true, "Saving…")');
        expect(save).toContain("setButtonBusy(button, false)");
    });
});
