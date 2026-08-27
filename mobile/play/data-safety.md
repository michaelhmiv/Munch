# Google Play Data safety working declaration

This file is the code-reviewed source for the Play Console Data safety form for Android package `business.munch.app`. Re-check it whenever a new Android SDK, permission, analytics package, advertising package, health integration, or data-producing feature is added.

The declaration below describes the release currently built from this repository. Google defines **collection** as transmitting user data off device, including data sent by app-controlled WebViews. Ephemeral off-device processing must still be considered when completing the form even when it is not ultimately displayed as retained collection.

## Security and deletion summary

- Data is encrypted in transit: **Yes**. Production API traffic is HTTPS-only and Android cleartext traffic is disabled.
- Users can request data deletion: **Yes**.
- In-app deletion path: **Settings > Account > Delete account**.
- External deletion resource: `https://munch.business/delete-account`.
- Account deletion removes active account/nutrition/application data from Munch's primary database subject to the limited retention disclosed in the Privacy Policy (for example backups, fraud/accounting/legal records, and shared display-name attribution where applicable).
- Data is not sold for advertising.
- The Android app contains no advertising SDK and no third-party behavioral analytics SDK in the certified release.

## Data types to declare

### Personal info — Name

**Collected:** Yes, optional.

Examples: optional account/display name and household display name.

Purposes:
- App functionality
- Personalization
- Account management

Sharing: No for Data safety purposes when processed only by Munch/service providers under Munch's instructions. Household display names are intentionally visible to members of a household workspace as a user-initiated collaborative feature.

### Personal info — Email address

**Collected:** Yes, required for account authentication.

Purposes:
- App functionality
- Fraud prevention, security, and compliance
- Account management
- Developer communications limited to transactional/service email (for example sign-in links and household invitations)

Sharing: No for Data safety purposes when transferred to contracted service providers acting on Munch's behalf, including Resend for transactional email.

### Personal info — User IDs

**Collected:** Yes, required.

Examples: Munch account ID, opaque account identifiers used to bind Google Play purchases, session/account identifiers.

Purposes:
- App functionality
- Fraud prevention, security, and compliance
- Account management

Sharing: No for Data safety purposes when used with service providers under Munch's instructions. Google Play receives an opaque one-way account identifier for subscription association; it is not the user's raw Munch UUID or email.

### Personal info — Other info

**Collected:** Yes, optional depending on user choices.

Examples: timezone, units, user-entered nutrition goals and other account preferences that do not fit a more specific Play data type.

Purposes:
- App functionality
- Personalization

Sharing: No for Data safety purposes except service-provider processing disclosed in the Privacy Policy.

### Financial info — Purchase history

**Collected:** Yes, when the user has a paid subscription.

Examples: subscription product/provider, purchase token/order-linked state, renewal/cancellation/entitlement dates and status. Munch does **not** receive or store raw card numbers from Google Play or Stripe.

Purposes:
- App functionality
- Fraud prevention, security, and compliance
- Account management

Sharing: No beyond Google Play/Stripe and contracted infrastructure involved in the user-initiated purchase and subscription operation.

### Health and fitness — Health info

**Collected:** Yes. This is core app functionality.

Examples:
- dietary intake and meal history
- calories and nutrient values
- water intake
- body weight
- nutrition and weight goals
- recipes/meal plans where nutrition values or diet goals are associated with the account

Purposes:
- App functionality
- Personalization

Sharing: No for advertising. Selected structured Pantry/recipe/nutrition context may be processed by disclosed service providers to perform user-requested functionality. Munch does not currently request or read Health Connect data.

**Required/optional:** An account can exist without every health field, but nutrition tracking is primary Munch functionality. Mark individual manually entered fields optional where the Play form permits that distinction; do not describe the service as collecting no health data.

### Photos and videos — Photos

**Collected / transmitted off device:** Yes, optional and user initiated.

