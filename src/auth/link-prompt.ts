import {
    isSignInProviderId,
    type SignInProviderId,
} from "./sign-in-methods.js";

/**
 * Cross-provider sign-in collision prompt (Michael's requirement,
 * 2026-11-12): when a provider identity arrives at SIGN-IN time whose
 * verified email belongs to an existing account created through a
 * different method, the sign-in must NOT silently link, duplicate, or
 * dead-end. Better Auth's implicit linking is disabled (auth.ts), so
 * the collision surfaces as its `account_not_linked` outcome on every
 * surface:
 *
 *   - Web redirect: the provider callback redirects to the sign-in
 *     page's errorCallbackURL with `?error=account_not_linked`. The
 *     connect pages point that URL at /connect/link-conflict, which
 *     explains the situation and records a short-lived pending-link
 *     cookie naming the provider that was attempted.
 *   - Native id-token sign-in: the request fails 401 with code
 *     OAUTH_LINK_ERROR; the packaged app translates it into the same
 *     guidance in plain language (mobile/runtime.js).
 *
 * The user then signs in with their ORIGINAL method — the only proof
 * of account ownership that requires no new trust — and the app shell
 * reads the pending-link cookie through the session-bound endpoints in
 * sign-in-methods-routes.ts and asks, in a dialog: "We found an
 * account with this email — add this as another sign-in method?"
 * Confirming runs the existing Amendment I session-bound link
 * (POST /api/app/sign-in-methods/:provider/link); declining dismisses
 * the prompt and leaves the account exactly as it was. No path creates
 * a second account, and no path links without the signed-in user's
 * explicit confirmation.
 */
export const ACCOUNT_NOT_LINKED_ERROR = "account_not_linked";
export const LINK_PROMPT_COOKIE_NAME = "munch_link_prompt";
export const LINK_PROMPT_TTL_SECONDS = 30 * 60;
export const LINK_CONFLICT_PATH = "/connect/link-conflict";

const PROVIDER_LABELS: Record<SignInProviderId, string> = {
    google: "Google",
    apple: "Apple",
};

export function signInProviderLabel(provider: SignInProviderId): string {
    return PROVIDER_LABELS[provider];
}

/** The errorCallbackURL the connect pages hand to a provider initiation. */
export function linkConflictErrorCallbackURL(
    provider: SignInProviderId,
): string {
    return `${LINK_CONFLICT_PATH}?provider=${provider}`;
}

function cookieAttributes(production: boolean): string {
    return `Path=/; HttpOnly; SameSite=Lax; ${production ? "Secure; " : ""}`;
}

export function buildLinkPromptCookie(
    provider: SignInProviderId,
    production: boolean,
): string {
    return `${LINK_PROMPT_COOKIE_NAME}=${provider}; Max-Age=${LINK_PROMPT_TTL_SECONDS}; ${cookieAttributes(production)}`;
}

export function buildClearLinkPromptCookie(production: boolean): string {
    return `${LINK_PROMPT_COOKIE_NAME}=; Max-Age=0; ${cookieAttributes(production)}`;
}

export function parseLinkPromptCookie(
    cookieHeader: string | undefined,
): SignInProviderId | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(";")) {
        const [name, ...rest] = part.trim().split("=");
        if (name !== LINK_PROMPT_COOKIE_NAME) continue;
        const value = rest.join("=").trim();
        return isSignInProviderId(value) ? value : null;
    }
    return null;
}

/**
 * The link-conflict page copy. Deliberately names what did NOT happen
 * (no new account, nothing changed) before asking the user to sign in
 * the original way: the pre-fix failure mode this page replaces was a
 * silent merge, and the one before that (upstream default with
 * linking disabled and no prompt) was a generic dead end.
 */
export function linkConflictCopy(provider: SignInProviderId): {
    heading: string;
    paragraphs: string[];
    primaryLabel: string;
    footnote: string;
} {
    const label = signInProviderLabel(provider);
    return {
        heading: "You already have a Munch account",
        paragraphs: [
            `The email address from ${label} matches a Munch account that signs in a different way. Nothing was changed, and no new account was created.`,
            `Sign in with the method you used before — your email link, or the other provider button. Once you're in, we'll ask whether you'd like to add ${label} as another way to sign in to the same account, so your meals, plans, and Premium stay together.`,
        ],
        primaryLabel: "Sign in with your other method",
        footnote: `If you'd rather not add ${label}, just keep signing in the way you do now — nothing changes.`,
    };
}

/** The in-app confirmation dialog copy (app shell, after sign-in). */
export function linkPromptDialogCopy(provider: SignInProviderId): {
    title: string;
    body: string;
    confirmLabel: string;
    dismissLabel: string;
} {
    const label = signInProviderLabel(provider);
    return {
        title: `Add ${label} sign-in?`,
        body: `We found an account with this email — earlier you tried to sign in with ${label}, and this account uses a different method. Add ${label} as another way to sign in to this same account? Your meals, plans, and Premium stay exactly as they are.`,
        confirmLabel: `Add ${label}`,
        dismissLabel: "Not now",
    };
}
