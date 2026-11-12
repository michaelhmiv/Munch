import { describe, expect, test } from "bun:test";
import {
    ACCOUNT_NOT_LINKED_ERROR,
    buildClearLinkPromptCookie,
    buildLinkPromptCookie,
    linkConflictCopy,
    linkConflictErrorCallbackURL,
    linkPromptDialogCopy,
    LINK_PROMPT_COOKIE_NAME,
    LINK_PROMPT_NATIVE_HEADER,
    parseLinkPromptCookie,
    parseLinkPromptProvider,
    signInProviderLabel,
} from "./link-prompt.js";

describe("cross-provider link prompt", () => {
    test("the conflict callback URL names the attempted provider", () => {
        expect(linkConflictErrorCallbackURL("google")).toBe(
            "/connect/link-conflict?provider=google",
        );
        expect(linkConflictErrorCallbackURL("apple")).toBe(
            "/connect/link-conflict?provider=apple",
        );
        expect(ACCOUNT_NOT_LINKED_ERROR).toBe("account_not_linked");
    });

    test("the pending-link cookie round-trips and validates", () => {
        const cookie = buildLinkPromptCookie("apple", false);
        expect(cookie).toContain(`${LINK_PROMPT_COOKIE_NAME}=apple`);
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("Max-Age=1800");
        expect(cookie).not.toContain("Secure");
        expect(buildLinkPromptCookie("google", true)).toContain("Secure");
        expect(
            parseLinkPromptCookie(
                `other=1; ${LINK_PROMPT_COOKIE_NAME}=apple; theme=dark`,
            ),
        ).toBe("apple");
        expect(parseLinkPromptCookie(`${LINK_PROMPT_COOKIE_NAME}=email`)).toBe(
            null,
        );
        expect(parseLinkPromptCookie(`${LINK_PROMPT_COOKIE_NAME}=`)).toBeNull();
        expect(parseLinkPromptCookie(undefined)).toBeNull();
        expect(parseLinkPromptCookie("session=abc")).toBeNull();
    });

    test("the native prompt header names a validated provider only", () => {
        // The packaged app records the attempted provider on-device at
        // collision time and presents it under this header after the
        // original-method sign-in; anything that is not a real social
        // provider id is no prompt at all.
        expect(LINK_PROMPT_NATIVE_HEADER).toBe("x-munch-link-prompt-provider");
        expect(parseLinkPromptProvider("google")).toBe("google");
        expect(parseLinkPromptProvider(" apple ")).toBe("apple");
        expect(parseLinkPromptProvider("email")).toBeNull();
        expect(parseLinkPromptProvider("facebook")).toBeNull();
        expect(parseLinkPromptProvider("")).toBeNull();
        expect(parseLinkPromptProvider(undefined)).toBeNull();
        expect(parseLinkPromptProvider(null)).toBeNull();
    });

    test("clearing the cookie expires it immediately", () => {
        const cleared = buildClearLinkPromptCookie(false);
        expect(cleared).toContain(`${LINK_PROMPT_COOKIE_NAME}=;`);
        expect(cleared).toContain("Max-Age=0");
    });

    test("conflict copy states the account exists and nothing changed", () => {
        const copy = linkConflictCopy("google");
        expect(copy.heading).toBe("You already have a Munch account");
        expect(copy.paragraphs[0]).toContain("matches a Munch account");
        expect(copy.paragraphs[0]).toContain("no new account was created");
        expect(copy.paragraphs[1]).toContain("add Google");
        expect(copy.paragraphs[1]).toContain("Premium stay together");
        expect(copy.footnote).toContain("nothing changes");
        expect(signInProviderLabel("apple")).toBe("Apple");
    });

    test("dialog copy is Michael's prompt: found account, add method?", () => {
        const copy = linkPromptDialogCopy("apple");
        expect(copy.title).toBe("Add Apple sign-in?");
        expect(copy.body).toContain("We found an account with this email");
        expect(copy.body).toContain(
            "Add Apple as another way to sign in to this same account?",
        );
        expect(copy.confirmLabel).toBe("Add Apple");
        expect(copy.dismissLabel).toBe("Not now");
    });
});