Examples: Pantry/fridge/freezer photographs and receipt photographs selected or captured by the user.

Purposes:
- App functionality

Handling:
- Munch sends the selected image to its backend for the explicit scan operation.
- The configured AI processor may receive the image transiently to extract structured Pantry or receipt candidates.
- Raw images are not written to the Munch PostgreSQL account record and are not included in account exports.
- Treat this as ephemeral processing in the Play form only if the current provider behavior and Google's current ephemeral-processing definition continue to qualify at submission time.

Sharing: Service-provider processing only as disclosed in the Privacy Policy; no advertising use.

### App activity — In-app search history

**Collected:** Search terms can be transmitted to Munch/food data providers when the user searches foods. Munch also maintains bounded food-catalog query/cache information for app functionality.

Purposes:
- App functionality

Sharing: Food lookup terms may be transmitted to USDA FoodData Central or Open Food Facts as part of the user-requested search/lookup. Treat those providers according to the current Play definition of service provider/third party at form-completion time.

### Other user-generated content

**Collected:** Yes, optional.

Examples:
- meal/food descriptions and notes
- recipes and instructions
- Pantry item names/notes
- grocery items
- meal-planning instructions/goals
- AI suggestion reports submitted by the user

Purposes:
- App functionality
- Personalization
- Fraud prevention, security, and compliance for abuse/report records where applicable

Sharing: No for advertising. Relevant content can be sent to disclosed service providers when needed to fulfill an explicit user request.

### App info and performance — Diagnostics / app interactions

The certified Android app does not include a third-party crash-reporting or behavioral analytics SDK. Munch's server maintains bounded operational/security logs such as request timing, status, and masked network information. Before checking Play boxes for Diagnostics or App interactions, confirm whether the final Play form treats the server-side operational fields in the current release as reportable app-originated data. Do not claim Firebase Analytics, Crashlytics, advertising identifiers, or device fingerprint collection because those SDKs are not present in this release.

## Data types not currently collected by the Android release

Do not declare these unless the release changes:

- Precise location
- Approximate location for a user-facing location feature
- Address
- Phone number
- Race or ethnicity
- Political or religious beliefs
- Sexual orientation
- Credit score
- Other financial information such as income/debt
- SMS/MMS
- Contacts
- Calendar
- Audio recordings
- Videos
- Installed-app inventory
- Web browsing history
- Advertising ID
- Exercise/activity/fitness data from sensors or Health Connect

IP addresses exist at the network edge as part of ordinary service/security operation. If Play's current form or Munch's runtime changes require an Approximate location disclosure due to IP-derived location, update this draft before submission. Munch does not intentionally derive a user location from IP addresses in the current application logic.

## Third-party/service-provider review checklist

Before submitting the Data safety form verify the current release against:

- Railway — hosting/database infrastructure
- Resend — transactional email
- Google Play — Android distribution and in-app subscription billing
- Stripe — website subscription billing for users who purchased on web
- USDA FoodData Central — food lookup
- Open Food Facts — food/barcode lookup
- OpenRouter and selected model providers — user-requested Pantry/receipt image extraction and Pantry meal-idea generation where enabled
- OpenAI/ChatGPT — separate from the Android app itself when the user connects/uses Munch through ChatGPT; describe only Android-app collection in the Play form while keeping the broader relationship in the Privacy Policy

## Mandatory consistency checks before Play submission

1. Compare this file with `public/privacy.html`.
2. Inspect the merged Android manifest and dependency tree for new permissions/SDKs.
3. Confirm no analytics/ads SDK was introduced.
4. Confirm raw Pantry/receipt images are still transient and not stored.
5. Confirm account deletion remains available in app and at `/delete-account`.
6. Confirm Health Connect is still unused; if introduced later, complete the additional Health Connect declarations instead of reusing this draft unchanged.
7. Complete the Play Console form from the actual choices presented by Google; this markdown is a reviewed working source, not an exported Google form.
