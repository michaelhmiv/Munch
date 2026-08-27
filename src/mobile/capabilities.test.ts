import { describe, expect, test } from "bun:test";
import {
    assertMobileCapabilityContracts,
    MOBILE_CAPABILITY_IDS,
    MOBILE_CAPABILITY_STATUS,
} from "./capabilities.js";

describe("mobile capability parity", () => {
    test("every canonical capability has an Android/iOS declaration", () => {
        expect(assertMobileCapabilityContracts()).toEqual([]);
    });

    test("initial mobile rollout keeps every declared capability visible", () => {
        expect(new Set(MOBILE_CAPABILITY_IDS).size).toBe(MOBILE_CAPABILITY_IDS.length);
        for (const id of MOBILE_CAPABILITY_IDS) {
            expect(MOBILE_CAPABILITY_STATUS[id]).toBeDefined();
            expect(MOBILE_CAPABILITY_STATUS[id].android).toBe("planned");
            expect(MOBILE_CAPABILITY_STATUS[id].ios).toBe("planned");
        }
    });
});
