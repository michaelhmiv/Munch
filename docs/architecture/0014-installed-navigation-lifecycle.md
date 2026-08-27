# Installed navigation and lifecycle

The installed Munch client keeps Android navigation behavior close to the platform defaults while making deep-link and authentication transitions deterministic.

## Route boundary

Installed navigation accepts only `/app` and descendants of `/app/`. Similar prefixes such as `/application` and `/app-store` are rejected. External HTTP(S) URLs are never converted into installed application routes.

The custom `munch:` deep-link scheme is translated through the same strict route validator. Query strings and fragments do not become installed routing state; the current web application router remains responsible for its supported route-level state.

## Cold and warm deep links

A cold launch checks Capacitor App `getLaunchUrl()` before application modules are initialized. A warm launch uses the `appUrlOpen` event. Both paths converge on the same route parser.

When a deep link arrives while the installed login page is open, Munch preserves it as the validated `return_to` destination rather than navigating away from the active login form. Successful login returns through the local `index.html` bootstrap and validates the destination again.

If an authenticated installed API request later discovers an invalid/revoked session, the current `/app` route is captured before the Keystore token is cleared so sign-in can return the user to the same surface.

## Foreground session recovery

Munch does not add a network request for every ordinary app switch. If the app has been backgrounded for at least five minutes, foregrounding performs a bearer-authenticated Better Auth `get-session` check.

An explicit unauthenticated response clears the native Keystore session and returns to login with the current app route. Network failures and server-side transient failures do not destroy a locally stored session; the next normal API request remains responsible for retrying authentication.

If Better Auth returns a refreshed bearer token, the installed client replaces the encrypted token through the native secure-session plugin.

## Android Back behavior

Munch intentionally does not register a Capacitor `backButton` listener at this layer. Capacitor's default Android behavior is retained so WebView history and system Back handling continue to work without globally intercepting the gesture. This also avoids unnecessarily opting out of standard Android predictive-back behavior.

Custom Back handling should only be introduced for a concrete native overlay/root-navigation case that cannot be represented by browser history, and should be tested separately before replacing the platform default.
